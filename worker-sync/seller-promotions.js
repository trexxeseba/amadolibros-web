// Promociones de Amado Libros por la API de Mercado Libre (seller-promotions v2).
// POST /meli-promos, detrás de SYNC_SECRET. Es el camino de respaldo cuando las
// tareas programadas no tienen Chrome: la decisión (qué sacar, qué sumar) la toma
// scripts/mercadolibre/promos.mjs; este módulo solo habla con Mercado Libre y
// aplica los frenos que no se rompen aunque el script falle:
//
//   - Lectura (status, promo_items, item_promos): solo GET.
//   - Escritura (remove, join_lightning): exigen confirm === true en el pedido.
//   - remove: solo DELETE de una publicación en una promoción. Nunca PUT, nunca
//     precio, estado, pausa ni borrado de la publicación.
//   - Cupones y publicidad: se rechazan por tipo, no se leen para escribir.
//   - join_lightning: solo tipo LIGHTNING, precio entero y nunca mayor al actual,
//     stock entre 1 y lo disponible.
//
// Cada invocación hace pocas llamadas a Mercado Libre (límite de subrequests del
// Worker): una página de promociones, hasta 20 publicaciones o hasta 10 escrituras.
import {getAccessToken} from './meli-auth.js';
import {bulkItemsPath,bulkEntryItem} from './meli-bulk.js';

export const PROMOS_SELLER_ID='440298103';
const ML_ORIGIN='https://api.mercadolibre.com';
const MAX_READ_IDS=20,MAX_WRITES=10,PAGE_LIMIT=50;
const ID_RE=/^MLU\d+$/,PROMO_ID_RE=/^[A-Za-z0-9_-]{1,64}$/,TYPE_RE=/^[A-Z][A-Z0-9_]{1,40}$/;
// Cupones y publicidad no se tocan nunca desde acá.
const BLOCKED_TYPE_RE=/COUPON|CUPON|ADVERT|(^|_)ADS($|_)|PUBLICIDAD/i;
const PROMO_FIELDS=['id','type','status','name','start_date','finish_date','price','original_price','meli_percentage','seller_percentage','offer_id','min_discounted_price','max_discounted_price','suggested_discounted_price','min_discount_percentage','min_stock','max_stock','suggested_stock','fixed_amount','discount_amount','amount','discount_percentage','percentage'];
const ITEM_ROW_FIELDS=['id','status','price','original_price','meli_percentage','seller_percentage','offer_id','start_date','end_date','finish_date','stock'];

class PromoError extends Error{constructor(message,status=502){super(message);this.status=status;}}
const reply=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const pick=(source,fields)=>{const out={};if(source&&typeof source==='object')for(const f of fields)if(source[f]!==undefined)out[f]=source[f];return out;};
const asList=json=>Array.isArray(json)?json:Array.isArray(json?.results)?json.results:[];
const mlError=status=>status===401?'ml_unauthorized':status===403?'ml_forbidden':status===404?'ml_not_found':status===429?'ml_rate_limited':'ml_error';
const validIds=ids=>Array.isArray(ids)&&ids.length>0&&ids.length<=MAX_READ_IDS&&ids.every(id=>typeof id==='string'&&ID_RE.test(id));

