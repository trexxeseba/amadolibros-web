import {readFile,writeFile} from 'node:fs/promises';
import {createCipheriv,randomBytes,publicEncrypt,constants} from 'node:crypto';
import {decodeReadiness} from './publish-card-readiness.mjs';
const account=process.env.CLOUDFLARE_ACCOUNT_ID,token=process.env.CLOUDFLARE_ADMIN_API_TOKEN;
if(!account||!token)throw Error('configured-access-unavailable');
const results=[];
async function request(name,path,query){
 const r=await fetch('https://api.cloudflare.com/client/v4'+path,{method:query?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(query?{body:JSON.stringify({query})}:{}),signal:AbortSignal.timeout(45000)});
 const data=await r.json();results.push({name,http:r.status,data});console.log(JSON.stringify({endpoint:name,http:r.status,errors:Boolean(data.errors?.length)}));return data;
}
const dir=process.env.CARD_READINESS_ARTIFACT;
const index=JSON.parse(decodeReadiness(JSON.parse(await readFile(dir+'/card-readiness.encrypted.json')),JSON.parse(await readFile(dir+'/card-readiness-summary.json')),process.env.CLOUDFLARE_API_TOKEN));
results.push({name:'verified_published_readiness_artifact',data:index});
await request('billable_usage','/accounts/'+account+'/billable-usage?from=2026-09-15&to=2026-10-18');
await request('pages_projects','/accounts/'+account+'/pages/projects');
const schema=await request('graphql_schema','/graphql','{__schema{types{name fields{name type{kind name ofType{kind name ofType{kind name}}}}}}}');
const types=schema.data?.__schema?.types||[];
const unwrap=t=>!t?undefined:t.name||unwrap(t.ofType);
const accountType=types.find(t=>t.fields?.some(f=>f.name==='workersInvocationsAdaptive'));
const node=types.find(t=>t.name===unwrap(accountType?.fields.find(f=>f.name==='workersInvocationsAdaptive')?.type));
const fieldType=n=>types.find(t=>t.name===unwrap(node?.fields.find(f=>f.name===n)?.type));
const sums=fieldType('sum')?.fields?.map(f=>f.name)||[];
const dims=fieldType('dimensions')?.fields?.map(f=>f.name)||[];
results.push({name:'workers_available_metrics',data:{node:node?.name,sum:sums,dimensions:dims}});
if(sums.includes('requests')&&dims.includes('scriptName')){
 const selected=['requests','errors','subrequests','cpuTime','cpuTimeUs'].filter(f=>sums.includes(f));
 const end=new Date(),date=new Date('2026-09-15T00:00:00Z');
 while(date<end){
  const next=new Date(Math.min(+date+86400000,+end));
  const query=`{viewer{accounts(filter:{accountTag:"${account}"}){workersInvocationsAdaptive(limit:10000,filter:{datetime_geq:"${date.toISOString()}",datetime_lt:"${next.toISOString()}"}){dimensions{scriptName}sum{${selected.join(' ')}}}}}}`;
  await request('workers_daily:'+date.toISOString().slice(0,10),'/graphql',query);
  date.setUTCDate(date.getUTCDate()+1);
 }
}
const report={schema:'amado-cloudflare-phase-a2-readonly-v1',checked_at:new Date().toISOString(),cloudflare_writes:0,image_requests:0,results};
const key=randomBytes(32),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(report.schema));
const data=Buffer.concat([cipher.update(JSON.stringify(report)),cipher.final()]);
await writeFile(process.env.CF_USAGE_OUTPUT,JSON.stringify({schema:report.schema,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),key:publicEncrypt({key:await readFile('scripts/images/cf-usage-audit-public.pem'),padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},key).toString('base64'),data:data.toString('base64')}));
