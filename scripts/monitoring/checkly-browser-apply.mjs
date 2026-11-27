// One-off application explicitly approved by the owner on 2026-11-26.
// Only the reviewed browser script can change; all other check settings are preserved.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {pathToFileURL} from 'node:url';
import {readApi,recentResults,summarizeResult,scrub} from './checkly-evidence.mjs';
import {CHECKLY_ACCOUNT} from './checkly-cobro.mjs';
export const BROWSER_ID='0dc3fea6-5f11-49eb-b9e0-1c4f79471334';
const NAME='Amado - portadas banners y ficha';
export const BEFORE='a55568cd8c6bb09d8a4c0352ff2446542bb2332fe114abf8618fe54d3c6120af';
export const AFTER='0fc70b991744fe4d63401f8e3d4ba342ff54d871c5da45e43d5921719047fa7e';
export const hash=s=>createHash('sha256').update(String(s).replace(/\r\n/g,'\n')).digest('hex');
export function approvedUpdate(current,proposed){
 if(current.id!==BROWSER_ID||current.name!==NAME||current.checkType!=='BROWSER')throw Error('UNEXPECTED_CHECK');
 if(hash(proposed)!==AFTER)throw Error('UNREVIEWED_PROPOSAL');
 if(![BEFORE,AFTER].includes(hash(current.script)))throw Error('LIVE_SCRIPT_CHANGED');
 return hash(current.script)===AFTER?null:{script:proposed};
}
const protectedKeys=['name','checkType','activated','muted','shouldFail','frequency','locations','doubleCheck','retryStrategy','runParallel','maxResponseTime','degradedResponseTime','useGlobalAlertSettings','alertSettings','alertChannelSubscriptions','groupId','runtimeId','sslCheckDomain','environmentVariables','triggerIncident'];
const protectedConfig=c=>Object.fromEntries(protectedKeys.filter(k=>k in c).map(k=>[k,k==='alertChannelSubscriptions'?(c[k]||[]).map(s=>({alertChannelId:s.alertChannelId,activated:s.activated})).sort((a,b)=>a.alertChannelId-b.alertChannelId):c[k]]));
async function main(){
 if(process.env.APPLY_APPROVED_BROWSER!=='2026-11-26')throw Error('OWNER_APPROVAL_REQUIRED');
 const api=readApi(),headers={Authorization:'Bearer '+process.env.CHECKLY_API_KEY,'X-Checkly-Account':CHECKLY_ACCOUNT,'Content-Type':'application/json'};
 const dir='checkly-browser-application';await mkdir(dir,{recursive:true});
 const report={at:new Date().toISOString(),checkId:BROWSER_ID,configurationChanged:false,settingsPreserved:null,results:[]};
 const save=()=>writeFile(dir+'/application.json',JSON.stringify(report,null,2));
 try{
  const before=await api('/v1/checks/'+BROWSER_ID),script=await readFile(new URL('./checkly-browser.spec.cjs',import.meta.url),'utf8');
  const approved=approvedUpdate(before,script);
  const body=approved||(process.env.VERIFY_SETTINGS_NORMALIZATION==='1'?{script}:null);
  report.beforeHash=hash(before.script);report.proposedHash=hash(script);
  if(body){
   const r=await fetch('https://api.checklyhq.com/v1/checks/browser/'+BROWSER_ID+'?autoAssignAlerts=false',{method:'PUT',headers,redirect:'error',signal:AbortSignal.timeout(20000),body:JSON.stringify(body)});
   if(!r.ok)throw Error('BROWSER_UPDATE_HTTP_'+r.status+' '+scrub(await r.text()));
   report.configurationChanged=true;report.appliedAt=new Date().toISOString();await save();
  }
  const after=await api('/v1/checks/'+BROWSER_ID);
  report.changedMetadataKeys=protectedKeys.filter(k=>!isDeepStrictEqual(before[k],after[k]));
  report.changedSettingKeys=protectedKeys.filter(k=>!isDeepStrictEqual(protectedConfig(before)[k],protectedConfig(after)[k]));
  report.subscriptionsBefore=(before.alertChannelSubscriptions||[]).map(s=>({alertChannelId:s.alertChannelId,activated:s.activated}));
  report.subscriptionsAfter=(after.alertChannelSubscriptions||[]).map(s=>({alertChannelId:s.alertChannelId,activated:s.activated}));
  report.settingsPreserved=isDeepStrictEqual(protectedConfig(before),protectedConfig(after));
  report.afterHash=hash(after.script);report.frequency=after.frequency;report.muted=after.muted;report.activated=after.activated;report.shouldFail=after.shouldFail;
  if(!report.settingsPreserved||report.afterHash!==AFTER)throw Error('CHECK_CONFIG_VERIFICATION_FAILED');
  await save();
  for(let round=1;round<=2;round++){
   const since=Date.now();
   const trigger=await fetch('https://api.checklyhq.com/v2/check-sessions/trigger',{method:'POST',headers,redirect:'error',signal:AbortSignal.timeout(20000),body:JSON.stringify({target:{checkId:[BROWSER_ID]},refreshCache:true})});
   if(!trigger.ok)throw Error('BROWSER_TRIGGER_HTTP_'+trigger.status+' '+scrub(await trigger.text()));
   let latest=null;
   for(let attempt=0;attempt<20;attempt++){
    await new Promise(r=>setTimeout(r,6000));
    const batch=await recentResults(api,BROWSER_ID,{resultType:'FINAL'});
    latest=batch.rows.find(r=>Date.parse(r.startedAt)>=since-3000);
    if(latest)break;
   }
   if(!latest)throw Error('BROWSER_RESULT_NOT_PUBLISHED');
   report.results.push(summarizeResult(latest,after));await save();
   console.log(JSON.stringify({round,result:report.results.at(-1)}));
  }
  report.twoConsecutiveGreen=report.results.length===2&&report.results.every(r=>r.hasFailures===false&&r.hasErrors===false&&r.isCancelled!==true);
  if(!report.twoConsecutiveGreen)throw Error('BROWSER_NOT_TWO_GREEN');
 }catch(e){report.error=scrub(e.message);process.exitCode=1;}
 await save();console.log(JSON.stringify(report));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
