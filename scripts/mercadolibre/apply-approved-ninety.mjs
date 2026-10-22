import fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {normalizeValidIsbn} from '../../functions/_shared/showcase-ranking.js';
import {createEngine,canonical,state,snapshot,snapshotKey} from './apply-approved-hundred.mjs';
export {createEngine,canonical,state,payloadFor,snapshot,snapshotKey} from './apply-approved-hundred.mjs';
const SELLER='440298103',DB='6dc8dc3a-2d4f-4045-b428-14323c7b0bcd',APP='4741021817925208';
const TABLE='amado_attributes_ninety_20261022';
const HASH='2f99a1c4f0aaea1da64aae27ee8d8f52fc2fa7f414aba4b45acae6edc7f14cbb';
const ALLOWED=new Set(['PUBLICATION_YEAR','PAGES_NUMBER','BOOK_EDITION','BOOK_COVER','BOOK_GENRE']);
const fail=x=>{throw Error(x);};
export function validateManifest(m){
 if(m.review_hash!==HASH||String(m.seller_id)!==SELLER||m.approved?.length!==59||m.authorized_proposals!==90||m.excluded_ids?.length!==16)fail('manifest_not_authorized');
 const all=new Set(),ups=new Set();let count=0;
 for(const p of m.approved){
  if(!/^MLU\d+$/.test(p.id)||!/^MLUU\d+$/.test(p.up)||ups.has(p.up)||!Array.isArray(p.peers)||p.peers.length>1||normalizeValidIsbn(p.isbn)!==p.isbn)fail('invalid_manifest_identity');ups.add(p.up);
  for(const id of [p.id,...p.peers.map(x=>x.id)]){if(all.has(id)||m.excluded_ids.includes(id))fail('duplicate_or_excluded');all.add(id);}
  const fields=new Set();for(const c of p.changes){if(!ALLOWED.has(c.attribute)||fields.has(c.attribute)||!c.value||c.payload?.id!==c.attribute||Object.keys(c.payload).some(k=>!['id','value_id','value_name'].includes(k))||m.excluded_conditional_fields.some(x=>x.id===p.id&&x.attribute===c.attribute))fail('invalid_approved_change');fields.add(c.attribute);count++;}
 }
 if(count!==64||all.size!==118||m.schema_blocked.length!==26)fail('wrong_authorized_scope');return m;
}
async function main(){
 const mode=process.argv[2],dir=process.argv[3];if(!['preflight','apply','repair','verify','export'].includes(mode)||!dir)fail('invalid_mode');
 const manifest=validateManifest(JSON.parse(await fs.readFile(new URL('./approved-ninety-manifest.json',import.meta.url),'utf8')));
 const account=process.env.CLOUDFLARE_ACCOUNT_ID,cf=process.env.CLOUDFLARE_API_TOKEN;if(!/^[a-f0-9]{32}$/.test(account??'')||!cf)fail('cloudflare_auth_missing');
 async function sql(query,params=[]){const r=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${DB}/query`,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(30000),headers:{Authorization:'Bearer '+cf,'Content-Type':'application/json'},body:JSON.stringify({sql:query,params})});if(!r.ok)fail('receipt_db_http_'+r.status);const b=await r.json();if(!b.success||b.result?.some(x=>!x.success))fail('receipt_db_failed');return b.result[0].results;}
 let tokenRow;async function ml(path,method='GET',body){
  const policy=manifest.approved.find(p=>[p.id,...p.peers.map(x=>x.id)].some(id=>path==='/items/'+id));
  if(method==='PUT'&&(!/^\/items\/MLU\d+$/.test(path)||!policy||Object.keys(body??{}).join()!=='attributes'||!Array.isArray(body.attributes)||body.attributes.some(a=>!ALLOWED.has(a.id)||!policy.changes.some(c=>canonical(c.payload)===canonical(a)))))fail('write_outside_authorization');
  if(method!=='GET'&&method!=='PUT')fail('method_forbidden');
  if(!tokenRow||Number(tokenRow.access_expires_at)-Date.now()<300000)tokenRow=(await sql('SELECT access_token,access_expires_at FROM ml_oauth WHERE app_id=?',[APP]))[0];
  if(!tokenRow?.access_token||Number(tokenRow.access_expires_at)-Date.now()<120000)fail('existing_token_unavailable_or_expiring');
  for(let attempt=0;attempt<4;attempt++){
   const r=await fetch('https://api.mercadolibre.com'+path,{method,redirect:'manual',signal:AbortSignal.timeout(30000),headers:{Authorization:'Bearer '+tokenRow.access_token,'Content-Type':'application/json',Accept:'application/json'},...(body?{body:JSON.stringify(body)}:{})});
   if(method==='GET'&&[429,500,502,503,504].includes(r.status)&&attempt<3){await new Promise(r=>setTimeout(r,1000*(attempt+1)));continue;}
   if(r.status===404&&path.endsWith('/description'))return null;
   if(!r.ok){if(method==='PUT'){const e=await r.json().catch(()=>({}));await fs.writeFile(dir+'/last-write-error.json',JSON.stringify({path,status:r.status,error:e.error,message:e.message,cause:e.cause},null,2));}fail('ml_'+method.toLowerCase()+'_http_'+r.status);}const text=await r.text();if(!text.trim())fail('empty_api_response');return JSON.parse(text);
  }
 }
 if(String((await ml('/users/me')).id)!==SELLER)fail('wrong_account');
 await fs.mkdir(dir,{recursive:true});
 const receipts={read:async id=>(await sql(`SELECT * FROM ${TABLE} WHERE item_id=?`,[id]))[0],claim:async(id,b)=>!!(await sql(`INSERT OR IGNORE INTO ${TABLE}(item_id,state,before_json,created_at,updated_at) VALUES(?,'attempting',?,?,?) RETURNING item_id`,[id,JSON.stringify(b),new Date().toISOString(),new Date().toISOString()]))[0],save:(id,s,b)=>sql(`UPDATE ${TABLE} SET state=?,result_json=?,updated_at=? WHERE item_id=?`,[s,JSON.stringify(b),new Date().toISOString(),id])};
 receipts.retry409=async(id,body)=>!!(await sql(`UPDATE ${TABLE} SET state='attempting_after_409_readback',result_json=?,updated_at=? WHERE item_id=? AND state='uncertain_no_retry' AND json_extract(result_json,'$.error')='ml_put_http_409' AND COALESCE(json_extract(result_json,'$.retry_count'),0)=0 RETURNING item_id`,[JSON.stringify({retry_count:1,prior_error:'ml_put_http_409',retry_request_body:body}),new Date().toISOString(),id]))[0];
 const engine=createEngine({ml,receipts,reviewHash:HASH});
 if(mode==='preflight'){
  const report={review_hash:HASH,started_at:new Date().toISOString(),items:[],complete:false};
  for(const p of manifest.approved){try{const b=await engine.plan(p);report.items.push({id:p.id,state:'eligible',...b});}catch(e){report.items.push({id:p.id,state:'blocked',reason:e.message});}await fs.writeFile(dir+'/preflight.json',JSON.stringify(report,null,2));if(report.items.length%10===0)console.log('Preflight:',report.items.length);}
  report.complete=report.items.length===59;report.completed_at=new Date().toISOString();await fs.writeFile(dir+'/preflight.json',JSON.stringify(report,null,2));console.log(JSON.stringify({eligible:report.items.filter(i=>i.state==='eligible').length,attributes:report.items.reduce((n,i)=>n+(i.ready?.length??0),0),blocked:report.items.filter(i=>i.state==='blocked').length}));return;
 }
 if(['apply','repair'].includes(mode)&&process.env.AUTHORIZED_REVIEW_HASH!==HASH)fail('apply_not_authorized');
 if(mode==='apply')await sql(`CREATE TABLE IF NOT EXISTS ${TABLE}(item_id TEXT PRIMARY KEY,state TEXT NOT NULL,before_json TEXT NOT NULL,result_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`);
 const summary={mode,review_hash:HASH,results:[],stopped:null};
 try{
  if(mode==='apply'){
   const pre=JSON.parse(await fs.readFile(dir+'/preflight.json','utf8'));if(pre.review_hash!==HASH||!pre.complete||pre.items.length!==59||Date.now()-Date.parse(pre.completed_at)>1200000)fail('invalid_or_stale_preflight');
   for(const p of manifest.approved){const b=pre.items.find(i=>i.id===p.id);if(b.state!=='eligible'){summary.results.push({id:p.id,state:'blocked',reason:b.reason});continue;}try{summary.results.push(await engine.apply(p,b));}catch(e){summary.results.push({id:p.id,state:'uncertain_no_retry',reason:e.message});throw e;}await fs.writeFile(dir+'/apply-summary.json',JSON.stringify(summary,null,2));console.log('Processed:',summary.results.length,summary.results.at(-1).state);}
  }else if(['verify','repair'].includes(mode)){
   for(const p of manifest.approved){const r=await receipts.read(p.id);if(!r)continue;
    try{if(mode==='repair')await engine.repair(p,JSON.parse(r.before_json));const v=await engine.verify(p,r);await receipts.save(p.id,'verified',v);for(const peer of p.peers)if(await receipts.read(peer.id))await receipts.save(peer.id,'verified',v);summary.results.push(v);}
    catch(e){if(mode!=='verify')throw e;const v={id:p.id,state:'verification_exception',reason:e.message,verified_at:new Date().toISOString()};summary.results.push(v);await receipts.save(p.id,'verification_exception',v);for(const peer of p.peers)if(await receipts.read(peer.id))await receipts.save(peer.id,'verification_exception',v);}
   }
   if(summary.results.some(r=>r.state==='verification_exception')){summary.stopped='verification_exceptions_require_review';process.exitCode=1;}
  }
 }catch(e){summary.stopped=e.message;process.exitCode=1;}
 finally{
  if(mode!=='export')await fs.writeFile(dir+'/'+mode+'-summary.json',JSON.stringify({...summary,completed_at:new Date().toISOString()},null,2));
  const all=await sql(`SELECT * FROM ${TABLE}`);await fs.writeFile(dir+'/receipts.json',JSON.stringify(all,null,2));
  if(mode==='export')for(const r of all){const p=manifest.approved.find(p=>[p.id,...p.peers.map(x=>x.id)].includes(r.item_id));if(!p)fail('unexpected_receipt');const b=JSON.parse(r.before_json),after=await engine.inspect(p);await fs.writeFile(dir+'/'+r.item_id+'-after.json',JSON.stringify({...after,states:after.items.map(i=>({id:i.id,attributes:b.ready.map(c=>({id:c.attribute,expected:c.value,state:state(i,c),actual:i.attributes.filter(a=>a.id===c.attribute)}))})),protected_unchanged:snapshotKey(snapshot(after.items,after.descriptions,b.ready))===snapshotKey(b.snapshot)},null,2));}
  console.log(JSON.stringify({mode,processed:summary.results.length,verified:summary.results.filter(x=>x.state==='verified').length,stopped:summary.stopped}));
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{console.error(/^[a-z0-9_]+$/.test(e.message)?e.message:'operation_failed_credentials_redacted');process.exitCode=1;});
