import {readFile,writeFile} from 'node:fs/promises';
import {createCipheriv,randomBytes,publicEncrypt,constants} from 'node:crypto';
const account=process.env.CLOUDFLARE_ACCOUNT_ID,token=process.env.CLOUDFLARE_ADMIN_API_TOKEN;
if(!account||!token)throw Error('configured-access-unavailable');
const results=[];
async function get(name,path,select=x=>x){
 try{
  const response=await fetch('https://api.cloudflare.com/client/v4'+path,{headers:{authorization:'Bearer '+token},redirect:'manual',signal:AbortSignal.timeout(30000)});
  const data=await response.json();
  results.push({name,http:response.status,success:data.success,result_info:data.result_info,data:data.success?select(data.result):null,errors:data.errors});
  console.log(JSON.stringify({endpoint:name,http:response.status,success:data.success}));
  return data.success?data.result:null;
 }catch{results.push({name,transport_error:true});}
}
const root='/accounts/'+account;

await get('notification_policies',root+'/alerting/v3/policies');
await get('available_alerts',root+'/alerting/v3/available_alerts');
await get('billable_usage',root+'/billable-usage?from=2026-09-15&to=2026-10-18');
await get('billing_periods',root+'/billable-usage/info');
const buckets=await get('buckets',root+'/r2/buckets');
for(const b of buckets?.buckets||[])await get('managed_domain:'+b.name,root+'/r2/buckets/'+encodeURIComponent(b.name)+'/domains/managed');
const scripts=await get('worker_names',root+'/workers/scripts',rows=>rows.map(r=>({id:r.id})));
for(const s of scripts||[]){
 try{
  const response=await fetch('https://api.cloudflare.com/client/v4'+root+'/workers/scripts/'+encodeURIComponent(s.id),{headers:{authorization:'Bearer '+token},redirect:'manual',signal:AbortSignal.timeout(30000)});
  const text=await response.text();
  const urls=[...new Set((text.match(/https?:\/\/pub-[a-zA-Z0-9-]+\.r2\.dev(?:\/[a-zA-Z0-9_./-]*)?/g)||[]))];
  results.push({name:'deployed_worker_r2dev:'+s.id,http:response.status,source_scanned:response.ok,source_bytes:text.length,r2dev_urls:urls});
  console.log(JSON.stringify({endpoint:'worker_source_scan',http:response.status,source_scanned:response.ok}));
 }catch{results.push({name:'deployed_worker_r2dev:'+s.id,transport_error:true});}
}
const zones=await get('zone','/zones?name=amadolibros.com',rows=>rows.map(z=>({id:z.id,matched:z.account?.id===account})));
const zone=zones?.find(z=>z.name==='amadolibros.com'&&z.account?.id===account);
if(zone){
 const query=`{viewer{zones(filter:{zoneTag:"${zone.id}"}){paths:httpRequestsAdaptiveGroups(limit:10000,orderBy:[clientRequestPath_ASC],filter:{datetime_geq:"2026-10-17T00:00:00Z",datetime_lt:"2026-10-17T18:34:08Z",clientRequestPath_like:"/cdn-cgi/image/%",requestSource:"eyeball"}){count dimensions{clientRequestPath}}}}}`;
 const response=await fetch('https://api.cloudflare.com/client/v4/graphql',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({query}),signal:AbortSignal.timeout(60000)});
 results.push({name:'pre_containment_path_groups',http:response.status,from:'2026-10-17T00:00:00Z',to_exclusive:'2026-10-17T18:34:08Z',limit:10000,data:await response.json()});
 console.log(JSON.stringify({endpoint:'pre_containment_path_groups',http:response.status}));
}
const schema='amado-cloudflare-phase-a-readonly-v1',report={schema,checked_at:new Date().toISOString(),cloudflare_writes:0,image_requests:0,results};
const key=randomBytes(32),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(schema));
const data=Buffer.concat([cipher.update(JSON.stringify(report),'utf8'),cipher.final()]);
const publicKey=await readFile('scripts/images/cf-usage-audit-public.pem');
await writeFile(process.env.CF_USAGE_OUTPUT,JSON.stringify({schema,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),key:publicEncrypt({key:publicKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},key).toString('base64'),data:data.toString('base64')}));
