import {normalizeValidIsbn} from '../../functions/_shared/showcase-ranking.js';
import {APPROVED} from './approved-twenty-manifest.mjs';
export {APPROVED};
const SELLER='440298103',APP='4741021817925208',TABLE='amado_attributes_twenty_20261021';
const fail=code=>{throw Error(code);};
const canonical=value=>JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
const protectedFields=['title','price','base_price','original_price','currency_id','sale_terms','shipping','warranty','listing_type_id','condition','status','family_name','category_id','catalog_listing','catalog_product_id','user_product_id','available_quantity','variations'];
const policy=id=>APPROVED.find(p=>p.id===id)||fail('item_not_approved');
export function snapshot(item,description,changes){
 const allowed=new Set(changes.map(c=>c.attribute));
 return {protected:Object.fromEntries(protectedFields.map(k=>[k,item[k]??null])),description,other_attributes:item.attributes.filter(a=>!allowed.has(a.id)).map(a=>({id:a.id,value_id:a.value_id??null,value_name:a.value_name??null,value_struct:a.value_struct??null,values:a.values??null})).sort((a,b)=>a.id.localeCompare(b.id))};
}
function valueState(item,c){
 const entries=item.attributes.filter(a=>a.id===c.attribute);
 if(!entries.length)return 'missing';
 if(entries.some(a=>String(a.value_id)==='-1'||a.values?.some(v=>String(v.id)==='-1')))return 'not_applicable';
 const values=[...new Set(entries.flatMap(a=>[a.value_name,...(a.values||[]).map(v=>v.name)]).filter(v=>v!=null&&String(v).trim()!=='').map(String))];
 if(values.length===1&&values[0]===c.value)return 'matches';
 // Un atributo presente pero vacío no se asume faltante durante la aplicación.
 return 'present';
}
export function checkItem(item,p){
 if(!item||item.id!==p.id||String(item.seller_id)!==SELLER)fail('wrong_seller_or_item');
 if(item.status!=='active'||item.category_id!=='MLU1196'||item.catalog_listing!==false)fail('not_active_own_book');
 if(item.user_product_id!==p.up||!Array.isArray(item.variations)||item.variations.length)fail('changed_user_product_or_variations');
 if(!Array.isArray(item.attributes))fail('attributes_unavailable');
 const raw=item.attributes.filter(a=>['GTIN','ISBN'].includes(a.id)).flatMap(a=>[a.value_name,...(a.values||[]).map(v=>v.name)]).filter(Boolean);
 if(!raw.length||raw.some(v=>normalizeValidIsbn(v)!==p.isbn))fail('isbn_changed_or_ambiguous');
 const states=p.changes.map(c=>({...c,state:valueState(item,c)}));
 if(states.some(c=>!['missing','matches'].includes(c.state)))fail('attribute_'+states.find(c=>!['missing','matches'].includes(c.state)).state);
 return states;
}
export function checkGroup(page,p,status){
 if(!page||String(page.seller_id)!==SELLER||!Array.isArray(page.results)||!Number.isInteger(page.paging?.total)||page.paging.total!==page.results.length)fail('incomplete_up_search');
 if(page.results.some(id=>id!==p.id)||new Set(page.results).size!==page.results.length)fail('other_items_share_up');
 if((!status||status==='active')&&(page.paging.total!==1||page.results[0]!==p.id))fail('own_item_missing_from_up_search');
}
function dbReceipts(db){
 const stmt=(sql,...args)=>db.prepare(sql).bind(...args);
 return {
  ensure:()=>db.prepare(`CREATE TABLE IF NOT EXISTS ${TABLE}(item_id TEXT PRIMARY KEY,state TEXT NOT NULL,before_json TEXT NOT NULL,result_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`).run(),
  read:id=>stmt(`SELECT * FROM ${TABLE} WHERE item_id=?`,id).first(),
  claim:async(id,before)=>!!await stmt(`INSERT OR IGNORE INTO ${TABLE}(item_id,state,before_json,created_at,updated_at) VALUES(?,'attempting',?,?,?) RETURNING item_id`,id,JSON.stringify(before),new Date().toISOString(),new Date().toISOString()).first(),
  save:(id,state,result)=>stmt(`UPDATE ${TABLE} SET state=?,result_json=?,updated_at=? WHERE item_id=?`,state,JSON.stringify(result),new Date().toISOString(),id).run(),
 };
}
export function createTwentyPilot({fetcher=fetch,receipts,tokenProvider,wait=ms=>new Promise(r=>setTimeout(r,ms))}){
 async function ml(path,method='GET',body){
  const token=await tokenProvider();
  const res=await fetcher('https://api.mercadolibre.com'+path,{method,redirect:'manual',signal:AbortSignal.timeout(15000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  if(res.status===404&&path.endsWith('/description'))return null;
  if(!res.ok)fail('meli_http_'+res.status);
  return res.json();
 }
 async function inspect(p){
  const item=await ml(`/items/${p.id}?include_internal_attributes=true`),states=checkItem(item,p);
  for(const status of ['', 'active','paused','closed','under_review']){
   const query=new URLSearchParams({user_product_id:p.up,limit:'100'});if(status)query.set('status',status);
   checkGroup(await ml(`/users/${SELLER}/items/search?${query}`),p,status);
  }
  const desc=await ml(`/items/${p.id}/description`);
  if(desc!==null&&typeof desc.plain_text!=='string')fail('description_unavailable');
  return {item,states,description:desc?.plain_text??null};
 }
 async function schema(p,states){
  const fields=await ml('/categories/MLU1196/attributes');
  if(!Array.isArray(fields)||!fields.length)fail('category_schema_unavailable');
  return states.filter(c=>c.state==='missing').map(c=>{
   const f=fields.find(a=>a.id===c.attribute);
   if(!f||f.tags?.read_only||f.tags?.hidden||f.tags?.fixed)fail('attribute_not_writable');
   if(Number.isInteger(f.value_max_length)&&c.value.length>f.value_max_length)fail('attribute_too_long');
   if(['PUBLICATION_YEAR','PAGES_NUMBER'].includes(c.attribute)){
    if(!/^[1-9]\d*$/.test(c.value)||!['number','number_unit','string'].includes(f.value_type))fail('numeric_attribute_type_changed');
    if(f.value_type==='number_unit')fail('numeric_unit_requires_review');
   }
   const match=f.values?.find(v=>v.name===c.value);
   if(match)return {id:c.attribute,value_id:match.id};
   if(f.value_type==='list'||c.attribute==='LANGUAGE')fail('value_not_in_category');
   if(!['string','number'].includes(f.value_type))fail('attribute_type_requires_review');
   return {id:c.attribute,value_name:c.value};
  });
 }
 async function receipt(id){policy(id);await receipts.ensure();return {id,receipt:await receipts.read(id)};}
 async function verify(id){
  const p=policy(id),r=await receipts.read(id);if(!r)fail('receipt_missing');
  const before=JSON.parse(r.before_json),after=await inspect(p);
  if(after.states.some(c=>c.state!=='matches'))fail('proposed_value_not_persisted');
  if(canonical(snapshot(after.item,after.description,p.changes))!==canonical(before.snapshot))fail('protected_fields_or_other_attributes_changed');
  return {id,state:'verified',changes:p.changes,other_items:[],protected_fields_unchanged:true,verified_at:new Date().toISOString()};
 }
 return {
  receipt,verify,
  async report(id){const p=policy(id),r=await inspect(p),attributes=await schema(p,r.states);return {id,state:attributes.length?'eligible':'already_matches',attributes,states:r.states,item:r.item,description:r.description,other_items:[]};},
  async apply(id){
   const p=policy(id);await receipts.ensure();
   const prior=await receipts.read(id);if(prior)return {id,state:'prior_attempt_no_retry',receipt:prior};
   const before=await inspect(p),attributes=await schema(p,before.states);
   if(!attributes.length)return {id,state:'already_matches',changes:p.changes};
   const again=await inspect(p),frozen=snapshot(before.item,before.description,p.changes);
   if(canonical(again.states)!==canonical(before.states)||canonical(snapshot(again.item,again.description,p.changes))!==canonical(frozen))fail('item_changed_during_preflight');
   const body={attributes},backup={item:before.item,description:before.description,snapshot:frozen,request_body:body,isbn:p.isbn,user_product_id:p.up,approved_changes:p.changes};
   if(!await receipts.claim(id,backup))return {id,state:'concurrent_attempt_blocked'};
   try{
    // Una escritura por ítem, exclusivamente los atributos faltantes autorizados.
    await ml(`/items/${p.id}`,'PUT',body);
    let result;
    for(let attempt=0;attempt<5;attempt++){try{result=await verify(id);break;}catch(e){if(e.message!=='proposed_value_not_persisted'||attempt===4)throw e;await wait(2000);}}
    await receipts.save(id,'verified',result);return result;
   }catch(e){await receipts.save(id,'uncertain_no_retry',{id,state:'uncertain_no_retry',error:e.message});throw e;}
  },
 };
}
export default {async fetch(request,env){
 if(!env.PILOT_SECRET||request.headers.get('authorization')!=='Bearer '+env.PILOT_SECRET)return Response.json({error:'unauthorized'},{status:401});
 const expires=Number(env.PILOT_EXPIRES_AT);if(!Number.isFinite(expires)||expires<=Date.now()||expires-Date.now()>1200000)return Response.json({error:'operation_expired'},{status:410});
 try{
  if(request.method!=='POST')fail('post_required');
  const action=new URL(request.url).pathname.slice(1);if(!['report','apply','verify','receipt'].includes(action))fail('unknown_action');
  if(action==='apply'&&env.PILOT_APPLY!=='true')fail('apply_not_enabled');
  const body=await request.json();if(!body||Object.keys(body).length!==1||typeof body.id!=='string')fail('invalid_request');
  const engine=createTwentyPilot({receipts:dbReceipts(env.ORDERS_DB),tokenProvider:async()=>{
   const row=await env.ORDERS_DB.prepare('SELECT access_token,access_expires_at FROM ml_oauth WHERE app_id=?').bind(APP).first();
   if(!row?.access_token||row.access_expires_at-Date.now()<300000)fail('existing_oauth_token_needs_refresh');
   return row.access_token;
  }});
  return Response.json(await engine[action](body.id),{headers:{'Cache-Control':'no-store'}});
 }catch(e){return Response.json({state:'blocked_or_stopped',error:typeof e.message==='string'&&/^[a-z0-9_]+$/.test(e.message)?e.message:'request_failed'},{status:409});}
}};
