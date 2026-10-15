import { getAccessToken, invalidateAccessToken, MeliAuthError } from './meli-auth.js';
import {SELLER_ID,PublicationError,canonicalIsbn,normalizedTitle} from './publication-policy.js';
import {supplierBookMetadata} from './publication-book-metadata.js';

export class MercadoLibreError extends PublicationError {
 constructor(code,status,retryAfter=0){super(code,status);this.retryAfter=retryAfter;}
}
const MAX_CATALOG_CHILDREN=10;
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
    try{const details=await res.json();error.validationCodes=(details.cause??[]).map(c=>c.code).filter(c=>typeof c==='string'&&/^(item|body|shipping|seller|category|user|catalog|product|pictures|request|validation)[._][a-z0-9_.-]{1,140}$/.test(c)).slice(0,10);}catch{}
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
 async function prepare(env,row,policy,price){
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
  let categoryId=product.category_id;
  if(!categoryId){const prediction=await call(env,'/sites/MLU/domain_discovery/search?'+new URLSearchParams({q:row.title,limit:'3'}));categoryId=Array.isArray(prediction)?prediction.find(x=>x.domain_id==='MLU-BOOKS')?.category_id:null;}
  if(!/^MLU\d+$/.test(categoryId??''))throw new PublicationError('missing_book_category',422);
  const category=await call(env,`/categories/${categoryId}`);
  if(category.settings?.listing_allowed===false||(category.children_categories??[]).length)throw new PublicationError('category_not_leaf_or_not_allowed',422);
  const allowed=await call(env,`/categories/${categoryId}/attributes`);
  if(!Array.isArray(allowed))throw new PublicationError('category_attributes_invalid',502);
  const attrIds=new Set(allowed.filter(a=>!a.tags?.read_only).map(a=>a.id));
  const attributes=(product.attributes??[]).filter(a=>attrIds.has(a.id)&&!['GTIN','ISBN','SELLER_SKU'].includes(a.id)).map(a=>({id:a.id,...(a.value_id?{value_id:a.value_id}:{value_name:a.value_name})})).filter(a=>a.value_id||a.value_name);
  const identifier=attrIds.has('GTIN')?'GTIN':attrIds.has('ISBN')?'ISBN':null;if(!identifier)throw new PublicationError('isbn_attribute_missing',422);
  attributes.push({id:identifier,value_name:row.isbn});
  if(attrIds.has('SELLER_SKU'))attributes.push({id:'SELLER_SKU',value_name:`AMADO-AR-${row.isbn}`});
  const pictures=(product.pictures??[]).map(picture).filter(Boolean).slice(0,12);if(!pictures.length)throw new PublicationError('missing_verified_cover',422);
  const maxTitle=Number.isInteger(category.settings?.max_title_length)?Math.min(120,category.settings.max_title_length):60;
  const title=row.title.slice(0,maxTitle).trim();
  // Direct catalog listings keep the documented item fields (title, pictures,
  // attributes) and add the verified product binding. /items/validate decides.
  const payload={site_id:'MLU',category_id:categoryId,price,currency_id:'UYU',available_quantity:1,buying_mode:'buy_it_now',listing_type_id:policy.listingTypeId,condition:'new',catalog_listing:catalogRequired,...(catalogRequired?{catalog_product_id:catalogProductId}:{}),seller_custom_field:`AMADO-AR-${row.isbn}`,pictures,attributes,
   sale_terms:policy.availabilityDays?[{id:'MANUFACTURING_TIME',value_name:`${policy.availabilityDays} días`}]:[],shipping:{mode:'me2',local_pick_up:true,free_shipping:true}};
  if(seller.tags?.includes('user_product_seller'))payload.family_name=title;else payload.title=title;
  await verifyFees(env,payload,policy);
  await call(env,'/items/validate',{method:'POST',body:payload});
  return payload;
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
 return {account,indexSlice,skuItems,prepare,create,call,inspectProduct};
}
