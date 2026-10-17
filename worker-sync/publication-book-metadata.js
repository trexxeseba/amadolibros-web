import {canonicalIsbn,PublicationError} from './publication-policy.js';

const clean=value=>String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase();
const first=(record,key)=>Array.isArray(record[key])?record[key][0]:null;
const bounded=value=>typeof value==='string'?value.trim().slice(0,300):null;

function coverImage(raw){
 try{
  const url=new URL(raw);
  if(url.protocol==='https:'&&['sbslibreria.vteximg.com.br','sbslibreria.vtexassets.com'].includes(url.hostname)&&/^\/arquivos\/ids\/\d+(?:\/|[-?]|$)/.test(url.pathname)&&!url.username&&!url.password)return {source:url.href};
 }catch{}
 return null;
}

// Public supplier metadata provides edition/cover data, never a sale price.
// A retail stock conflict must be reviewed even when the private feed has stock.
export async function supplierBookMetadata(row,{fetcher=globalThis.fetch}={}){
 if(!/^(978|979)/.test(row.isbn))throw new PublicationError('book_identifier_required',422);
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
 let products;
 try{
  const response=await fetcher('https://www.sbs.com.ar/api/catalog_system/pub/products/search?'+new URLSearchParams({ft:row.isbn,_from:'0',_to:'9'}),{method:'GET',headers:{Accept:'application/json'},redirect:'manual',signal:controller.signal});
  if(!response.ok||Number(response.headers.get('content-length')??0)>1024*1024)throw new Error('metadata_unavailable');
  const reader=response.body?.getReader();if(!reader)throw new Error('metadata_unavailable');
  const chunks=[];let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>1024*1024){await reader.cancel();throw new Error('metadata_too_large');}chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  products=JSON.parse(new TextDecoder().decode(bytes));
 }catch{throw new PublicationError('missing_verified_book_metadata',422);}
 finally{clearTimeout(timer);}
 if(!Array.isArray(products)||products.length>50)throw new PublicationError('missing_verified_book_metadata',422);
 const matches=products.filter(product=>Array.isArray(product?.ISBN)&&product.ISBN.some(value=>{try{return canonicalIsbn(value)===row.isbn;}catch{return false;}}));
 if(matches.length!==1)throw new PublicationError(matches.length?'ambiguous_supplier_book_metadata':'missing_verified_book_metadata',422);
 const product=matches[0];
 // Multiple retail SKUs can represent different formats. Do not borrow a cover
 // from a neighbouring edition or infer an ISBN from a search position.
 if(!Array.isArray(product.items)||product.items.length!==1)throw new PublicationError('ambiguous_supplier_book_metadata',422);
 const item=product.items[0];
 if(item.isKit||(item.ean&&canonicalIsbn(item.ean)!==row.isbn))throw new PublicationError('supplier_book_identity_mismatch',422);
 const offer=item.sellers?.find(seller=>seller.sellerId==='1')?.commertialOffer;
 if(offer&&(offer.IsAvailable===false||offer.AvailableQuantity===0))throw new PublicationError('supplier_stock_conflict',422);
 // Optional metadata is never invented and never required by us: a verified
 // value is sent, a missing one is omitted, and /items/validate decides what
 // Mercado Libre actually requires. Identity (above) stays our own requirement.
 const pictures=(item.images??[]).map(image=>coverImage(image.imageUrl)).filter(Boolean).slice(0,12);
 const languageText=clean(first(product,'Idioma'));
 const languages=[[/^ingles(?:\s|$)/,'Inglés'],[/^espanol(?:\s|$)/,'Español'],[/^castellano(?:\s|$)/,'Español'],[/^frances(?:\s|$)/,'Francés'],[/^portugues(?:\s|$)/,'Portugués'],[/^aleman(?:\s|$)/,'Alemán'],[/^italiano(?:\s|$)/,'Italiano']];
 const language=languages.find(([pattern])=>pattern.test(languageText))?.[1]??null;
 const bindingText=clean(first(product,'Tapa'));
 const binding=/^(rustica|blanda|paperback|softcover)$/.test(bindingText)?'Blanda':/^(dura|cartone|hardback|hardcover)$/.test(bindingText)?'Dura':null;
 const author=bounded(row.author)||bounded(first(product,'Autor')),publisher=bounded(row.publisher)||bounded(first(product,'Editorial'));
 const attributes=[{id:'GTIN',value_name:row.isbn},{id:'BOOK_TITLE',value_name:row.title.slice(0,300)}];
 for(const [id,value] of [['AUTHOR',author],['BOOK_PUBLISHER',publisher],['LANGUAGE',language],['BOOK_COVER',binding]])if(value)attributes.push({id,value_name:value});
 for(const [key,id,min,max] of [['Cantidad de páginas','PAGES_NUMBER',1,10000],['Año de edición','PUBLICATION_YEAR',1400,2100]]){
  const value=String(first(product,key)??'');if(/^\d{1,5}$/.test(value)&&Number(value)>=min&&Number(value)<=max)attributes.push({id,value_name:value});
 }
 return {domain_id:'MLU-BOOKS',attributes,pictures};
}
