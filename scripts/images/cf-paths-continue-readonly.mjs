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


const zones=await get('zone','/zones?name=amadolibros.com');
const zone=zones?.find(z=>z.name==='amadolibros.com'&&z.account?.id===account);
if(!zone)throw Error('zone-account-mismatch');
let cursor=process.env.CF_PATH_CURSOR;
for(let page=0;page<10;page++){
 const filter={datetime_geq:'2026-10-17T00:00:00Z',datetime_lt:'2026-10-17T18:34:08Z',clientRequestPath_like:'/cdn-cgi/image/%',requestSource:'eyeball',clientRequestPath_gt:cursor};
 const filterText='{'+Object.entries(filter).map(([k,v])=>k+':'+JSON.stringify(v)).join(',')+'}';
 const query=`{viewer{zones(filter:{zoneTag:"${zone.id}"}){paths:httpRequestsAdaptiveGroups(limit:10000,orderBy:[clientRequestPath_ASC],filter:${filterText}){count dimensions{clientRequestPath}}}}}`;
 const response=await fetch('https://api.cloudflare.com/client/v4/graphql',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({query}),signal:AbortSignal.timeout(60000)});
 const data=await response.json();
 const rows=data.data?.viewer?.zones?.[0]?.paths;
 results.push({name:'paths_page',after:cursor,http:response.status,data});
 console.log(JSON.stringify({page:page+1,http:response.status,groups:rows?.length,graphql_errors:Boolean(data.errors?.length)}));
 if(!rows||data.errors?.length||rows.length<10000)break;
 const next=rows.at(-1).dimensions.clientRequestPath;
 if(next<=cursor)throw Error('cursor-not-advancing');
 cursor=next;
}
const schema='amado-cloudflare-phase-a-readonly-v1',report={schema,checked_at:new Date().toISOString(),cloudflare_writes:0,image_requests:0,results};
const key=randomBytes(32),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(schema));
const data=Buffer.concat([cipher.update(JSON.stringify(report),'utf8'),cipher.final()]);
const publicKey=await readFile('scripts/images/cf-usage-audit-public.pem');
await writeFile(process.env.CF_USAGE_OUTPUT,JSON.stringify({schema,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),key:publicEncrypt({key:publicKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},key).toString('base64'),data:data.toString('base64')}));
