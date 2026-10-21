// Operación puntual autorizada por Seba: tres años y un idioma. No es un
// cargador general. Worker temporal, sin cron ni colas, que se elimina al acabar.
import { normalizeValidIsbn } from '../../functions/_shared/showcase-ranking.js';
export const APPROVED = Object.freeze([
  {id:'MLU683126476',isbn:'9788422633440',up:'MLUU2446601654',attribute:'PUBLICATION_YEAR',value:'1990'},
  {id:'MLU925948404',isbn:'9788434431911',up:'MLUU3529581890',attribute:'PUBLICATION_YEAR',value:'2020'},
  {id:'MLU1317435246',isbn:'9788408167761',up:'MLUU3900032029',attribute:'PUBLICATION_YEAR',value:'2017'},
  {id:'MLU1488351638',isbn:'9788428815321',up:'MLUU4825915017',attribute:'LANGUAGE',value:'Español'},
].map(Object.freeze));
const APP='4741021817925208', SELLER='440298103';
const TABLE='amado_attribute_pilot_four_20261020';
const fail=code=>{throw new Error(code);};
const canonical=value=>JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
const protectedFields=['title','price','base_price','original_price','currency_id','sale_terms','shipping','warranty','listing_type_id','condition','status','family_name','category_id','catalog_listing','user_product_id'];
export function snapshot(item,description,attribute){
  return {protected:Object.fromEntries(protectedFields.map(k=>[k,item[k]??null])),description,
    other_attributes:item.attributes.filter(a=>a.id!==attribute).map(a=>({id:a.id,value_id:a.value_id??null,value_name:a.value_name??null,value_struct:a.value_struct??null,values:a.values??null})).sort((a,b)=>a.id.localeCompare(b.id))};
}
function valueState(item,p){
  const entries=item.attributes.filter(a=>a.id===p.attribute);
  if(!entries.length)return 'missing';
  if(entries.some(a=>String(a.value_id)==='-1'||a.values?.some(v=>String(v.id)==='-1')))return 'not_applicable';
  const values=[...new Set(entries.flatMap(a=>[a.value_name,...(a.values||[]).map(v=>v.name)]).filter(v=>v!=null).map(String))];
  return values.length===1&&values[0]===p.value?'matches':'present';
}
export function checkItem(item,p){
  if(item.id!==p.id||String(item.seller_id)!==SELLER)fail('wrong_seller_or_item');
  if(item.status!=='active'||item.category_id!=='MLU1196'||item.catalog_listing!==false)fail('not_active_own_book');
  if(item.user_product_id!==p.up||!Array.isArray(item.variations)||item.variations.length)fail('changed_user_product_or_variations');
  if(!Array.isArray(item.attributes))fail('attributes_unavailable');
  const raw=item.attributes.filter(a=>['GTIN','ISBN'].includes(a.id)).flatMap(a=>[a.value_name,...(a.values||[]).map(v=>v.name)]).filter(Boolean);
  if(!raw.length||raw.some(v=>normalizeValidIsbn(v)!==p.isbn))fail('isbn_changed_or_ambiguous');
  const state=valueState(item,p);
  if(!['missing','matches'].includes(state))fail('attribute_'+state);
  return state;
}
export function checkGroup(page,p,expectedStatus){
  if(String(page.seller_id)!==SELLER||!Array.isArray(page.results)||!Number.isInteger(page.paging?.total)||page.paging.total!==page.results.length)fail('incomplete_up_search');
  if(page.results.some(id=>id!==p.id)||new Set(page.results).size!==page.results.length)fail('other_items_share_up');
  if((!expectedStatus||expectedStatus==='active')&&(page.paging.total!==1||page.results[0]!==p.id))fail('own_item_missing_from_up_search');
}
function dbReceipts(db){
  const stmt=(sql,...args)=>db.prepare(sql).bind(...args);
  return {
    async receipt(id){policy(id);await receipts.ensure();return {id,receipt:await receipts.read(id)};},
    async ensure(){await db.prepare(`CREATE TABLE IF NOT EXISTS ${TABLE}(item_id TEXT PRIMARY KEY,state TEXT NOT NULL,before_json TEXT NOT NULL,result_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`).run();},
    read:id=>stmt(`SELECT * FROM ${TABLE} WHERE item_id=?`,id).first(),
    claim:async(id,before)=>!!await stmt(`INSERT OR IGNORE INTO ${TABLE}(item_id,state,before_json,created_at,updated_at) VALUES(?,'attempting',?,?,?) RETURNING item_id`,id,JSON.stringify(before),new Date().toISOString(),new Date().toISOString()).first(),
    save:(id,state,result)=>stmt(`UPDATE ${TABLE} SET state=?,result_json=?,updated_at=? WHERE item_id=?`,state,JSON.stringify(result),new Date().toISOString(),id).run(),
  };
}
export function createFourPilot({fetcher=fetch,receipts,tokenProvider,wait=ms=>new Promise(r=>setTimeout(r,ms))}){
  async function ml(path,method='GET',body){
    const token=await tokenProvider();
    const res=await fetcher('https://api.mercadolibre.com'+path,{method,redirect:'manual',signal:AbortSignal.timeout(15000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    if(res.status===404&&path.endsWith('/description'))return null;
    if(!res.ok)fail('meli_http_'+res.status);
    return res.json();
  }
  async function group(p){
    // Sin filtro de estado y, adicionalmente, los cuatro estados por separado.
    // Cada respuesta debe ser completa. Un aviso pausado/cerrado también bloquea.
    for(const status of ['', 'active','paused','closed','under_review']){
      const query=new URLSearchParams({user_product_id:p.up,limit:'100'});
      if(status)query.set('status',status);
      checkGroup(await ml(`/users/${SELLER}/items/search?${query}`),p,status);
    }
  }
  async function inspect(p){
    const item=await ml(`/items/${p.id}?include_internal_attributes=true`);
    const state=checkItem(item,p);
    await group(p);
    const desc=await ml(`/items/${p.id}/description`);
    if(desc!==null&&typeof desc.plain_text!=='string')fail('description_unavailable');
    return {item,state,description:desc?.plain_text??null};
  }
  async function schema(p){
    const fields=await ml('/categories/MLU1196/attributes');
    if(!Array.isArray(fields))fail('category_schema_unavailable');
    const field=fields.find(a=>a.id===p.attribute);
    if(!field||field.tags?.read_only||field.tags?.hidden||field.tags?.fixed)fail('attribute_not_writable');
    if(p.attribute==='PUBLICATION_YEAR'&&!['number','number_unit','string'].includes(field.value_type))fail('year_type_changed');
    if(p.attribute==='LANGUAGE'){
      const match=field.values?.find(v=>v.name===p.value);
      if(!match)fail('language_not_in_category');
      return {id:p.attribute,value_id:match.id};
    }
    return {id:p.attribute,value_name:p.value};
  }
  function policy(id){return APPROVED.find(p=>p.id===id)||fail('item_not_approved');}
  async function verify(id){
    const p=policy(id),receipt=await receipts.read(id);
    if(!receipt)fail('receipt_missing');
    const before=JSON.parse(receipt.before_json),after=await inspect(p);
    if(after.state!=='matches')fail('proposed_value_not_persisted');
    if(canonical(snapshot(after.item,after.description,p.attribute))!==canonical(before.snapshot))fail('protected_fields_or_other_attributes_changed');
    return {id,state:'verified',attribute:p.attribute,value:p.value,other_items:[],protected_fields_unchanged:true,verified_at:new Date().toISOString()};
  }
  return {
    async report(id){const p=policy(id),data=await inspect(p);const attribute=await schema(p);return {id,state:data.state==='matches'?'already_matches':'eligible',attribute,proposed:p.value,item:data.item,description:data.description,other_items:[]};},
    verify,
    async apply(id){
      const p=policy(id);
      await receipts.ensure();
      const prior=await receipts.read(id);
      if(prior)return {id,state:'prior_attempt_no_retry',receipt:prior};
      const before=await inspect(p),attribute=await schema(p);
      if(before.state==='matches')return {id,state:'already_matches',attribute:p.attribute,value:p.value};
      const again=await inspect(p);
      const frozen=snapshot(before.item,before.description,p.attribute);
      if(again.state!=='missing'||canonical(snapshot(again.item,again.description,p.attribute))!==canonical(frozen))fail('item_changed_during_preflight');
      const body={attributes:[attribute]};
      const backup={item:before.item,description:before.description,snapshot:frozen,request_body:body,isbn:p.isbn,user_product_id:p.up};
      if(!await receipts.claim(id,backup))return {id,state:'concurrent_attempt_blocked'};
      try{
        // ÚNICA escritura a MLU: un atributo de un ID fijo. Sin títulos, precios,
        // descripciones, sale_terms, stock ni rutas de Catálogo/familias.
        await ml(`/items/${p.id}`,'PUT',body);
        let result;
        for(let attempt=0;attempt<5;attempt++){
          try{result=await verify(id);break;}catch(e){if(e.message!=='proposed_value_not_persisted'||attempt===4)throw e;await wait(2000);}
        }
        await receipts.save(id,'verified',result);
        return result;
      }catch(e){await receipts.save(id,'uncertain_no_retry',{id,state:'uncertain_no_retry',error:e.message});throw e;}
    },
  };
}
export default {async fetch(request,env){
  if(!env.PILOT_SECRET||request.headers.get('authorization')!=='Bearer '+env.PILOT_SECRET)return Response.json({error:'unauthorized'},{status:401});
  const expires=Number(env.PILOT_EXPIRES_AT);
  if(!Number.isFinite(expires)||expires<=Date.now()||expires-Date.now()>1200000)return Response.json({error:'operation_expired'},{status:410});
  try{
    if(request.method!=='POST')fail('post_required');
    const action=new URL(request.url).pathname.slice(1);
    if(!['report','apply','verify','receipt'].includes(action))fail('unknown_action');
    if(action==='apply'&&env.PILOT_APPLY!=='true')fail('apply_not_enabled');
    const body=await request.json();
    if(Object.keys(body).length!==1||typeof body.id!=='string')fail('invalid_request');
    const receipts=dbReceipts(env.ORDERS_DB);
    const engine=createFourPilot({receipts,tokenProvider:async()=>{
      // Credencial existente usada dentro del servidor; nunca sale del Worker,
      // no se exporta a Actions, no se renueva ni se altera la tabla OAuth.
      const row=await env.ORDERS_DB.prepare('SELECT access_token,access_expires_at FROM ml_oauth WHERE app_id=?').bind(APP).first();
      if(!row?.access_token||row.access_expires_at-Date.now()<300000)fail('existing_oauth_token_needs_refresh');
      return row.access_token;
    }});
    return Response.json(await engine[action](body.id),{headers:{'Cache-Control':'no-store'}});
  }catch(e){return Response.json({state:'blocked_or_stopped',error:typeof e.message==='string'&&/^[a-z0-9_]+$/.test(e.message)?e.message:'request_failed'},{status:409});}
}};
