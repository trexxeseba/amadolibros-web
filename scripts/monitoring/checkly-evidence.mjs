// Read-only Checkly evidence. No check triggers or configuration writes.
import {writeFile,mkdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {CHECKLY_ACCOUNT} from './checkly-cobro.mjs';
export const TARGET_NAMES=['Amado cobro - aviso de Mercado Pago exige firma','Amado - portadas banners y ficha'];
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function readApi({key=process.env.CHECKLY_API_KEY,fetchFn=fetch}={}) {
  if(!key)throw new Error('CHECKLY_KEY_REQUIRED');
  return async path=>{
    const url=new URL(path,'https://api.checklyhq.com');
    if(url.origin!=='https://api.checklyhq.com'||!/^\/v[12]\/(?:checks|check-statuses|check-results)(?:\/[a-f0-9-]+)*(?:\/assets)?$/i.test(url.pathname))throw new Error('READ_PATH_NOT_ALLOWED');
    const r=await fetchFn(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+key,'X-Checkly-Account':CHECKLY_ACCOUNT,Accept:'application/json'}});
    if(!r.ok)throw new Error('CHECKLY_READ_HTTP_'+r.status);
    return r.json();
  };
}
export function scrub(value) {
  return String(value??'').replace(/https?:\/\/[^\s"'<>]+/g,s=>{try{const u=new URL(s);return u.origin+u.pathname;}catch{return '[URL]';}})
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi,'[EMAIL]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=_-]+/gi,'[AUTH]')
    .replace(/\b(?:APP_USR-|TEST-)[A-Za-z0-9_-]+/g,'[TOKEN]')
    .replace(/((?:token|secret|authorization|cookie|x-api-key)\s*[:=]\s*)[^,\s;]+/gi,'$1[REDACTED]').slice(0,12000);
}
const safe=v=>typeof v==='boolean'||typeof v==='number'||v==null?v??null:scrub(typeof v==='string'?v:JSON.stringify(v));
export function summarizeResult(r,check) {
  const a=r.apiCheckResult||{},b=r.browserCheckResult||r.playwrightCheckResult||{},response=a.response||{};
  return {
    id:r.id,checkId:r.checkId,startedAt:r.startedAt,stoppedAt:r.stoppedAt,location:r.runLocation,resultType:r.resultType,
    hasFailures:r.hasFailures,hasErrors:r.hasErrors,isDegraded:r.isDegraded,isCancelled:r.isCancelled,
    overMaxResponseTime:r.overMaxResponseTime,responseTime:r.responseTime,httpStatus:response.status??null,
    responseBody:check.name===TARGET_NAMES[0]?safe(response.body):null,requestError:safe(a.requestError),
    assertions:(a.assertions||[]).map(x=>Object.fromEntries(['source','property','comparison','target','actual','error','success','passed','isPassed','result'].filter(k=>k in x).map(k=>[k,safe(x[k])]))),
    apiResultKeys:Object.keys(a),browserResultKeys:Object.keys(b),browserErrors:safe(b.errors),browserLog:safe(b.jobLog),apiLog:safe(a.jobLog),
    browserPages:safe(b.pages),assetCount:Array.isArray(b.jobAssets)?b.jobAssets.length:null,
  };
}
export async function recentResults(api,id,{now=Date.now(),resultType='FINAL',maxPages=10}={}) {
  if(!UUID.test(id))throw new Error('CHECK_ID_INVALID');
  const from=Math.floor(now/1000)-72*3600,to=Math.floor(now/1000)+1,rows=new Map(),seen=new Set();
  let cursor=null;
  const result=complete=>({complete,from,to,totalInWindow:rows.size,rows:[...rows.values()].sort((a,b)=>Date.parse(b.startedAt)-Date.parse(a.startedAt)).slice(0,20)});
  for(let p=0;p<maxPages;p++) {
    const q=new URLSearchParams({limit:'100',resultType,from:String(from),to:String(to)});if(cursor)q.set('nextId',cursor);
    const batch=await api('/v2/check-results/'+id+'?'+q);
    for(const r of batch.entries||[])if(r.checkId===id&&Date.parse(r.startedAt)>=from*1000&&Date.parse(r.startedAt)<to*1000)rows.set(r.id||r.startedAt,r);
    cursor=batch.nextId??null;
    if(!cursor)return result(true);
    if(seen.has(cursor))throw new Error('RESULT_CURSOR_REPEATED');seen.add(cursor);
  }
  return result(false);
}
export async function evidence({api=readApi(),now=Date.now()}={}) {
  const [inventory,statuses]=await Promise.all([api('/v1/checks'),api('/v1/check-statuses')]);
  const checks=inventory.filter(c=>TARGET_NAMES.includes(c.name));
  const report={collectedAt:new Date(now).toISOString(),windowHours:72,checks:[],missingChecks:TARGET_NAMES.filter(n=>!checks.some(c=>c.name===n))};
  for(const c of checks) {
    const s=(Array.isArray(statuses)?statuses:[]).find(s=>s.checkId===c.id)||{};
    const current=Object.fromEntries(['hasFailures','hasErrors','isDegraded','updated_at','updatedAt'].filter(k=>k in s).map(k=>[k,s[k]]));
    const batches={};
    for(const type of ['FINAL','ALL']){const batch=await recentResults(api,c.id,{now,resultType:type});batches[type]={...batch,rows:batch.rows.map(r=>summarizeResult(r,c))};}
    const failure=batches.ALL.rows.find(r=>r.hasFailures||r.hasErrors);
    let assets=null;
    if(failure&&UUID.test(failure.id||''))try{
      const manifest=await api('/v1/check-results/'+c.id+'/'+failure.id+'/assets');
      const items=Array.isArray(manifest)?manifest:manifest.assets||manifest.entries||[];
      assets={keys:Object.keys(manifest),items:items.map(a=>({type:a.type??a.assetType,name:scrub(a.name??a.filename??''),size:a.size??a.sizeBytes??null}))};
    }catch(e){assets={error:String(e.message)};}
    const newest=batches.ALL.rows[0];
    report.checks.push({id:c.id,name:c.name,type:c.checkType,activated:c.activated,muted:c.muted,frequency:c.frequency,locations:c.locations,runParallel:c.runParallel,doubleCheck:c.doubleCheck,degradedResponseTime:c.degradedResponseTime,maxResponseTime:c.maxResponseTime,current,
      stale:!newest||now-Date.parse(newest.startedAt)>Math.max(c.frequency*120000,120000),
      configuredAssertions:(c.request?.assertions||[]).map(a=>({source:a.source,comparison:a.comparison,property:a.property,target:a.target})),
      browserScriptSignals:c.checkType==='BROWSER'?{scriptLength:(c.script||'').length,assertionMessages:[...(c.script||'').matchAll(/['"]([A-Z][A-Z_]{6,})['"]/g)].map(m=>m[1])}:null,
      results:batches,latestFailureAssets:assets});
  }
  return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try{
    const report=await evidence(),dir=resolve(process.env.EVIDENCE_DIR||'checkly-evidence');await mkdir(dir,{recursive:true});
    await writeFile(resolve(dir,'checkly-results.json'),JSON.stringify(report,null,2));
    for(const c of report.checks)console.log(JSON.stringify({name:c.name,id:c.id,active:c.activated,muted:c.muted,frequency:c.frequency,locations:c.locations,current:c.current,stale:c.stale,latest:c.results.ALL.rows[0],returned:c.results.ALL.rows.length,complete:c.results.ALL.complete,assets:c.latestFailureAssets}));
    if(report.missingChecks.length)throw new Error('EXPECTED_CHECK_MISSING');
  }catch(e){console.error(/^[A-Z0-9_]+$/.test(e?.message||'')?e.message:'CHECKLY_EVIDENCE_FAILED');process.exitCode=1;}
}
