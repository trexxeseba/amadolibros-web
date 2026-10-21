// Lectura de SOLO LECTURA de atributos de libros de las publicaciones activas de
// Amado Libros (POST /attribute-audit, detrás de SYNC_SECRET). Devuelve, por
// publicación, únicamente los atributos de ficha de libro que importan para la
// auditoría (no el item completo y nunca tokens). No escribe en Mercado Libre:
// sólo hace GET a /users/{id}/items/search y /items/bulk.
//
// Una llamada procesa UNA página del scan (hasta 100 ids, 5 multigets de 20) y
// devuelve el scroll_id para continuar. Así cada invocación del Worker queda muy
// por debajo del límite de subrequests.
import {getAccessToken} from './meli-auth.js';
import {bulkItemsPath,bulkEntryItem} from './meli-bulk.js';

export const AUDIT_SELLER_ID='440298103';
export const AUDIT_ATTRIBUTE_IDS=Object.freeze(['AUTHOR','GTIN','ISBN','BOOK_PUBLISHER','PUBLISHER','LANGUAGE','PUBLICATION_YEAR','PAGES_NUMBER','BOOK_COVER','BOOK_EDITION','BOOK_GENRE']);
const ML_ORIGIN='https://api.mercadolibre.com';
const PAGE_SIZE=100,BULK_SIZE=20;
const ITEM_FIELDS='id,seller_id,title,status,category_id,catalog_listing,user_product_id,variations,sold_quantity,available_quantity,attributes';

class AuditError extends Error{constructor(message,status=502){super(message);this.status=status;}}
const reply=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});

export function projectAuditItem(raw){
 const wanted=new Set(AUDIT_ATTRIBUTE_IDS);
 const projectStruct=s=>s&&typeof s==='object'?{number:s.number??null,unit:s.unit??null}:null;
 const attributes=Array.isArray(raw.attributes)?raw.attributes.filter(a=>wanted.has(String(a?.id??'').toUpperCase())).map(a=>({id:a.id,value_name:a.value_name??null,value_id:a.value_id??null,value_struct:projectStruct(a.value_struct),...(Array.isArray(a.values)?{values:a.values.map(v=>({id:v.id??null,name:v.name??null,struct:projectStruct(v.struct)}))}:{})})):null;
 // No convertir un campo ausente en null: ausencia significa vinculación desconocida.
 const relations={};
 if(Object.hasOwn(raw,'user_product_id'))relations.user_product_id=raw.user_product_id;
 if(Array.isArray(raw.variations))relations.variations=raw.variations.map(v=>({id:v.id,...(Object.hasOwn(v,'user_product_id')?{user_product_id:v.user_product_id}:{})}));
 return {id:raw.id,title:typeof raw.title==='string'?raw.title:null,status:raw.status??null,category_id:raw.category_id??null,catalog_listing:typeof raw.catalog_listing==='boolean'?raw.catalog_listing:null,...relations,sold_quantity:Number.isFinite(raw.sold_quantity)?raw.sold_quantity:null,available_quantity:Number.isFinite(raw.available_quantity)?raw.available_quantity:null,attributes};
}

export function createAttributeAuditRead({fetcher=(...args)=>globalThis.fetch(...args),tokenProvider=getAccessToken}={}){
 async function ml(path,token){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  let res;
  try{res=await fetcher(ML_ORIGIN+path,{method:'GET',headers:{Authorization:`Bearer ${token}`,Accept:'application/json'},redirect:'manual',signal:controller.signal});}
  catch{throw new AuditError('No se pudo conectar con Mercado Libre. Reintentá.');}
  finally{clearTimeout(timer);}
  if(!res.ok)throw new AuditError(`Mercado Libre respondió HTTP ${res.status}.`,res.status===429?429:502);
  try{return await res.json();}catch{throw new AuditError('Mercado Libre devolvió una respuesta inesperada.');}
 }
 return async function handle(request,env){
  if(request.method!=='POST')return reply({error:'Método no permitido.'},405);
  try{
   if(String(env.USER_ID)!==AUDIT_SELLER_ID)throw new AuditError('La aplicación no está configurada para la cuenta de Amado.',503);
   let body={};
   try{body=await request.json();}catch{body={};}
   const scrollId=body?.scroll_id;
   if(scrollId!==undefined&&scrollId!==null&&(typeof scrollId!=='string'||!scrollId||scrollId.length>2048))throw new AuditError('scroll_id no válido.',400);
   const token=await tokenProvider(env);
   if(typeof token!=='string'||!token)throw new AuditError('No se pudo renovar la autorización de Mercado Libre.',503);
   const query=new URLSearchParams({search_type:'scan',status:'active',limit:String(PAGE_SIZE)});
   if(scrollId)query.set('scroll_id',scrollId);
   const page=await ml(`/users/${AUDIT_SELLER_ID}/items/search?${query}`,token);
   if(!Array.isArray(page.results)||page.results.some(id=>typeof id!=='string'||!/^MLU\d+$/.test(id)))throw new AuditError('Mercado Libre devolvió un listado inesperado.');
   const items=[],failed=[];
   for(let i=0;i<page.results.length;i+=BULK_SIZE){
    const ids=page.results.slice(i,i+BULK_SIZE);
    const raw=await ml(bulkItemsPath(ids,ITEM_FIELDS)+'&include_internal_attributes=true',token);
    if(!Array.isArray(raw))throw new AuditError('Mercado Libre devolvió un lote inesperado.');
    const seen=new Set();
    for(const entry of raw){
     const item=bulkEntryItem(entry);
     if(!item)continue;
     if(!ids.includes(item.id)||String(item.seller_id)!==AUDIT_SELLER_ID)throw new AuditError('La respuesta incluye una publicación ajena o no solicitada.',403);
     seen.add(item.id);items.push(projectAuditItem(item));
    }
    for(const id of ids)if(!seen.has(id))failed.push(id);
   }
   return reply({read_only:true,seller_id:AUDIT_SELLER_ID,total:Number.isFinite(page.paging?.total)?page.paging.total:null,scroll_id:typeof page.scroll_id==='string'?page.scroll_id:null,page_empty:page.results.length===0,items,failed_ids:failed});
  }catch(error){
   return reply({error:error instanceof AuditError?error.message:'No se pudo completar la lectura.'},error instanceof AuditError?error.status:502);
  }
 };
}
export const handleAttributeAudit=createAttributeAuditRead();