export function createSellerPromotions({fetcher=(...args)=>globalThis.fetch(...args),tokenProvider=getAccessToken}={}){
 async function ml(method,path,token,body){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  let res;
  try{
   res=await fetcher(ML_ORIGIN+path,{method,headers:{Authorization:`Bearer ${token}`,Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'manual',signal:controller.signal});
  }catch{throw new PromoError('No se pudo conectar con Mercado Libre. Reintentá.');}
  finally{clearTimeout(timer);}
  let json=null;
  try{json=await res.json();}catch{json=null;}
  return {status:res.status,ok:res.ok,json};
 }
 const failure=r=>({ok:false,ml_status:r.status,error:mlError(r.status)});

 async function status(token){
  const r=await ml('GET',`/seller-promotions/users/${PROMOS_SELLER_ID}?app_version=v2`,token);
  if(!r.ok)return {read_only:true,...failure(r)};
  return {read_only:true,ok:true,ml_status:r.status,promotions:asList(r.json).map(p=>pick(p,PROMO_FIELDS))};
 }

 async function promoItems(body,token){
  const {promotion_id:id,promotion_type:type,search_after:after,status:wanted}=body;
  if(typeof id!=='string'||!PROMO_ID_RE.test(id)||typeof type!=='string'||!TYPE_RE.test(type))throw new PromoError('Promoción no válida.',400);
  if(after!==undefined&&after!==null&&(typeof after!=='string'||!after||after.length>2048))throw new PromoError('search_after no válido.',400);
  const query=new URLSearchParams({promotion_type:type,app_version:'v2',limit:String(PAGE_LIMIT)});
  if(after)query.set('search_after',after);
  if(typeof wanted==='string'&&/^[a-z_]{3,20}$/.test(wanted))query.set('status',wanted);
  const r=await ml('GET',`/seller-promotions/promotions/${id}/items?${query}`,token);
  if(!r.ok)return {read_only:true,...failure(r)};
  const next=typeof r.json?.search_after==='string'&&r.json.search_after?r.json.search_after:typeof r.json?.paging?.search_after==='string'&&r.json.paging.search_after?r.json.paging.search_after:null;
  return {read_only:true,ok:true,ml_status:r.status,items:asList(r.json).map(i=>pick(i,ITEM_ROW_FIELDS)),total:Number.isFinite(r.json?.paging?.total)?r.json.paging.total:null,search_after:next};
 }

 async function itemPromos(body,token){
  if(!validIds(body.ids))throw new PromoError(`ids no válidos (hasta ${MAX_READ_IDS}, formato MLUnnn).`,400);
  const ids=body.ids;
  const bulk=await ml('GET',bulkItemsPath(ids,'id,seller_id,price,original_price,available_quantity,status'),token);
  if(!bulk.ok||!Array.isArray(bulk.json))throw new PromoError(`Mercado Libre respondió HTTP ${bulk.status} al leer las publicaciones.`,bulk.status===429?429:502);
  const items=[],failed=[];
  for(const entry of bulk.json){
   const item=bulkEntryItem(entry);
   if(!item)continue;
   if(!ids.includes(item.id)||String(item.seller_id)!==PROMOS_SELLER_ID)throw new PromoError('La respuesta incluye una publicación ajena o no solicitada.',403);
   const p=await ml('GET',`/seller-promotions/items/${item.id}?app_version=v2`,token);
   if(!p.ok){failed.push({id:item.id,ml_status:p.status});continue;}
   items.push({id:item.id,status:item.status??null,price:item.price??null,original_price:item.original_price??null,available_quantity:Number.isFinite(item.available_quantity)?item.available_quantity:null,promotions:asList(p.json).map(x=>pick(x,PROMO_FIELDS))});
  }
  const seen=new Set([...items.map(i=>i.id),...failed.map(f=>f.id)]);
  for(const id of ids)if(!seen.has(id))failed.push({id,ml_status:null});
  return {read_only:true,ok:true,items,failed};
 }

 async function remove(body,token){
  if(body.confirm!==true)throw new PromoError('confirmacion_requerida: sin confirm=true no se escribe nada.',400);
  const list=body.removals;
  if(!Array.isArray(list)||!list.length||list.length>MAX_WRITES)throw new PromoError(`removals: de 1 a ${MAX_WRITES} entradas.`,400);
  const results=[];
  for(const e of list){
   const base={item_id:e?.item_id,promotion_id:e?.promotion_id};
   if(typeof e?.item_id!=='string'||!ID_RE.test(e.item_id)||typeof e?.promotion_id!=='string'||!PROMO_ID_RE.test(e.promotion_id)||typeof e?.promotion_type!=='string'||!TYPE_RE.test(e.promotion_type)){results.push({...base,ok:false,error:'entrada_invalida'});continue;}
   if(BLOCKED_TYPE_RE.test(e.promotion_type)){results.push({...base,ok:false,error:'tipo_no_permitido'});continue;}
   const query=new URLSearchParams({promotion_type:e.promotion_type,promotion_id:e.promotion_id,app_version:'v2'});
   const r=await ml('DELETE',`/seller-promotions/items/${e.item_id}?${query}`,token);
   results.push({...base,ok:r.ok,ml_status:r.status,...(r.ok?{}:{error:mlError(r.status)})});
  }
  return {read_only:false,ok:true,results};
 }

 async function joinLightning(body,token){
  if(body.confirm!==true)throw new PromoError('confirmacion_requerida: sin confirm=true no se escribe nada.',400);
  const list=body.joins;
  if(!Array.isArray(list)||!list.length||list.length>MAX_WRITES)throw new PromoError(`joins: de 1 a ${MAX_WRITES} entradas.`,400);
  const results=[];
  for(const e of list){
   const base={item_id:e?.item_id,promotion_id:e?.promotion_id};
   const valid=typeof e?.item_id==='string'&&ID_RE.test(e.item_id)&&typeof e?.promotion_id==='string'&&PROMO_ID_RE.test(e.promotion_id)
    &&e.promotion_type==='LIGHTNING'
    &&Number.isInteger(e.deal_price)&&e.deal_price>0
    &&Number.isFinite(e.current_price)&&e.current_price>0&&e.deal_price<=e.current_price
    &&Number.isInteger(e.stock)&&e.stock>=1&&Number.isInteger(e.available_quantity)&&e.stock<=e.available_quantity;
   if(!valid){results.push({...base,ok:false,error:'entrada_invalida'});continue;}
   const r=await ml('POST',`/seller-promotions/items/${e.item_id}?app_version=v2`,token,{promotion_id:e.promotion_id,promotion_type:'LIGHTNING',deal_price:e.deal_price,stock:e.stock});
   results.push({...base,ok:r.ok,ml_status:r.status,...(r.ok?{}:{error:mlError(r.status)})});
  }
  return {read_only:false,ok:true,results};
 }

 return async function handle(request,env){
  if(request.method!=='POST')return reply({error:'Método no permitido.'},405);
  try{
   if(String(env.USER_ID)!==PROMOS_SELLER_ID)throw new PromoError('La aplicación no está configurada para la cuenta de Amado.',503);
   let body={};
   try{body=await request.json();}catch{body={};}
   if(!body||typeof body!=='object'||Array.isArray(body))body={};
   const action=body.action;
   if(!['status','promo_items','item_promos','remove','join_lightning'].includes(action))throw new PromoError('Acción no válida.',400);
   // Antes del token: un pedido de escritura sin confirmar nunca llega a Mercado Libre.
   if((action==='remove'||action==='join_lightning')&&body.confirm!==true)throw new PromoError('confirmacion_requerida: sin confirm=true no se escribe nada.',400);
   const token=await tokenProvider(env);
   if(typeof token!=='string'||!token)throw new PromoError('No se pudo renovar la autorización de Mercado Libre.',503);
   const out=action==='status'?await status(token):action==='promo_items'?await promoItems(body,token):action==='item_promos'?await itemPromos(body,token):action==='remove'?await remove(body,token):await joinLightning(body,token);
   return reply({seller_id:PROMOS_SELLER_ID,action,...out});
  }catch(error){
   return reply({error:error instanceof PromoError?error.message:'No se pudo completar la operación.'},error instanceof PromoError?error.status:502);
  }
 };
}
export const handleSellerPromotions=createSellerPromotions();
