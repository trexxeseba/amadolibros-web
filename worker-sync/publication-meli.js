import { getAccessToken } from './meli-auth.js';
import {SELLER_ID,PublicationError,canonicalIsbn,normalizedTitle} from './publication-policy.js';

export class MercadoLibreError extends PublicationError {
 constructor(code,status,retryAfter=0){super(code,status);this.retryAfter=retryAfter;}
}
function itemIsbns(item){
 const values=(item.attributes??[]).filter(a=>['ISBN','GTIN'].includes(a.id)).flatMap(a=>[a.value_name,...(a.values??[]).map(v=>v.name)]).filter(Boolean);
 for(const value of values)try{return canonicalIsbn(value);}catch{}
 return null;
}
function picture(raw){
 if(typeof raw?.id==='string'&&/^[\w-]{5,150}$/.test(raw.id))return {id:raw.id};
 try{const u=new URL(raw?.secure_url??raw?.url);if(u.protocol==='https:'&&(u.hostname==='mlstatic.com'||u.hostname.endsWith('.mlstatic.com')))return {source:u.href};}catch{}
 return null;
}
export function createPublicationMeli({fetcher=(...args)=>globalThis.fetch(...args),tokenProvider=getAccessToken,now=Date.now}={}){
 let cache=null,pending=null;
 async function token(env){if(cache&&cache.until>now())return cache.value;if(!pending)pending=tokenProvider(env).then(value=>{cache={value,until:now()+180000};return value;}).finally(()=>pending=null);return pending;}
 async function call(env,path,{method='GET',body}={}){
  const accessToken=await token(env),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
  let res,data;
  try{
   res=await fetcher('https://api.mercadolibre.com'+path,{method,headers:{Authorization:`Bearer ${accessToken}`,'Content-Type':'application/json',Accept:'application/json'},body:body?JSON.stringify(body):undefined,redirect:'manual',signal:controller.signal});
   if(!res.ok){if(res.status===401)cache=null;throw new MercadoLibreError(`ml_http_${res.status}`,res.status,Math.min(3600,Math.max(0,Number(res.headers.get('retry-after'))||0)));}
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
   for(const entry of raw){const b=entry.body;if((entry.code??entry.status_code)!==200||!b||String(b.seller_id)!==SELLER_ID||!remaining.has(b.id))throw new PublicationError('index_details_invalid',502);remaining.delete(b.id);batch.push({id:b.id,isbn:itemIsbns(b),titleKey:normalizedTitle(b.title),status:b.status});}
   if(remaining.size)throw new PublicationError('index_details_incomplete',502);
   return batch;
  }))).flat();
  state.pending=state.pending.slice(ids.length);state.seen+=ids.length;
  return {index:state,items};
 }
 async function skuItems(env,isbn){const q=new URLSearchParams({sku:`AMADO-AR-${isbn}`,limit:'100'});const r=await call(env,`/users/${SELLER_ID}/items/search?${q}`);if(!Array.isArray(r.results)||r.results.some(id=>!/^MLU\d+$/.test(id)))throw new PublicationError('sku_lookup_invalid',502);return r.results;}
 async function prepare(env,row,policy,price){
  const seller=await account(env);
  const found=await call(env,'/products/search?'+new URLSearchParams({site_id:'MLU',status:'active',product_identifier:row.isbn}));
  if(!Array.isArray(found.results)||(typeof found.paging?.total==='number'&&found.paging.total!==1)||found.results.length!==1)throw new PublicationError(found.results?.length?'ambiguous_product_metadata':'missing_product_metadata',422);
  const productId=found.results[0].id;if(!/^MLU\d+$/.test(productId))throw new PublicationError('product_id_invalid',422);
  const product=await call(env,`/products/${productId}`);
  if(itemIsbns(product)!==row.isbn||product.domain_id!=='MLU-BOOKS')throw new PublicationError('product_isbn_or_domain_mismatch',422);
  if(product.settings?.listing_strategy==='catalog_required'||found.results[0].settings?.listing_strategy==='catalog_required')throw new PublicationError('catalog_required_needs_review',422);
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
  const payload={site_id:'MLU',category_id:categoryId,price,currency_id:'UYU',available_quantity:1,buying_mode:'buy_it_now',listing_type_id:policy.listingTypeId,condition:'new',catalog_listing:false,seller_custom_field:`AMADO-AR-${row.isbn}`,pictures,attributes,
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
  if(payload.catalog_listing!==false||payload.currency_id!=='UYU'||payload.condition!=='new')throw new PublicationError('payload_policy_mismatch',422);
  await account(env);await verifyFees(env,payload,policy);await call(env,'/items/validate',{method:'POST',body:payload});
  const result=await call(env,'/items',{method:'POST',body:payload});
  if(!/^MLU\d+$/.test(result?.id??'')||String(result.seller_id)!==SELLER_ID)throw new MercadoLibreError('create_outcome_unknown',502);
  return result;
 }
 return {account,indexSlice,skuItems,prepare,create,call};
}
