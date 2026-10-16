import { getAccessToken, invalidateAccessToken, MeliAuthError } from './meli-auth.js';
import {SELLER_ID,PublicationError,canonicalIsbn,normalizedTitle} from './publication-policy.js';
import {supplierBookMetadata} from './publication-book-metadata.js';

export class MercadoLibreError extends PublicationError {
 constructor(code,status,retryAfter=0){super(code,status);this.retryAfter=retryAfter;}
}
const MAX_CATALOG_CHILDREN=10;
const MAX_DOMAIN_CATEGORIES=20;
// El listado de categorías de un dominio de Catálogo se lee a la defensiva:
// sólo las cadenas MLU\d+ de los campos documentados se vuelven candidatas y
// cualquier otra forma se ignora en lugar de adivinarse. La autoridad sobre
// cada candidata sigue siendo /categories/{id}.
export function domainCategoryIds(payload){
 const entries=Array.isArray(payload)?payload:Array.isArray(payload?.categories)?payload.categories:[];
 const ids=[];
 for(const entry of entries){
  const id=typeof entry==='string'?entry:entry?.category_id??entry?.id;
  if(typeof id==='string'&&/^MLU\d+$/.test(id)&&!ids.includes(id))ids.push(id);
 }
 return ids;
}
function itemIsbns(item){
 const values=(item.attributes??[]).filter(a=>['ISBN','GTIN'].includes(a.id)).flatMap(a=>[a.value_name,...(a.values??[]).map(v=>v.name)]).filter(Boolean);
 for(const value of values)try{return canonicalIsbn(value);}catch{}
 return null;
}
function picture(raw){
 if(typeof raw?.id==='string'&&/^[\w-]{5,150}$/.test(raw.id))return {id:raw.id};
 try{const u=new URL(raw?.secure_url??raw?.url??raw?.source);if(u.protocol==='https:'&&!u.username&&!u.password&&(u.hostname==='mlstatic.com'||u.hostname.endsWith('.mlstatic.com')||(['sbslibreria.vteximg.com.br','sbslibreria.vtexassets.com'].includes(u.hostname)&&/^\/arquivos\/ids\/\d+(?:\/|-|$)/.test(u.pathname))))return {source:u.href};}catch{}
 return null;
}
// Mercado Libre may require the seller package even when the category does not
// mark it required. Conservative estimate from the book weight: integer cm
// (LENGTH largest side, WIDTH middle, HEIGHT thickness) and grams rounded up
// to the next 100 g after adding 150 g of packaging.
const PACKAGE_BANDS=[[.4,25,18,4],[.8,30,22,6],[1.5,35,25,10],[Infinity,40,30,15]];
export const SELLER_PACKAGE_IDS=['SELLER_PACKAGE_HEIGHT','SELLER_PACKAGE_LENGTH','SELLER_PACKAGE_WIDTH','SELLER_PACKAGE_WEIGHT'];
export function sellerPackageAttributes(weightKg){
 if(!Number.isFinite(weightKg)||weightKg<=0)throw new PublicationError('invalid_weight',422);
 const [,length,width,height]=PACKAGE_BANDS.find(([max])=>weightKg<=max);
 const grams=Math.ceil((Math.round(weightKg*1000)+150)/100)*100;
 return [{id:'SELLER_PACKAGE_HEIGHT',value_name:`${height} cm`},{id:'SELLER_PACKAGE_LENGTH',value_name:`${length} cm`},{id:'SELLER_PACKAGE_WIDTH',value_name:`${width} cm`},{id:'SELLER_PACKAGE_WEIGHT',value_name:`${grams} g`}];
}
// Shipping diagnostics return Mercado Libre data with personal and location
// fields removed, bounded in depth, array length and string size.
const PRIVATE_KEY=/^(lat|lon|latitude|longitude|geolocation|name|state|country|comment|comments)$|^state_|address|street|zip|phone|email|contact|nickname|first_name|last_name|identification|city|neighborhood|receiver|sender|token/i;
export function shippingSafe(value,depth=0){
 if(value===null||typeof value!=='object')return typeof value==='string'?value.slice(0,120):value;
 if(depth>=6)return '[truncated]';
 if(Array.isArray(value))return value.slice(0,25).map(v=>shippingSafe(v,depth+1));
 return Object.fromEntries(Object.entries(value).filter(([k])=>!PRIVATE_KEY.test(k)).slice(0,60).map(([k,v])=>[k,shippingSafe(v,depth+1)]));
}
// /items/validate causes kept for diagnostics: official code, bounded message
// text and the field Mercado Libre points at. Never tokens or unbounded text.
const CAUSE_CODE=/^(item|body|shipping|seller|category|user|catalog|product|pictures|request|validation)[._][a-z0-9_.-]{1,140}$/;
export function validationCauses(causes,secrets=[]){
 const redact=text=>{let out=text.replace(/Bearer\s+\S+/gi,'[token]').replace(/\b(APP_USR|TG)-[\w-]+/g,'[token]').replace(/[A-Za-z0-9_-]{32,}/g,'[redacted]');for(const s of secrets)if(typeof s==='string'&&s.length>=8)out=out.split(s).join('[token]');return out.slice(0,200);};
 return (Array.isArray(causes)?causes:[]).slice(0,10).map(c=>({
  code:CAUSE_CODE.test(String(c?.code??''))?String(c.code):'other',
  type:typeof c?.type==='string'?c.type.slice(0,20):null,
  message:typeof c?.message==='string'?redact(c.message):null,
  department:typeof c?.department==='string'?c.department.slice(0,60):Array.isArray(c?.references)?c.references.filter(r=>typeof r==='string').slice(0,5).join(',').slice(0,120)||null:null}));
}
// Shipping comes from the account, never hardcoded: ME2 availability, mandatory
// free shipping, current local pick-up and the real default ME2 logistics.
export function shippingSettings(prefs){
 const modes=Array.isArray(prefs?.modes)?prefs.modes:[];
 const me2=(Array.isArray(prefs?.logistics)?prefs.logistics:[]).find(l=>l?.mode==='me2');
 const types=Array.isArray(me2?.types)?me2.types.filter(t=>typeof t?.type==='string'&&/^[a-z_]{2,40}$/.test(t.type)&&t.status!=='inactive'):[];
 return {me2Available:modes.includes('me2')&&!!me2,mandatoryFreeShipping:prefs?.mandatory_settings?.mode==='me2',localPickUp:prefs?.local_pick_up===true,logisticType:(types.find(t=>t.default===true)??types[0])?.type??null};
}
// Only configurations the account supports, in the order /items/validate tries
// them. No tags (Mercado Libre derives them) and no invented free_methods.
export function shippingVariants(settings){
 const a={mode:'me2',local_pick_up:false,free_shipping:true,free_methods:[]};
 if(!settings.logisticType)return [{variant:'A',shipping:a},{variant:'C',shipping:{...a,local_pick_up:true}}];
 const b={...a,logistic_type:settings.logisticType};
 return [{variant:'A',shipping:a},{variant:'B',shipping:b},{variant:'C',shipping:{...b,local_pick_up:true}}];
}
// A prepared payload may only be created under the policy that produced it:
// Catálogo exclusively with the explicit 'required_only' policy and a verified
// product id; otherwise a traditional listing without any product binding.
export function payloadPolicyMismatch(payload,policy){
 if(!payload||typeof payload!=='object'||payload.currency_id!=='UYU'||payload.condition!=='new')return 'payload_policy_mismatch';
 if(payload.catalog_listing===true)return policy?.catalogListing==='required_only'&&/^MLU\d+$/.test(payload.catalog_product_id??'')?null:'catalog_payload_not_approved';
 return payload.catalog_listing===false&&payload.catalog_product_id===undefined?null:'payload_policy_mismatch';
}
export function createPublicationMeli({fetcher=(...args)=>globalThis.fetch(...args),tokenProvider=getAccessToken,tokenInvalidator=invalidateAccessToken,now=Date.now,timeouts={}}={}){
 const requestTimeout=timeouts.request??12000,createTimeout=timeouts.create??30000;
 let cache=null,pending=null;
 const authFailure=error=>error instanceof MeliAuthError?new MercadoLibreError(error.code,error.retryable?503:401,error.retryAfter??0):new MercadoLibreError('auth_unavailable',503);
 async function token(env){
  // Short isolate cache; the stored token and its real expiry live in D1 (meli-auth.js).
  if(cache&&cache.until>now())return cache.value;
  if(!pending)pending=Promise.resolve().then(()=>tokenProvider(env)).then(value=>{if(typeof value!=='string'||!value)throw new MeliAuthError('auth_empty_token',{status:503,retryable:true});cache={value,until:now()+60000};return value;}).finally(()=>pending=null);
  try{return await pending;}catch(error){throw authFailure(error);}
 }
 async function call(env,path,{method='GET',body}={}){
  const accessToken=await token(env),controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),method==='POST'&&path==='/items'?createTimeout:requestTimeout);
  let res,data;
  try{
   res=await fetcher('https://api.mercadolibre.com'+path,{method,headers:{Authorization:`Bearer ${accessToken}`,'Content-Type':'application/json',Accept:'application/json'},body:body?JSON.stringify(body):undefined,redirect:'manual',signal:controller.signal});
   if(!res.ok){
    if(res.status===401){cache=null;try{await tokenInvalidator(env,accessToken);}catch{}}
    const error=new MercadoLibreError(`ml_http_${res.status}`,res.status,Math.min(3600,Math.max(0,Number(res.headers.get('retry-after'))||0)));
    error.stage=path==='/items/validate'?'item_validation':path.startsWith('/sites/MLU/listing_prices')?'listing_fees':path==='/items'?'item_creation':'metadata';
    try{const details=await res.json();error.validationCodes=(details.cause??[]).map(c=>c.code).filter(c=>typeof c==='string'&&CAUSE_CODE.test(c)).slice(0,10);error.validationCauses=validationCauses(details.cause,[accessToken]);}catch{}
    throw error;
   }
   if(res.status===204)return {};
   try{data=await res.json();}catch{throw new MercadoLibreError(method==='POST'&&path==='/items'?'create_outcome_unknown':'ml_invalid_json',502);}
  }catch(error){if(error instanceof MercadoLibreError)throw error;throw new MercadoLibreError(method==='POST'&&path==='/items'?'create_outcome_unknown':'ml_transport',503);}
  finally{clearTimeout(timer);}
  return data;
 }
 async function account(env){const x=await call(env,'/users/me');if(String(x.id)!==SELLER_ID||x.site_id!=='MLU')throw new PublicationError('seller_mismatch',403);return x;}
 async function indexSlice(env,index){
  const state=structuredClone(index);
  if(state.done)return {index:state,items:[]};
  if(!state.pending.length){
   const query=new URLSearchParams({search_type:'scan',status:state.status,limit:'100'});if(state.scroll)query.set('scroll_id',state.scroll);
   let page;
   try{page=await call(env,`/users/${SELLER_ID}/items/search?${query}`);}
   catch(error){
    // Scrolls expire after five minutes. A rate-limit cooldown may outlive one;
    // restart this status and deduplicate IDs rather than skipping unseen books.
    if(!state.scroll||![400,404,410].includes(error.status))throw error;
    state.scroll=null;query.delete('scroll_id');page=await call(env,`/users/${SELLER_ID}/items/search?${query}`);
   }
   if(page.seller_id!==undefined&&String(page.seller_id)!==SELLER_ID)throw new PublicationError('index_seller_mismatch',502);
   if(page.results===null||(Array.isArray(page.results)&&!page.results.length)){
    if(state.status==='active')return {index:{status:'paused',scroll:null,pending:[],done:false,seen:state.seen},items:[]};
    return {index:{...state,done:true,completedAt:new Date(now()).toISOString()},items:[]};
   }
   if(!Array.isArray(page.results)||page.results.some(id=>!/^MLU\d+$/.test(id)))throw new PublicationError('index_page_invalid',502);
   state.pending=page.results;state.scroll=page.scroll_id??null;
  }
  const ids=state.pending.slice(0,100),groups=[];
  for(let i=0;i<ids.length;i+=20)groups.push(ids.slice(i,i+20));
  // Read up to five independent multigets together, retaining 20 IDs per request.
  // The older /items?ids endpoint is deprecated from 25 Oct 2026.
  const items=(await Promise.all(groups.map(async group=>{
   const raw=await call(env,'/items/bulk?ids='+group.join(','));
   if(!Array.isArray(raw)||raw.length!==group.length)throw new PublicationError('index_details_incomplete',502);
   const remaining=new Set(group),batch=[];
   for(const entry of raw){const b=entry.body;if((entry.status_code??entry.code)!==200||!b||String(b.seller_id)!==SELLER_ID||!remaining.has(b.id))throw new PublicationError('index_details_invalid',502);remaining.delete(b.id);batch.push({id:b.id,isbn:itemIsbns(b),titleKey:normalizedTitle(b.title),status:b.status});}
   if(remaining.size)throw new PublicationError('index_details_incomplete',502);
   return batch;
  }))).flat();
  state.pending=state.pending.slice(ids.length);state.seen+=ids.length;
  return {index:state,items};
 }
 async function skuItems(env,isbn){const q=new URLSearchParams({sku:`AMADO-AR-${isbn}`,limit:'100'});const r=await call(env,`/users/${SELLER_ID}/items/search?${q}`);if(!Array.isArray(r.results)||r.results.some(id=>!/^MLU\d+$/.test(id)))throw new PublicationError('sku_lookup_invalid',502);return r.results;}
 async function inspectProduct(env,input){
  const isbn=canonicalIsbn(input),found=await call(env,'/products/search?'+new URLSearchParams({site_id:'MLU',status:'active',product_identifier:isbn}));
  const first=found.results?.[0],id=first?.id;if(!/^MLU\d+$/.test(id??''))return {requested_isbn:isbn,results:found.paging?.total??found.results?.length??null};
  const product=await call(env,`/products/${id}`);
  return {requested_isbn:isbn,results:found.paging?.total??found.results?.length??null,product_id:id,domain_id:product.domain_id??null,listing_strategy:product.settings?.listing_strategy??first?.settings?.listing_strategy??null,children:(product.children_ids??[]).length,reported_isbn:itemIsbns(product),search_reported_isbn:itemIsbns(first),name:String(product.name??'').slice(0,250),attribute_ids:(product.attributes??[]).slice(0,60).map(a=>a.id),identifier_attributes:(product.attributes??[]).filter(a=>['GTIN','ISBN'].includes(a.id)).map(a=>({id:a.id,value_id:a.value_id??null,value_name:a.value_name??null,values:(a.values??[]).slice(0,5).map(v=>({id:v.id??null,name:v.name??null}))}))};
 }
 // Catálogo obligatorio: el catalog_product_id debe ser exactamente el producto
 // (o el único hijo) cuyo GTIN es el ISBN del proveedor. Cualquier duda es review.
 async function resolveCatalogProduct(env,row,productId,product){
  if(typeof product.id==='string'&&product.id!==productId)throw new PublicationError('catalog_product_id_mismatch',422);
  const children=Array.isArray(product.children_ids)?product.children_ids:[];
  if(!children.length){
   if(product.status!==undefined&&product.status!=='active')throw new PublicationError('catalog_product_inactive',422);
   return {id:productId,product};
  }
  if(children.length>MAX_CATALOG_CHILDREN||children.some(id=>!/^MLU\d+$/.test(String(id))))throw new PublicationError('catalog_product_children_unresolved',422);
  const matches=[];
  for(const childId of children){
   const child=await call(env,`/products/${childId}`);
   if(child.domain_id==='MLU-BOOKS'&&itemIsbns(child)===row.isbn&&!(Array.isArray(child.children_ids)&&child.children_ids.length)&&(child.status===undefined||child.status==='active'))matches.push({id:childId,product:child});
  }
  if(matches.length!==1)throw new PublicationError('catalog_product_children_unresolved',422);
  return matches[0];
 }
