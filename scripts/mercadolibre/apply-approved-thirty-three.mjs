import fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import crypto from 'node:crypto';
import {createEngine as readerEngine,canonical,state,payloadFor,snapshot,snapshotKey} from './apply-approved-hundred.mjs';
import {normalizeValidIsbn} from '../../functions/_shared/showcase-ranking.js';
export const HASH='9ae44ce84f5677749b0a9492e384ac0d1e1fa06bfb37367aa9ce6540a33bcc58';
const TABLE='amado_attributes_thirty_three_20261024',SELLER='440298103',DB='6dc8dc3a-2d4f-4045-b428-14323c7b0bcd',APP='4741021817925208';
const fail=s=>{throw Error(s);};
export function validateManifest(m){
 const {review_hash,...content}=m;
 if(review_hash!==HASH||crypto.createHash('sha256').update(canonical(content)).digest('hex')!==HASH||String(m.seller_id)!==SELLER||m.approved?.length!==28||m.excluded_ids?.length!==16||m.excluded_conditional_fields?.length!==2)fail('unauthorized_manifest');
 const ids=new Set(),ups=new Set();let changes=0,corrections=0;
 for(const p of m.approved){
  if(!/^MLU\d+$/.test(p.id)||!/^MLUU\d+$/.test(p.up)||ups.has(p.up)||normalizeValidIsbn(p.isbn)!==p.isbn||!['BOOK_GENRE','BOOK_EDITION','PUBLICATION_YEAR'].includes(p.attribute)||p.peers.length>1)fail('invalid_policy');ups.add(p.up);
  if(p.members.length!==1+p.peers.length||canonical(p.members.map(m=>m.id).sort())!==canonical([p.id,...p.peers.map(x=>x.id)].sort()))fail('invalid_members');
  for(const member of p.members){if(ids.has(member.id)||m.excluded_ids.includes(member.id)||m.excluded_conditional_fields.some(x=>x.id===member.id&&x.attribute_id===p.attribute)||!['completar','corregir','conservar'].includes(member.action))fail('unauthorized_member');ids.add(member.id);if(member.action!=='conservar')changes++;if(member.action==='corregir')corrections++;if(member.action==='completar'&&member.before!==null)fail('invalid_missing_before');}
 }
 if(changes!==33||corrections!==3||ids.size!==55)fail('wrong_scope');return m;
}
export function createApproved33Engine({ml,receipts,wait=ms=>new Promise(r=>setTimeout(r,ms))}){
 const inspect=readerEngine({ml,receipts}).inspect;
 const change=p=>({attribute:p.attribute,value:p.value,payload:p.payload});
 const snap=(p,b)=>snapshot(b.items,b.descriptions,[change(p)]);
 function guard(p,b,before){
  if(before&&snapshotKey(snap(p,b))!==snapshotKey(before.snapshot))fail('protected_or_other_attributes_changed');
  for(const member of p.members){const i=b.items.find(i=>i.id===member.id),s=state(i,change(p));if(s==='matches')continue;
   if(member.action==='conservar')fail('preserved_member_value_changed');
   if(member.action==='completar'&&s==='missing')continue;
   if(member.action==='corregir'&&member.before?.value_name&&state(i,{attribute:p.attribute,value:member.before.value_name})==='matches')continue;
   fail('authorized_before_value_changed');
  }
 }
 async function plan(p){const b=await inspect(p),schema=await ml('/categories/MLU1196/attributes');if(!Array.isArray(schema)||!schema.length)fail('empty_schema');payloadFor({changes:[change(p)]},[{attributes:[]}],schema);guard(p,b);return {...b,snapshot:snap(p,b),ready:p.members.filter(m=>m.action!=='conservar'&&state(b.items.find(i=>i.id===m.id),change(p))!=='matches').map(m=>m.id)};}
 async function verify(p,before){const after=await inspect(p);guard(p,after,before);if(after.items.some(i=>state(i,change(p))!=='matches'))fail('approved_values_not_persisted');return {id:p.id,state:'verified',attribute:p.attribute,value:p.value,item_ids:after.items.map(i=>i.id),protected_and_other_attributes_unchanged:true,verified_at:new Date().toISOString(),after};}
 async function apply(p,pre){
  const key='G:'+p.id,old=await receipts.read(key);
  if(old){const v=await verify(p,JSON.parse(old.before_json));await receipts.save(key,'verified',v);return {...v,state:'prior_verified_no_retry'};}
  const b=await plan(p);if(canonical(b.ready)!==canonical(pre.ready)||snapshotKey(b.snapshot)!==snapshotKey(pre.snapshot))return {id:p.id,state:'blocked',reason:'changed_since_preflight'};
  if(!b.ready.length)return {id:p.id,state:'already_matches',verified:await verify(p,b)};
  const backup={...b,review_hash:HASH,policy:p};if(!await receipts.claim(key,backup))fail('prior_group_attempt');
  try{
   for(const id of b.ready){
    let current=await inspect(p);guard(p,current,backup);if(state(current.items.find(i=>i.id===id),change(p))==='matches')continue;
    const body={attributes:[p.payload]},writeKey='W:'+id;
    if(!await receipts.claim(writeKey,{...backup,write_id:id,request_body:body}))fail('prior_item_attempt_no_retry');
    for(let attempt=0;;attempt++){
     try{await ml('/items/'+id,'PUT',body);await receipts.save(writeKey,'accepted_pending_readback',{accepted_request_body:body,retry_count:attempt});break;}
     catch(e){await receipts.save(writeKey,'uncertain_no_retry',{error:e.message,retry_count:attempt});if(e.message!=='ml_put_http_409'||attempt||!receipts.retry409)throw e;
      await wait(5000);current=await inspect(p);guard(p,current,backup);if(state(current.items.find(i=>i.id===id),change(p))==='matches')break;
      if(!await receipts.retry409(writeKey))fail('retry_claim_failed');
     }
    }
    let observed=false;
    for(let n=0;n<6;n++){const after=await inspect(p);guard(p,after,backup);if(state(after.items.find(i=>i.id===id),change(p))==='matches'){observed=true;break;}if(n<5)await wait(2000);}
    if(!observed)fail('written_value_not_persisted');await receipts.save(writeKey,'verified',{write_id:id,attribute:p.attribute,value:p.value,accepted_request_body:body});
   }
   const result=await verify(p,backup);await receipts.save(key,'verified',result);return result;
  }catch(e){await receipts.save(key,'uncertain_no_retry',{error:e.message});throw e;}
 }
 return {inspect,plan,verify,apply};
}

