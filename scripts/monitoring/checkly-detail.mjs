// Diagnostic reads plus two runs of the existing unsigned-signature check.
// No check creation, updates, deletion, payment processing or valid signatures.
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {CHECKLY_ACCOUNT} from './checkly-cobro.mjs';
import {readApi,recentResults,summarizeResult,TARGET_NAMES,scrub} from './checkly-evidence.mjs';
const key=process.env.CHECKLY_API_KEY, api=readApi(), dir=resolve('checkly-evidence');
const headers={Authorization:'Bearer '+key,'X-Checkly-Account':CHECKLY_ACCOUNT,Accept:'application/json'};
const SIGNATURE='0e4f3da1-91d2-42cc-9c6c-c2888be2546b';
async function getDiagnostic(path) {
 const allowed=['/v1/maintenance-windows?limit=100','/v1/accounts/me/entitlements','/v2/usage/summary','/v2/usage/terms','/v1/usage/summary','/v1/usage/terms'];
 if(!allowed.includes(path))throw Error('DIAGNOSTIC_PATH_NOT_ALLOWED');
 const r=await fetch('https://api.checklyhq.com'+path,{method:'GET',headers,redirect:'error',signal:AbortSignal.timeout(20000)});
 return r.ok?await r.json():{httpStatus:r.status,error:scrub(await r.text())};
}
async function downloadAsset(asset,checkId,resultId,file) {
 const first=new URL(asset.url);
 const trusted = first.origin==='https://api.checklyhq.com' || /(?:^|\.)checklyhq\.com$|(?:^|\.)amazonaws\.com$/.test(first.hostname);
 if(first.protocol!=='https:' || !trusted)throw Error('ASSET_PATH_NOT_ALLOWED');
 let url=first;
 for(let redirects=0;redirects<4;redirects++){
  if(url.protocol!=='https:')throw Error('ASSET_REQUIRES_HTTPS');
  const r=await fetch(url,{method:'GET',redirect:'manual',headers:url.origin==='https://api.checklyhq.com'?headers:{},signal:AbortSignal.timeout(45000)});
  if([301,302,303,307,308].includes(r.status)){url=new URL(r.headers.get('location'),url);continue;}
  if(!r.ok)return{httpStatus:r.status};
  if(Number(r.headers.get('content-length')||0)>40000000)throw Error('ASSET_TOO_LARGE');
  const bytes=new Uint8Array(await r.arrayBuffer());
  if(bytes.length>40000000)throw Error('ASSET_TOO_LARGE');
  await writeFile(resolve(dir,file),bytes);
  return{file,bytes:bytes.length,contentType:r.headers.get('content-type')};
 }
 throw Error('ASSET_TOO_MANY_REDIRECTS');
}
const inventory=await api('/v1/checks');
const report={collectedAt:new Date().toISOString(),diagnostics:{},checks:[],assets:[],signatureRuns:[]};
await mkdir(dir,{recursive:true});
for(const p of ['/v1/maintenance-windows?limit=100','/v1/accounts/me/entitlements','/v2/usage/summary','/v2/usage/terms','/v1/usage/summary','/v1/usage/terms']){
 try{report.diagnostics[p]=await getDiagnostic(p);}catch(e){report.diagnostics[p]={error:scrub(e.message)};}
}
for(const c of inventory){
 const fields=['id','name','checkType','activated','muted','frequency','frequencyOffset','locations','groupId','groupOrder','created_at','updated_at','runtimeId','runParallel','doubleCheck','useGlobalAlertSettings','maxResponseTime','degradedResponseTime','retryStrategy','schedulingStrategy'];
 const details=Object.fromEntries(fields.filter(k=>k in c).map(k=>[k,c[k]]));
 details.availableKeys=Object.keys(c);
 const batch=await recentResults(api,c.id,{resultType:'ALL'});
 details.latest=batch.rows[0]?summarizeResult(batch.rows[0],c):null;
 if(c.id===SIGNATURE&&batch.rows[0]){
  const r=batch.rows[0];details.resultKeys=Object.keys(r);
  details.rawAssertions=r.apiCheckResult?.assertions||[];
  details.responseMeta=Object.fromEntries(Object.entries(r.apiCheckResult?.response||{}).filter(([k])=>!['body','headers'].includes(k)));
 }
 if(c.name===TARGET_NAMES[1]){
  const script=c.script||'';
  if(/\b(?:APP_USR-|TEST-)[A-Za-z0-9_-]{15,}/.test(script)||/\bBearer\s+[A-Za-z0-9_-]{12,}/.test(script))throw Error('SCRIPT_CONTAINS_CREDENTIAL_PATTERN');
  await writeFile(resolve(dir,'browser-check-current.js'),script);
  const failures=batch.rows.filter(r=>r.hasFailures||r.hasErrors).slice(0,2);
  for(const r of failures){
   const manifest=await api('/v1/check-results/'+c.id+'/'+r.id+'/assets');
   let index=0;
   for(const asset of manifest.assets||[]){
    if(!['trace','log','report','screenshot'].includes(asset.type))continue;
    const file=r.id+'-'+String(++index)+'-'+asset.name.replace(/[^a-zA-Z0-9_.-]/g,'_').slice(-120);
    try{report.assets.push({resultId:r.id,startedAt:r.startedAt,type:asset.type,name:asset.name,archive:asset.archive,...await downloadAsset(asset,c.id,r.id,file)});}
    catch(e){report.assets.push({resultId:r.id,name:asset.name,url:scrub(asset.url),error:scrub(e.message)});}
   }
  }
 }
 report.checks.push(details);
}
await writeFile(resolve(dir,'checkly-detail.json'),JSON.stringify(report,null,2));
// Trigger only the already-existing unsigned dummy notification. Never change its configuration.
if(process.env.RETEST_SIGNATURE==='1'){
 const c=inventory.find(c=>c.id===SIGNATURE);
 const url=new URL(c?.request?.url||'https://invalid.test');
 const body=typeof c?.request?.body==='string'?c.request.body:JSON.stringify(c?.request?.body||{});
 const signed=(c?.request?.headers||[]).some(h=>/signature|authorization/i.test(h.key||h.name||''));
 if(c?.name!==TARGET_NAMES[0]||c?.request?.method!=='POST'||url.origin!=='https://www.amadolibros.com'||url.pathname!=='/api/webhooks/mercadopago'||signed||!body.includes('"id":"1"'))throw Error('UNSAFE_SIGNATURE_RETEST');
 for(let round=1;round<=2;round++){
  const since=Date.now();
  const trigger=await fetch('https://api.checklyhq.com/v2/check-sessions/trigger',{method:'POST',headers:{...headers,'Content-Type':'application/json'},redirect:'error',body:JSON.stringify({target:{checkId:[SIGNATURE]},refreshCache:true}),signal:AbortSignal.timeout(20000)});
  const started={round,at:new Date(since).toISOString(),httpStatus:trigger.status};
  if(!trigger.ok){report.signatureRuns.push({...started,error:scrub(await trigger.text())});break;}
  let latest=null;
  for(let attempt=0;attempt<15;attempt++){
   await new Promise(r=>setTimeout(r,6000));
   const rows=await recentResults(api,SIGNATURE,{resultType:'ALL'});
   latest=rows.rows.find(r=>Date.parse(r.startedAt)>=since-3000);
   if(latest)break;
  }
  report.signatureRuns.push({...started,result:latest?summarizeResult(latest,c):null});
  await writeFile(resolve(dir,'checkly-detail.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({signatureRetest:report.signatureRuns.at(-1)}));
  if(!latest)break;
 }
}
await writeFile(resolve(dir,'checkly-detail.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({diagnosticsRead:true,assetDownloads:report.assets.map(x=>({resultId:x.resultId,file:x.file,bytes:x.bytes,error:x.error,httpStatus:x.httpStatus})),signatureRuns:report.signatureRuns.length}));