// Catálogo necesita category_id. Cuando el producto no lo trae, el dominio ya
// verificado como MLU-BOOKS lo convierte: /catalog_domains/{domain}/categories.
// Cada candidata se confirma contra /categories/{id} — de MLU, publicable y
// hoja — y la predicción por título sólo desempata entre esas candidatas, nunca
// aporta una categoría propia. Si queda ambiguo es review, no una conjetura.
 async function resolveDomainCategory(env,row,product){
  const domainId=product.domain_id;
  if(typeof domainId!=='string'||!/^MLU-[A-Z0-9_]{1,60}$/.test(domainId))throw new PublicationError('missing_book_category',422);
  const ids=domainCategoryIds(await call(env,`/catalog_domains/${encodeURIComponent(domainId)}/categories`));
  if(!ids.length)throw new PublicationError('missing_book_category',422);
  if(ids.length>MAX_DOMAIN_CATEGORIES)throw new PublicationError('ambiguous_book_category',422);
  const candidates=[];
  for(const id of ids){
   const category=await call(env,`/categories/${id}`);
   if(category.id!==undefined&&category.id!==id)continue;
   if(category.settings?.listing_allowed===false)continue;
   if((category.children_categories??[]).length)continue;
   candidates.push({id,category});
  }
  if(!candidates.length)throw new PublicationError('missing_book_category',422);
  if(candidates.length===1)return candidates[0];
  const prediction=await call(env,'/sites/MLU/domain_discovery/search?'+new URLSearchParams({q:row.title,limit:'3'}));
  const predicted=Array.isArray(prediction)?prediction.find(x=>x?.domain_id===domainId&&candidates.some(c=>c.id===x?.category_id)):null;
  const chosen=predicted?candidates.find(c=>c.id===predicted.category_id):null;
  if(!chosen)throw new PublicationError('ambiguous_book_category',422);
  return chosen;
 }
 let prefsCache=null;
 async function shippingPreferences(env){
  if(prefsCache&&prefsCache.until>now())return prefsCache.value;
  const settings=shippingSettings(await call(env,`/users/${SELLER_ID}/shipping_preferences`));
  if(!settings.me2Available)throw new PublicationError('me2_not_available',422);
  prefsCache={value:settings,until:now()+600000};return settings;
 }
 // /items/validate decides the shipping block over the complete payload: A, then
 // B, then C, stopping at the first accepted one. A rejection that mentions no
 // shipping cause stops the search (the variants would not change it). Never POST /items.
 async function resolveShipping(env,payload,trace=null){
  const settings=await shippingPreferences(env),attempts=[];
  if(trace)trace.settings=settings;
  for(const {variant,shipping} of shippingVariants(settings)){
   const body={...payload,shipping};
   try{await call(env,'/items/validate',{method:'POST',body});if(trace){trace.attempts=attempts;trace.variant=variant;}return body;}
   catch(error){
    if(!(error instanceof MercadoLibreError)||error.stage!=='item_validation'||error.status!==400)throw error;
    const causes=error.validationCauses??[];attempts.push({variant,shipping,status:error.status,causes});
    if(!causes.some(c=>/shipping/.test(c.code)))break;
   }
  }
  const shippingRelated=attempts.some(a=>a.causes.some(c=>/shipping/.test(c.code)));
  const error=new MercadoLibreError(shippingRelated?'shipping_not_validated':'ml_http_400',shippingRelated?422:400);
  error.stage='item_validation';error.validationCodes=[...new Set(attempts.flatMap(a=>a.causes.map(c=>c.code)))].slice(0,10);error.validationCauses=attempts.flatMap(a=>a.causes).slice(0,10);error.shippingAttempts=attempts;error.shippingSettings=settings;
  if(trace){trace.attempts=attempts;trace.variant=null;}
  throw error;
 }
 async function prepare(env,row,policy,price,trace=null){
  const seller=await account(env);
  const found=await call(env,'/products/search?'+new URLSearchParams({site_id:'MLU',status:'active',product_identifier:row.isbn}));
  if(!Array.isArray(found.results))throw new PublicationError('product_search_invalid',502);
  const missing=found.results.length===0&&(found.paging?.total===undefined||found.paging.total===0);
  if(!missing&&((typeof found.paging?.total==='number'&&found.paging.total!==1)||found.results.length!==1))throw new PublicationError('ambiguous_product_metadata',422);
  let product,productId=null;
  if(missing)product=await supplierBookMetadata(row,{fetcher});
  else{productId=found.results[0].id;if(!/^MLU\d+$/.test(productId))throw new PublicationError('product_id_invalid',422);product=await call(env,`/products/${productId}`);}
  // The detail endpoint can omit GTIN even when the exact-identifier search returns it.
  const detailIsbn=itemIsbns(product),searchIsbn=found.results[0]?itemIsbns(found.results[0]):null;
  if(product.domain_id!=='MLU-BOOKS'||(detailIsbn&&detailIsbn!==row.isbn)||(searchIsbn&&searchIsbn!==row.isbn)||(!detailIsbn&&!searchIsbn))throw new PublicationError('product_identity_mismatch',422);
  const strategy=product.settings?.listing_strategy??found.results[0]?.settings?.listing_strategy??null;
  const catalogRequired=strategy==='catalog_required';
  let catalogProductId=null;
  if(catalogRequired){
   if(policy.catalogListing!=='required_only')throw new PublicationError('catalog_required_needs_review',422);
   const resolved=await resolveCatalogProduct(env,row,productId,product);
   catalogProductId=resolved.id;product=resolved.product;
  }
  const binding=/(?:-|–)\s*(HB|PB)\s*$/i.exec(row.title)?.[1]?.toUpperCase();
  const cover=String((product.attributes??[]).find(a=>a.id==='BOOK_COVER')?.value_name??'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase();
  if((binding==='HB'&&/blanda|rustica|paper|soft/.test(cover))||(binding==='PB'&&/dura|hard/.test(cover)))throw new PublicationError('book_binding_mismatch',422);
  let categoryId=product.category_id,resolvedCategory=null;
  // La conversión por dominio es sólo para Catálogo obligatorio, donde el
  // category_id es ineludible. Un alta tradicional (producto ausente en ML,
  // metadata verificada del proveedor) conserva intacta su predicción por título.
  if(!categoryId&&catalogRequired){const resolved=await resolveDomainCategory(env,row,product);categoryId=resolved.id;resolvedCategory=resolved.category;}
  if(!categoryId){const prediction=await call(env,'/sites/MLU/domain_discovery/search?'+new URLSearchParams({q:row.title,limit:'3'}));categoryId=Array.isArray(prediction)?prediction.find(x=>x.domain_id==='MLU-BOOKS')?.category_id:null;}
  if(!/^MLU\d+$/.test(categoryId??''))throw new PublicationError('missing_book_category',422);
  const category=resolvedCategory??await call(env,`/categories/${categoryId}`);
  if(category.settings?.listing_allowed===false||(category.children_categories??[]).length)throw new PublicationError('category_not_leaf_or_not_allowed',422);
  const allowed=await call(env,`/categories/${categoryId}/attributes`);
  if(!Array.isArray(allowed))throw new PublicationError('category_attributes_invalid',502);
  const attrIds=new Set(allowed.filter(a=>!a.tags?.read_only).map(a=>a.id));
  const attributes=(product.attributes??[]).filter(a=>attrIds.has(a.id)&&!['GTIN','ISBN','SELLER_SKU',...SELLER_PACKAGE_IDS].includes(a.id)).map(a=>({id:a.id,...(a.value_id?{value_id:a.value_id}:{value_name:a.value_name})})).filter(a=>a.value_id||a.value_name);
  const identifier=attrIds.has('GTIN')?'GTIN':attrIds.has('ISBN')?'ISBN':null;if(!identifier)throw new PublicationError('isbn_attribute_missing',422);
  attributes.push({id:identifier,value_name:row.isbn});
  if(attrIds.has('SELLER_SKU'))attributes.push({id:'SELLER_SKU',value_name:`AMADO-AR-${row.isbn}`});
  attributes.push(...sellerPackageAttributes(row.weightKg));
  const pictures=(product.pictures??[]).map(picture).filter(Boolean).slice(0,12);if(!pictures.length)throw new PublicationError('missing_verified_cover',422);
  const maxTitle=Number.isInteger(category.settings?.max_title_length)?Math.min(120,category.settings.max_title_length):60;
  const title=row.title.slice(0,maxTitle).trim();
  // Direct catalog listings keep the documented item fields (title, pictures,
  // attributes) and add the verified product binding. /items/validate decides.
  const payload={site_id:'MLU',category_id:categoryId,price,currency_id:'UYU',available_quantity:1,buying_mode:'buy_it_now',listing_type_id:policy.listingTypeId,condition:'new',catalog_listing:catalogRequired,...(catalogRequired?{catalog_product_id:catalogProductId}:{}),seller_custom_field:`AMADO-AR-${row.isbn}`,pictures,attributes,
   sale_terms:policy.availabilityDays?[{id:'MANUFACTURING_TIME',value_name:`${policy.availabilityDays} días`}]:[]};
  if(seller.tags?.includes('user_product_seller'))payload.family_name=title;else payload.title=title;
  await verifyFees(env,payload,policy);
  return resolveShipping(env,payload,trace);
 }
 // Exactly prepare() on one supplier row, reporting which shipping variant
 // /items/validate accepted or every attempt when none did. Nothing is stored.
 async function shippingProbe(env,row,policy,price){
  const trace={};
  try{const payload=await prepare(env,row,policy,price,trace);return {validated:true,variant:trace.variant,shipping:payload.shipping,price:payload.price,sale_terms:payload.sale_terms,attempts:trace.attempts??[],settings:trace.settings??null};}
  catch(error){return {validated:false,variant:null,error:error.code??'error',status:error.status??null,stage:error.stage??null,attempts:error.shippingAttempts??trace.attempts??[],causes:error.validationCauses??[],settings:error.shippingSettings??trace.settings??null};}
 }
 async function verifyFees(env,payload,policy){
  const fee=await call(env,'/sites/MLU/listing_prices?'+new URLSearchParams({price:String(payload.price),listing_type_id:policy.listingTypeId,category_id:payload.category_id,currency_id:'UYU'}));
  const item=Array.isArray(fee)?fee.find(x=>x.listing_type_id===policy.listingTypeId):fee;
  if(item?.currency_id!=='UYU'||item.listing_type_id!==policy.listingTypeId||!Number.isFinite(item.sale_fee_amount)||item.sale_fee_amount<0||item.sale_fee_amount>payload.price*policy.mlFee+.01||!Number.isFinite(item.listing_fee_amount)||item.listing_fee_amount!==0)throw new PublicationError('listing_fee_exceeds_or_missing_policy',422);
 }
 async function create(env,payload,policy){
  // Revalidate the prepared payload and fees immediately before the single create.
  const mismatch=payloadPolicyMismatch(payload,policy);if(mismatch)throw new PublicationError(mismatch,422);
  await account(env);await verifyFees(env,payload,policy);await call(env,'/items/validate',{method:'POST',body:payload});
  const result=await call(env,'/items',{method:'POST',body:payload});
  if(!/^MLU\d+$/.test(result?.id??'')||String(result.seller_id)!==SELLER_ID)throw new MercadoLibreError('create_outcome_unknown',502);
  return result;
 }
 // Read-only shipping diagnostic: GET requests only, each one reported on its
 // own so a refused endpoint never hides the others.
 async function shippingDiagnostic(env,{itemId=null,itemPrice=null,weightKg=.495,categoryId='MLU1196',logisticType=null}={}){
  const read=async path=>{try{return {ok:true,data:await call(env,path)};}catch(error){return {ok:false,error:error.code??'ml_error',status:error.status??null,validation_codes:error.validationCodes??[]};}};
  const pack=Object.fromEntries(sellerPackageAttributes(weightKg).map(a=>[a.id,parseInt(a.value_name,10)]));
  const dimensions=`${pack.SELLER_PACKAGE_HEIGHT}x${pack.SELLER_PACKAGE_WIDTH}x${pack.SELLER_PACKAGE_LENGTH},${pack.SELLER_PACKAGE_WEIGHT}`;
  const me=await read('/users/me');
  if(me.ok&&(String(me.data.id)!==SELLER_ID||me.data.site_id!=='MLU'))throw new PublicationError('seller_mismatch',403);
  const out={seller_id:SELLER_ID,dimensions,
   account:me.ok?{ok:true,data:shippingSafe({site_id:me.data.site_id,tags:me.data.tags,shipping_modes:me.data.shipping_modes,status:{mercadoenvios:me.data.status?.mercadoenvios??null,sell:me.data.status?.sell??null,list:me.data.status?.list??null}})}:me,
   shipping_preferences:await read(`/users/${SELLER_ID}/shipping_preferences`),
   category_shipping_preferences:/^MLU\d+$/.test(categoryId)?await read(`/categories/${categoryId}/shipping_preferences`):null};
  if(out.shipping_preferences.ok){out.shipping_variants=shippingVariants(shippingSettings(out.shipping_preferences.data));out.shipping_preferences.data=shippingSafe(out.shipping_preferences.data);}
  if(out.category_shipping_preferences?.ok)out.category_shipping_preferences.data=shippingSafe(out.category_shipping_preferences.data);
  if(itemId){
   if(!/^MLU\d+$/.test(itemId))throw new PublicationError('invalid_item_id');
   const item=await read(`/items/${itemId}?attributes=id,seller_id,price,category_id,listing_type_id,catalog_listing,status,shipping,sale_terms`);
   if(item.ok&&String(item.data.seller_id)!==SELLER_ID)throw new PublicationError('item_seller_mismatch',403);
   out.reference_item=item.ok?{ok:true,data:shippingSafe(item.data)}:item;
  }
  if(Number.isFinite(itemPrice)&&itemPrice>0){
   const q=new URLSearchParams({dimensions,item_price:String(itemPrice),listing_type_id:'gold_special',mode:'me2',condition:'new',currency_id:'UYU',verbose:'true'});
   if(/^MLU\d+$/.test(categoryId))q.set('category_id',categoryId);if(logisticType)q.set('logistic_type',logisticType);
   const free=await read(`/users/${SELLER_ID}/shipping_options/free?${q}`);
   out.free_shipping_quote=free.ok?{ok:true,data:shippingSafe(free.data)}:free;
  }
  return out;
 }
 return {account,indexSlice,skuItems,prepare,create,call,inspectProduct,shippingDiagnostic,shippingProbe};
}