async function main(){
 const mode=process.argv[2],dir=process.argv[3];if(!['preflight','apply','verify','export'].includes(mode)||!dir)fail('invalid_mode');
 const manifest=validateManifest(JSON.parse(await fs.readFile(new URL('./approved-thirty-three-manifest.json',import.meta.url),'utf8')));
 const account=process.env.CLOUDFLARE_ACCOUNT_ID,cf=process.env.CLOUDFLARE_API_TOKEN;if(!/^[a-f0-9]{32}$/.test(account??'')||!cf)fail('cloudflare_auth_missing');
 if(mode==='apply'&&process.env.AUTHORIZED_REVIEW_HASH!==HASH)fail('apply_not_authorized');
 await fs.mkdir(dir,{recursive:true});
 async function sql(query,params=[]){const r=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${DB}/query`,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(30000),headers:{Authorization:'Bearer '+cf,'Content-Type':'application/json'},body:JSON.stringify({sql:query,params})});if(!r.ok)fail('receipt_db_http_'+r.status);const b=await r.json();if(!b.success||b.result?.some(x=>!x.success))fail('receipt_db_failed');return b.result[0].results;}
 let token;
 async function ml(path,method='GET',body){
  if(method==='PUT'){
   if(mode!=='apply')fail('write_mode_forbidden');
   const p=manifest.approved.find(p=>p.members.some(m=>m.id===path.slice(7)&&m.action!=='conservar'));
   if(!p||path!=='/items/'+p.members.find(m=>m.id===path.slice(7)).id||canonical(body)!==canonical({attributes:[p.payload]}))fail('write_outside_authorization');
  }else if(method!=='GET'||!/^\/(?:users\/me$|users\/440298103\/items\/search\?|items\/MLU\d+(?:\?|\/description$)|categories\/MLU1196\/attributes$)/.test(path))fail('path_not_allowed');
  if(!token||Number(token.access_expires_at)-Date.now()<300000)token=(await sql('SELECT access_token,access_expires_at FROM ml_oauth WHERE app_id=?',[APP]))[0];
  if(!token?.access_token||Number(token.access_expires_at)-Date.now()<120000)fail('existing_token_unavailable_or_expiring');
  for(let attempt=0;attempt<4;attempt++){
   const r=await fetch('https://api.mercadolibre.com'+path,{method,redirect:'manual',signal:AbortSignal.timeout(30000),headers:{Authorization:'Bearer '+token.access_token,'Content-Type':'application/json',Accept:'application/json'},...(body?{body:JSON.stringify(body)}:{})});
   if(method==='GET'&&[429,500,502,503,504].includes(r.status)&&attempt<3){await new Promise(r=>setTimeout(r,1000*(attempt+1)));continue;}
   if(r.status===404&&path.endsWith('/description'))return null;
   if(!r.ok){if(method==='PUT'){const e=await r.json().catch(()=>({}));await fs.writeFile(dir+'/last-write-error.json',JSON.stringify({path,status:r.status,error:e.error,message:e.message,cause:e.cause},null,2));}fail('ml_'+method.toLowerCase()+'_http_'+r.status);}
   const text=await r.text();if(!text.trim())fail('empty_api_response');return JSON.parse(text);
  }
 }
 if(String((await ml('/users/me')).id)!==SELLER)fail('wrong_account');
 const receipts={read:async id=>(await sql(`SELECT * FROM ${TABLE} WHERE item_id=?`,[id]))[0],claim:async(id,b)=>!!(await sql(`INSERT OR IGNORE INTO ${TABLE}(item_id,state,before_json,created_at,updated_at) VALUES(?,'attempting',?,?,?) RETURNING item_id`,[id,JSON.stringify(b),new Date().toISOString(),new Date().toISOString()]))[0],save:(id,s,b)=>sql(`UPDATE ${TABLE} SET state=?,result_json=?,updated_at=? WHERE item_id=?`,[s,JSON.stringify(b),new Date().toISOString(),id])};
 receipts.retry409=async id=>!!(await sql(`UPDATE ${TABLE} SET state='attempting_after_409_readback',result_json=? WHERE item_id=? AND state='uncertain_no_retry' AND json_extract(result_json,'$.error')='ml_put_http_409' AND json_extract(result_json,'$.retry_count')=0 RETURNING item_id`,[JSON.stringify({retry_count:1}),id]))[0];
 const engine=createApproved33Engine({ml,receipts});
 if(mode==='preflight'){
  const report={review_hash:HASH,started_at:new Date().toISOString(),items:[],complete:false};
  for(const p of manifest.approved){try{report.items.push({id:p.id,state:'eligible',...await engine.plan(p)});}catch(e){report.items.push({id:p.id,state:'blocked',reason:e.message});}await fs.writeFile(dir+'/preflight.json',JSON.stringify(report,null,2));}
  report.complete=report.items.length===28;report.completed_at=new Date().toISOString();await fs.writeFile(dir+'/preflight.json',JSON.stringify(report,null,2));console.log(JSON.stringify({eligible:report.items.filter(i=>i.state==='eligible').length,ready_item_changes:report.items.reduce((n,i)=>n+(i.ready?.length??0),0),blocked:report.items.filter(i=>i.state==='blocked').length}));return;
 }
 if(mode==='apply')await sql(`CREATE TABLE IF NOT EXISTS ${TABLE}(item_id TEXT PRIMARY KEY,state TEXT NOT NULL,before_json TEXT NOT NULL,result_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`);
 const summary={mode,review_hash:HASH,results:[],stopped:null};
 try{
  if(mode==='apply'){
   const pre=JSON.parse(await fs.readFile(dir+'/preflight.json','utf8'));if(pre.review_hash!==HASH||!pre.complete||pre.items.length!==28||Date.now()-Date.parse(pre.completed_at)>1200000)fail('invalid_or_stale_preflight');
   for(const p of manifest.approved){const b=pre.items.find(x=>x.id===p.id);if(b.state!=='eligible'){summary.results.push({id:p.id,state:'blocked',reason:b.reason});continue;}summary.results.push(await engine.apply(p,b));await fs.writeFile(dir+'/apply-summary.json',JSON.stringify(summary,null,2));console.log('Processed:',summary.results.length,summary.results.at(-1).state);}
  }else{
   for(const p of manifest.approved){const r=await receipts.read('G:'+p.id);if(!r)continue;
    try{const v=await engine.verify(p,JSON.parse(r.before_json));summary.results.push({...v,after:undefined});if(mode==='verify')await receipts.save('G:'+p.id,'verified',v);await fs.writeFile(dir+'/'+p.id+'-after.json',JSON.stringify(v.after,null,2));}
    catch(e){summary.results.push({id:p.id,state:'verification_exception',reason:e.message});const after=await engine.inspect(p);await fs.writeFile(dir+'/'+p.id+'-after.json',JSON.stringify(after,null,2));process.exitCode=1;}
   }
  }
 }catch(e){summary.stopped=e.message;process.exitCode=1;}
 finally{await fs.writeFile(dir+'/'+mode+'-summary.json',JSON.stringify({...summary,completed_at:new Date().toISOString()},null,2));await fs.writeFile(dir+'/receipts.json',JSON.stringify(await sql(`SELECT * FROM ${TABLE}`),null,2));console.log(JSON.stringify({mode,processed:summary.results.length,stopped:summary.stopped}));}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{console.error(/^[a-z0-9_]+$/.test(e.message)?e.message:'operation_failed_credentials_redacted');process.exitCode=1;});
