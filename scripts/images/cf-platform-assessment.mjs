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
const projects=await get('pages_projects',root+'/pages/projects',rows=>rows.map(p=>({name:p.name,subdomain:p.subdomain,domains:p.domains,production_branch:p.production_branch,source_type:p.source?.type,configs:Object.fromEntries(Object.entries(p.deployment_configs||{}).map(([env,c])=>[env,{binding_groups:Object.keys(c).filter(k=>/bindings|namespaces|databases|buckets/.test(k)),env_keys:Object.keys(c.env_vars||{}),kv:Object.keys(c.kv_namespaces||{}),d1:Object.keys(c.d1_databases||{}),r2:Object.keys(c.r2_buckets||{}),services:Object.keys(c.services||{}),limits:c.limits,placement:c.placement,compatibility_date:c.compatibility_date}]))})));
await get('workers_scripts',root+'/workers/scripts',rows=>rows.map(x=>({id:x.id,created_on:x.created_on,modified_on:x.modified_on})));
await get('r2_buckets',root+'/r2/buckets');
await get('d1_databases',root+'/d1/database?per_page=100',rows=>rows.map(x=>({name:x.name,uuid:x.uuid,num_tables:x.num_tables,file_size:x.file_size})));
await get('kv_namespaces',root+'/storage/kv/namespaces?per_page=100');
await get('queues',root+'/queues?per_page=100');
await get('worker_sync_settings',root+'/workers/scripts/amadolibros-sync/settings',s=>({bindings:(s.bindings||[]).map(b=>({name:b.name,type:b.type})),limits:s.limits,observability:s.observability,logpush:s.logpush,placement:s.placement}));
const zones=await get('zone', '/zones?name=amadolibros.com',rows=>rows.map(z=>({id:z.id,name:z.name,account_matched:z.account?.id===account,plan:z.plan?.name,status:z.status})));
const zone=zones?.find(z=>z.name==='amadolibros.com'&&z.account?.id===account);
if(zone){
 await get('zone_settings','/zones/'+zone.id+'/settings');
 await get('zone_rulesets','/zones/'+zone.id+'/rulesets');
}
const schema='amado-cloudflare-platform-readonly-v1',report={schema,checked_at:new Date().toISOString(),cloudflare_writes:0,image_requests:0,results};
const key=randomBytes(32),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(schema));
const data=Buffer.concat([cipher.update(JSON.stringify(report),'utf8'),cipher.final()]);
const publicKey=await readFile('scripts/images/cf-usage-audit-public.pem');
await writeFile(process.env.CF_USAGE_OUTPUT,JSON.stringify({schema,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),key:publicEncrypt({key:publicKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},key).toString('base64'),data:data.toString('base64')}));
