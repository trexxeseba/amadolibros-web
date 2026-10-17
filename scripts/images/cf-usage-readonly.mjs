import {readFile,writeFile} from 'node:fs/promises';
import {createCipheriv,randomBytes,publicEncrypt,constants,createHash} from 'node:crypto';
const account=process.env.CLOUDFLARE_ACCOUNT_ID,token=process.env.CLOUDFLARE_AUDIT_TOKEN;
if(!/^[a-f0-9]{32}$/.test(account||'')||!token)throw Error('configured-access-unavailable');
const paths=[['billable_usage','billable-usage'],['billing_periods','billable-usage/info'],['subscriptions','subscriptions'],['images_storage_stats','images/v1/stats']];
const results=[];
for(const [name,suffix] of process.env.CF_AUDIT_PHASE==='traffic'?[]:paths){
 try{
  const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/${suffix}`,{method:'GET',headers:{authorization:'Bearer '+token},redirect:'manual',signal:AbortSignal.timeout(30000)});
  const text=await response.text();
  if(text.includes(token))throw Error('response-contained-credential');
  let data;try{data=JSON.parse(text);}catch{data={non_json:true};}
  results.push({name,endpoint:`GET /accounts/{account_id}/${suffix}`,http:response.status,data});
  console.log(JSON.stringify({endpoint:name,http:response.status,api_success:data.success ?? null}));
 }catch{results.push({name,transport_error:true});console.log(JSON.stringify({endpoint:name,transport_error:true}));}
}
if(process.env.CF_AUDIT_PHASE==='traffic'){
 const zoneResponse=await fetch('https://api.cloudflare.com/client/v4/zones?name=amadolibros.com',{headers:{authorization:'Bearer '+token},redirect:'manual',signal:AbortSignal.timeout(30000)});
 const zones=await zoneResponse.json();
 const zone=zones.result?.find(z=>z.name==='amadolibros.com'&&z.account?.id===account);
 results.push({name:'zone_access',endpoint:'GET /zones?name=amadolibros.com',http:zoneResponse.status,account_matched:Boolean(zone),errors:zones.errors});
 console.log(JSON.stringify({endpoint:'zone_access',http:zoneResponse.status,account_matched:Boolean(zone)}));
 if(zone){
  const now=new Date(),from=new Date(now);from.setUTCHours(0,0,0,0);
  const filter=`{datetime_geq:${JSON.stringify(from.toISOString())},datetime_leq:${JSON.stringify(now.toISOString())},clientRequestPath_like:"/cdn-cgi/image/%",requestSource:"eyeball"}`;
  const query=`{viewer{zones(filter:{zoneTag:"${zone.id}"}){paths:httpRequestsAdaptiveGroups(limit:200,orderBy:[count_DESC],filter:${filter}){count dimensions{clientRequestPath edgeResponseStatus}} agents:httpRequestsAdaptiveGroups(limit:100,orderBy:[count_DESC],filter:${filter}){count dimensions{userAgent}}}}}`;
  const response=await fetch('https://api.cloudflare.com/client/v4/graphql',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({query}),redirect:'manual',signal:AbortSignal.timeout(45000)});
  const data=await response.json();results.push({name:'transformation_traffic_today',endpoint:'POST /graphql (query only)',http:response.status,from:from.toISOString(),to:now.toISOString(),data});
  console.log(JSON.stringify({endpoint:'transformation_traffic_today',http:response.status,graphql_errors:Boolean(data.errors?.length)}));
 }
}
const report={schema:'amado-cloudflare-usage-readonly-v1',checked_at:new Date().toISOString(),account_sha256:createHash('sha256').update(account).digest('hex'),cloudflare_writes:0,image_requests:0,results};
const key=randomBytes(32),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
cipher.setAAD(Buffer.from(report.schema));
const encrypted=Buffer.concat([cipher.update(JSON.stringify(report),'utf8'),cipher.final()]);
const publicKey=await readFile('scripts/images/cf-usage-audit-public.pem');
const envelope={schema:report.schema,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),key:publicEncrypt({key:publicKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},key).toString('base64'),data:encrypted.toString('base64')};
await writeFile(process.env.CF_USAGE_OUTPUT,JSON.stringify(envelope));
