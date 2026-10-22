import fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {normalizeValidIsbn} from '../../functions/_shared/showcase-ranking.js';
import {checkPage} from './read-hundred-groups.mjs';
const SELLER='440298103',DB='6dc8dc3a-2d4f-4045-b428-14323c7b0bcd',APP='4741021817925208';
const TABLE='amado_attributes_hundred_20261021';
const HASH='9aed917da06d17a078f046b22b1702b4145abd7e446c65d1edbee50c0e997612';
const ALLOWED=new Set(['PUBLICATION_YEAR','PAGES_NUMBER','BOOK_EDITION','BOOK_COVER','LANGUAGE']);
export const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
const fail=x=>{throw Error(x);};
const norm=v=>String(v).normalize('NFKC').trim().toLowerCase();
export function comparable(attribute,value){
 const s=norm(value);
 if(attribute==='BOOK_EDITION'){
  const m=s.match(/^([1-9]\d*)\s*(?:[aº°]|a\.?\s*ed\.?|ed\.?|edici[oó]n)?$/);
  // NFKC turns the ordinal indicator ª into a. Only a complete ordinal is
  // equivalent to ML's normalized number; years/prose are never stripped out.
  if(m)return String(Number(m[1]));
 }
 return s;
}
export function state(item,c){
 const a=item.attributes.filter(a=>a.id===c.attribute);if(!a.length)return 'missing';
 if(a.some(a=>String(a.value_id)==='-1'||a.values?.some(v=>String(v.id)==='-1')))return 'na';
 const values=[...new Set(a.flatMap(a=>[a.value_name,...(a.values??[]).map(v=>v.name)]).filter(v=>v!=null&&String(v).trim()!=='').map(v=>comparable(c.attribute,v)))];
 return values.length===1&&values[0]===comparable(c.attribute,c.value)?'matches':'conflict';
}
export function validateManifest(m){
 if(m.review_hash!==HASH||String(m.seller_id)!==SELLER||m.approved?.length!==100||m.excluded_ids?.length!==16)fail('manifest_not_authorized');
 const all=new Set(),ups=new Set();let count=0;
 for(const p of m.approved){
  if(!/^MLU\d+$/.test(p.id)||!/^MLUU\d+$/.test(p.up)||ups.has(p.up)||p.peers?.length!==1||normalizeValidIsbn(p.isbn)!==p.isbn)fail('invalid_manifest_identity');ups.add(p.up);
  for(const id of [p.id,...p.peers.map(x=>x.id)]){if(all.has(id)||m.excluded_ids.includes(id))fail('duplicate_or_excluded');all.add(id);}
  const fields=new Set();for(const c of p.changes){if(!ALLOWED.has(c.attribute)||fields.has(c.attribute)||!c.value||c.payload?.id!==c.attribute||Object.keys(c.payload).some(k=>!['id','value_id','value_name'].includes(k)))fail('invalid_approved_change');fields.add(c.attribute);count++;}
 }
 if(count!==280||all.size!==200)fail('wrong_authorized_scope');return m;
}
export function identity(i,p,peer=false){
 if(!i||i.id!==(peer?p.peers[0].id:p.id)||String(i.seller_id)!==SELLER||i.status!=='active'||i.category_id!=='MLU1196'||i.user_product_id!==p.up||!Array.isArray(i.attributes)||!Array.isArray(i.variations)||i.variations.length||i.catalog_listing!==(peer?p.peers[0].catalog_listing:false))fail('item_identity_or_status_changed');
 const isbns=i.attributes.filter(a=>['GTIN','ISBN'].includes(a.id)).flatMap(a=>[a.value_name,...(a.values??[]).map(v=>v.name)]).filter(Boolean);
 if(!isbns.length||isbns.some(v=>normalizeValidIsbn(v)!==p.isbn))fail('isbn_changed_or_ambiguous');
}
export function payloadFor(p,items,schema){
 const ready=[],skipped=[];
 for(const c of p.changes){
  const states=items.map(i=>state(i,c));
  if(states.some(s=>!['missing','matches'].includes(s))){skipped.push({attribute:c.attribute,reason:'existing_or_na_value',states});continue;}
  if(states[0]==='matches'){skipped.push({attribute:c.attribute,reason:states.every(s=>s==='matches')?'already_matches':'target_present_peer_missing',states});continue;}
  const f=schema.find(f=>f.id===c.attribute);if(!f||['read_only','hidden','fixed'].some(t=>f.tags?.[t])||c.value.length>(f.value_max_length??10000))fail('schema_changed');
  const v=f.values?.find(v=>norm(v.name)===norm(c.value));let payload;
  if(v)payload={id:c.attribute,value_id:v.id};
  else {if(!['string','number'].includes(f.value_type)||c.attribute==='LANGUAGE')fail('value_not_in_schema');if(['PUBLICATION_YEAR','PAGES_NUMBER'].includes(c.attribute)&&!(/^[1-9]\d*$/.test(c.value)))fail('invalid_number');payload={id:c.attribute,value_name:c.value};}
  if(canonical(payload)!==canonical(c.payload))fail('approved_schema_payload_changed');ready.push({...c,payload});
 }
 return {ready,skipped};
}
const protectedFields=['title','price','base_price','original_price','currency_id','sale_terms','shipping','warranty','listing_type_id','condition','status','family_name','category_id','catalog_listing','catalog_product_id','user_product_id','available_quantity','variations'];
export function snapshot(items,descriptions,changes){
 const allowed=new Set(changes.map(c=>c.attribute));return items.map((i,n)=>({id:i.id,protected:Object.fromEntries(protectedFields.map(k=>[k,i[k]??null])),description:descriptions[n],other_attributes:i.attributes.filter(a=>!allowed.has(a.id)).map(a=>({id:a.id,value_id:a.value_id??null,value_name:a.value_name??null,value_struct:a.value_struct??null,values:a.values??null})).sort((a,b)=>a.id.localeCompare(b.id))}));
}
export function snapshotKey(value){
 const authorName=v=>v==null?v:norm(v).replace(/\./g,'').replace(/\s+/g,' ');
 const internalId=(id,name)=>name!=null&&String(name).trim()!==''&&String(id)!=='-1'?null:id;
 return canonical(value.map(i=>({...i,protected:{...i.protected,sale_terms:Array.isArray(i.protected.sale_terms)?[...i.protected.sale_terms].sort((a,b)=>a.id.localeCompare(b.id)):i.protected.sale_terms},...(i.other_attributes?{other_attributes:i.other_attributes.map(a=>({...a,value_id:internalId(a.value_id,a.value_name),value_name:a.id==='AUTHOR'?authorName(a.value_name):a.value_name,values:a.values?.map(v=>({...v,id:internalId(v.id,v.name),name:a.id==='AUTHOR'?authorName(v.name):v.name}))??null}))}:{})})));
}
export function createEngine({ml,receipts,wait=ms=>new Promise(r=>setTimeout(r,ms))}){
 async function inspect(p){
  const expected=[p.id,...p.peers.map(x=>x.id)].sort(),queries=[];
  for(const status of ['', 'active','paused','closed','under_review']){
   const found=new Set();let total;
   for(let offset=0;;offset+=100){const q=new URLSearchParams({user_product_id:p.up,limit:'100',offset:String(offset)});if(status)q.set('status',status);const b=await ml(`/users/${SELLER}/items/search?${q}`),t=checkPage(b,offset);if(total!==undefined&&total!==t)fail('group_changed');total=t;for(const id of b.results){if(found.has(id))fail('duplicate_group_result');found.add(id);}if(found.size===total)break;}
   if(canonical([...found].sort())!==canonical(['','active'].includes(status)?expected:[]))fail('authorized_group_changed');queries.push({status:status||'all',ids:[...found],complete:true});
  }
  const items=[],descriptions=[];for(const [n,id] of expected.entries()){const i=await ml(`/items/${id}?include_internal_attributes=true`);identity(i,p,id!==p.id);items.push(i);const d=await ml(`/items/${id}/description`);if(d!==null&&typeof d?.plain_text!=='string')fail('description_unavailable');descriptions.push(d?.plain_text??null);}
  // The target must always be first, independent of lexical ID ordering.
  const order=[p.id,...p.peers.map(x=>x.id)];return {items:order.map(id=>items.find(i=>i.id===id)),descriptions:order.map(id=>descriptions[items.findIndex(i=>i.id===id)]),queries,at:new Date().toISOString()};
 }
 async function plan(p){const before=await inspect(p),schema=await ml('/categories/MLU1196/attributes');if(!Array.isArray(schema)||!schema.length)fail('empty_schema');return {...before,...payloadFor(p,before.items,schema)};}
 async function verify(p,r){const b=JSON.parse(r.before_json),after=await inspect(p);if(snapshotKey(snapshot(after.items,after.descriptions,b.ready))!==snapshotKey(b.snapshot))fail('protected_or_other_attributes_changed');if(after.items.some(i=>b.ready.some(c=>state(i,c)!=='matches')))fail('shared_values_not_persisted');return {id:p.id,state:'verified',attributes:b.ready.map(c=>c.attribute),items:after.items.map(i=>i.id),protected_fields_unchanged:true,verified_at:new Date().toISOString()};}
 async function repair(p,b,retried=false){
  const after=await inspect(p);
  if(snapshotKey(snapshot(after.items,after.descriptions,b.ready))!==snapshotKey(b.snapshot))fail('protected_or_other_attributes_changed');
  if(b.ready.some(c=>state(after.items[0],c)!=='matches'))fail('target_values_not_persisted_no_retry');
  const peer=after.items[1],missing=b.ready.filter(c=>state(peer,c)==='missing');
  if(b.ready.some(c=>!['matches','missing'].includes(state(peer,c))))fail('peer_value_conflict');
  if(!missing.length)return;
  // A separate receipt guards the explicitly named catalog peer. This edits only
  // this seller's item; no catalog product or global/user-product write endpoint.
  const old=await receipts.read(peer.id);
  const schema=await ml('/categories/MLU1196/attributes');
  if(!Array.isArray(schema)||!schema.length)fail('empty_schema');
  const check=payloadFor({...p,changes:missing},[peer,after.items[0]],schema);
  if(check.ready.length!==missing.length)fail('peer_preflight_changed');
  const body={attributes:check.ready.map(c=>c.payload)};
  if(old){const info=JSON.parse(old.result_json??'{}');if(info.error!=='ml_put_http_409'||info.retry_count||!receipts.retry409||!await receipts.retry409(peer.id,body))fail('peer_prior_attempt_no_retry');retried=true;}
  else if(!await receipts.claim(peer.id,{...b,write_id:peer.id,peer_request_body:body}))fail('peer_claim_failed');
  try{await ml(`/items/${peer.id}`,'PUT',body);let v;for(let n=0;n<8;n++){try{v=await verify(p,{before_json:JSON.stringify(b)});break;}catch(e){if(e.message!=='shared_values_not_persisted'||n===7)throw e;await wait(5000);}}await receipts.save(peer.id,'verified',{...v,accepted_request_body:body,retry_count:retried?1:0});}
  catch(e){await receipts.save(peer.id,'uncertain_no_retry',{error:e.message,retry_count:retried?1:0});if(e.message==='ml_put_http_409'&&!retried){await wait(5000);return repair(p,b,true);}throw e;}
 }
 return {inspect,plan,verify,repair,async apply(p,preflight){
  const prior=await receipts.read(p.id);if(prior){if(prior.state!=='verified')fail('prior_uncertain_operation_requires_verification');await verify(p,prior);return {id:p.id,state:'prior_verified_no_retry',receipt_state:prior.state};}
  const b=await plan(p);if(!b.ready.length)return {id:p.id,state:'skipped',skipped:b.skipped};
  if(canonical(b.ready)!==canonical(preflight.ready)||snapshotKey(snapshot(b.items,b.descriptions,b.ready))!==snapshotKey(snapshot(preflight.items,preflight.descriptions,preflight.ready)))return {id:p.id,state:'blocked',reason:'changed_since_preflight'};
  const backup={...b,snapshot:snapshot(b.items,b.descriptions,b.ready),request_body:{attributes:b.ready.map(c=>c.payload)},review_hash:HASH};
  if(!await receipts.claim(p.id,backup))return {id:p.id,state:'prior_attempt_no_retry'};
  try{
   // One target PUT only, with precisely the approved, still-missing attributes.
   // Shared values in the authorized peer are observed; never write global Catalog.
   const response=await ml(`/items/${p.id}`,'PUT',backup.request_body);
   await receipts.save(p.id,'put_accepted_pending_verification',{http_accepted:true,response});
    let result;
    try{result=await verify(p,{before_json:JSON.stringify(backup)});}
    catch(e){if(e.message!=='shared_values_not_persisted')throw e;await repair(p,backup);result=await verify(p,{before_json:JSON.stringify(backup)});}
   await receipts.save(p.id,'verified',result);return result;
  }catch(e){await receipts.save(p.id,'uncertain_no_retry',{error:e.message});throw e;}
 }};
}
async function main(){
 const mode=process.argv[2],dir=process.argv[3];if(!['preflight','apply','repair','verify','export'].includes(mode)||!dir)fail('invalid_mode');
 const manifest=validateManifest(JSON.parse(await fs.readFile(new URL('./approved-hundred-manifest.json',import.meta.url),'utf8')));
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
 const engine=createEngine({ml,receipts});
 if(mode==='preflight'){
  const report={review_hash:HASH,started_at:new Date().toISOString(),items:[],complete:false};
  for(const p of manifest.approved){try{const b=await engine.plan(p);report.items.push({id:p.id,state:'eligible',...b});}catch(e){report.items.push({id:p.id,state:'blocked',reason:e.message});}await fs.writeFile(dir+'/preflight.json',JSON.stringify(report,null,2));if(report.items.length%10===0)console.log('Preflight:',report.items.length);}
  report.complete=report.items.length===100;report.completed_at=new Date().toISOString();await fs.writeFile(dir+'/preflight.json',JSON.stringify(report,null,2));console.log(JSON.stringify({eligible:report.items.filter(i=>i.state==='eligible').length,attributes:report.items.reduce((n,i)=>n+(i.ready?.length??0),0),blocked:report.items.filter(i=>i.state==='blocked').length}));return;
 }
 if(['apply','repair'].includes(mode)&&process.env.AUTHORIZED_REVIEW_HASH!==HASH)fail('apply_not_authorized');
 if(mode==='apply')await sql(`CREATE TABLE IF NOT EXISTS ${TABLE}(item_id TEXT PRIMARY KEY,state TEXT NOT NULL,before_json TEXT NOT NULL,result_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`);
 const summary={mode,review_hash:HASH,results:[],stopped:null};
 try{
  if(mode==='apply'){
   const pre=JSON.parse(await fs.readFile(dir+'/preflight.json','utf8'));if(pre.review_hash!==HASH||!pre.complete||pre.items.length!==100||Date.now()-Date.parse(pre.completed_at)>1200000)fail('invalid_or_stale_preflight');
   for(const p of manifest.approved){const b=pre.items.find(i=>i.id===p.id);if(b.state!=='eligible'){summary.results.push({id:p.id,state:'blocked',reason:b.reason});continue;}try{summary.results.push(await engine.apply(p,b));}catch(e){summary.results.push({id:p.id,state:'uncertain_no_retry',reason:e.message});throw e;}await fs.writeFile(dir+'/apply-summary.json',JSON.stringify(summary,null,2));console.log('Processed:',summary.results.length,summary.results.at(-1).state);}
  }else if(['verify','repair'].includes(mode))for(const p of manifest.approved){const r=await receipts.read(p.id);if(!r)continue;if(mode==='repair')await engine.repair(p,JSON.parse(r.before_json));const v=await engine.verify(p,r);await receipts.save(p.id,'verified',v);for(const peer of p.peers)if(await receipts.read(peer.id))await receipts.save(peer.id,'verified',v);summary.results.push(v);}
 }catch(e){summary.stopped=e.message;process.exitCode=1;}
 finally{
  if(mode!=='export')await fs.writeFile(dir+'/'+mode+'-summary.json',JSON.stringify({...summary,completed_at:new Date().toISOString()},null,2));
  const all=await sql(`SELECT * FROM ${TABLE}`);await fs.writeFile(dir+'/receipts.json',JSON.stringify(all,null,2));
  if(mode==='export')for(const r of all){const p=manifest.approved.find(p=>[p.id,...p.peers.map(x=>x.id)].includes(r.item_id));if(!p)fail('unexpected_receipt');const b=JSON.parse(r.before_json),after=await engine.inspect(p);await fs.writeFile(dir+'/'+r.item_id+'-after.json',JSON.stringify({...after,states:after.items.map(i=>({id:i.id,attributes:b.ready.map(c=>({id:c.attribute,expected:c.value,state:state(i,c),actual:i.attributes.filter(a=>a.id===c.attribute)}))})),protected_unchanged:snapshotKey(snapshot(after.items,after.descriptions,b.ready))===snapshotKey(b.snapshot)},null,2));}
  console.log(JSON.stringify({mode,processed:summary.results.length,verified:summary.results.filter(x=>x.state==='verified').length,stopped:summary.stopped}));
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{console.error(/^[a-z0-9_]+$/.test(e.message)?e.message:'operation_failed_credentials_redacted');process.exitCode=1;});
