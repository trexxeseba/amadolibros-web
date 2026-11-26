// Read-only Google diagnostics. Reports are encrypted before upload.
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {randomBytes,createCipheriv,publicEncrypt,constants} from 'node:crypto';
import {main as merchantMain} from '../commerce/merchant-readonly-audit.mjs';
const report={at:new Date().toISOString(),period:{startDate:'2026-10-27',endDate:'2026-11-25'},reads:[],reports:[]};
const token=process.env.READONLY_GOOGLE_TOKEN,p=process.env.GA4_PROPERTY_ID;
if(!token||!/^\d+$/.test(p||''))throw Error('Read-only Google access is missing');
async function read(url,body){
 if(!/^https:\/\/(?:analyticsdata|analyticsadmin)\.googleapis\.com\//.test(url))throw Error('Unexpected host');
 const response=await fetch(url,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});
 const text=await response.text();let data;try{data=JSON.parse(text)}catch{data={message:text.slice(0,1000)}}
 return{status:response.status,ok:response.ok,data};
}
for(const endpoint of ['', '/keyEvents?pageSize=200','/googleAdsLinks?pageSize=200','/customDimensions?pageSize=200']){
 const r=await read('https://analyticsadmin.googleapis.com/v1beta/properties/'+p+endpoint);report.reads.push({endpoint,...r});console.log(JSON.stringify({read:endpoint||'property',status:r.status}));
}
const metadata=await read('https://analyticsdata.googleapis.com/v1beta/properties/'+p+'/metadata');
const dims=new Set((metadata.data.dimensions||[]).map(x=>x.apiName)),metrics=new Set((metadata.data.metrics||[]).map(x=>x.apiName));
const desired=[
 {id:'event-inventory',dimensions:['eventName'],metrics:['eventCount','keyEvents','totalUsers']},
 {id:'events-by-device',dimensions:['eventName','deviceCategory'],metrics:['eventCount','keyEvents','totalUsers']},
 {id:'whatsapp-by-source-and-page',dimensions:['sessionSourceMedium','pagePath'],metrics:['eventCount','totalUsers','keyEvents'],event:'whatsapp_click'},
 {id:'whatsapp-by-campaign',dimensions:['sessionGoogleAdsCampaignId','sessionGoogleAdsCampaignName'],metrics:['eventCount','totalUsers','keyEvents'],event:'whatsapp_click'},
 {id:'paid-campaigns-in-ga4',dimensions:['sessionGoogleAdsCampaignId','sessionGoogleAdsCampaignName'],metrics:['sessions','advertiserAdClicks','advertiserAdCost','keyEvents','ecommercePurchases']},
 {id:'purchases-by-source',dimensions:['sessionSourceMedium'],metrics:['eventCount','ecommercePurchases','purchaseRevenue'],event:'purchase'},
 {id:'sessions-by-source',dimensions:['sessionSourceMedium'],metrics:['sessions','engagedSessions','keyEvents','ecommercePurchases']}
];
const bookDim=[...dims].find(x=>/customEvent:(libro_id|book_id|product_id)$/.test(x));
if(bookDim)desired.push({id:'whatsapp-by-book',dimensions:[bookDim,'sessionSourceMedium'],metrics:['eventCount','keyEvents'],event:'whatsapp_click'});
for(const spec of desired){
 const missing=[...spec.dimensions.filter(x=>!dims.has(x)),...spec.metrics.filter(x=>!metrics.has(x))];
 if(missing.length){report.reports.push({id:spec.id,skippedMissingFields:missing});continue;}
 const body={dateRanges:[report.period],dimensions:spec.dimensions.map(name=>({name})),metrics:spec.metrics.map(name=>({name})),limit:'10000',keepEmptyRows:true,returnPropertyQuota:true};
 if(spec.event)body.dimensionFilter={filter:{fieldName:'eventName',stringFilter:{matchType:'EXACT',value:spec.event}}};
 const r=await read('https://analyticsdata.googleapis.com/v1beta/properties/'+p+':runReport',body);
 report.reports.push({id:spec.id,...r});console.log(JSON.stringify({read:spec.id,status:r.status,complete:!r.data.rowCount||r.data.rowCount<=10000}));
}
process.env.MERCHANT_ACCESS_TOKEN=token;process.env.MERCHANT_ACCOUNT_ID='5330457716';process.env.MERCHANT_OUTPUT_DIR='private-audit/merchant';
const originalLog=console.log;
try{console.log=()=>{};await merchantMain();report.merchant={ok:true};}catch(e){report.merchant={ok:false,message:e.message.slice(0,2000)}}finally{console.log=originalLog;}
const outputs={ga4:report};
try{for(const f of await readdir('private-audit/merchant'))if(f.endsWith('.json'))outputs['merchant/'+f]=JSON.parse(await readFile('private-audit/merchant/'+f,'utf8'));}catch{}
const key=randomBytes(32),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
const ciphertext=Buffer.concat([cipher.update(JSON.stringify(outputs),'utf8'),cipher.final()]);
const wrapped=publicEncrypt({key:await readFile('scripts/monitoring/audit-public.pem','utf8'),padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},key);
await mkdir('private-evidence',{recursive:true});
await writeFile('private-evidence/google-readonly.encrypted.json',JSON.stringify({algorithm:'AES-256-GCM+RSA-OAEP-SHA256',iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),wrappedKey:wrapped.toString('base64'),ciphertext:ciphertext.toString('base64')}));
console.log('Encrypted read-only report ready. No private report content is printed.');
