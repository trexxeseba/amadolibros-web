// Diagnostic only: GET to fixed MLU resources, SELECT for existing token.
// No item writes, token refresh, catalog corrections or synchronization POST.
import fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {checkPage} from './read-hundred-groups.mjs';
export const CASES=[
 {target:'MLU701279056',peer:'MLU1431940402',product:'MLU73380330',up:'MLUU2753362935',attribute:'BOOK_GENRE',expected:'Diccionarios, enciclopedias y consulta'},
 {target:'MLU729955092',peer:'MLU729785934',product:'MLU42134440',up:'MLUU3169720230',attribute:'BOOK_GENRE',expected:'Literatura'},
 {target:'MLU602635497',peer:'MLU651588080',product:'MLU23597659',up:'MLUU2440175144',attribute:'PUBLICATION_YEAR',expected:'2014'}
];
const SELLER='440298103',DB='6dc8dc3a-2d4f-4045-b428-14323c7b0bcd',APP='4741021817925208';
const fixed=new Set(['/users/me','/categories/MLU1196/attributes','/categories/MLU1196/technical_specs/input',...CASES.flatMap(c=>[`/products/${c.product}`,`/user-products/${c.up}`,...[c.target,c.peer].flatMap(id=>[`/items/${id}?include_internal_attributes=true`,`/public/buybox/sync/${id}`])])]);
export function allowedPath(path){
 if(fixed.has(path))return true;
 const u=new URL(path,'https://api.mercadolibre.com');
 return u.origin==='https://api.mercadolibre.com'&&u.pathname==='/users/440298103/items/search'&&[...u.searchParams.keys()].every(k=>['user_product_id','limit','offset','status'].includes(k))&&CASES.some(c=>c.up===u.searchParams.get('user_product_id'))&&u.searchParams.get('limit')==='100'&&/^\d+$/.test(u.searchParams.get('offset')??'')&&Number(u.searchParams.get('offset'))<=1000&&['','active','paused','closed','under_review'].includes(u.searchParams.get('status')??'');
}
export function makeDiagnosticReader(token,fetcher=fetch){return async(path,method='GET')=>{
 if(method!=='GET'||!allowedPath(path))throw Error('diagnostic_path_or_method_forbidden');
 const response=await fetcher('https://api.mercadolibre.com'+path,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(30000),headers:{Authorization:'Bearer '+token,Accept:'application/json',...(path.startsWith('/public/buybox/sync/')?{'x-public':'true'}:{})}});
 const text=await response.text();let body;try{body=text.trim()?JSON.parse(text):null;}catch{body={unparseable_response:true,length:text.length};}
 return {path,status:response.status,ok:response.ok&&body!==null&&!body.unparseable_response,body,headers:Object.fromEntries(['x-request-id','x-correlation-id','x-content-missing'].map(k=>[k,response.headers.get(k)]).filter(([,v])=>v)),read_at:new Date().toISOString()};
};}
async function main(){
 const dir=process.argv[2];if(!dir)throw Error('output_required');
 const account=process.env.CLOUDFLARE_ACCOUNT_ID,cf=process.env.CLOUDFLARE_API_TOKEN;if(!/^[a-f0-9]{32}$/.test(account??'')||!cf)throw Error('cloudflare_auth_missing');
 const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${DB}/query`,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(30000),headers:{Authorization:'Bearer '+cf,'Content-Type':'application/json'},body:JSON.stringify({sql:'SELECT access_token,access_expires_at FROM ml_oauth WHERE app_id=?',params:[APP]})});
 if(!response.ok)throw Error('token_read_failed');const b=await response.json(),row=b.success&&b.result?.[0]?.results?.[0];
 if(!row?.access_token||Number(row.access_expires_at)-Date.now()<120000)throw Error('existing_token_unavailable_or_expiring');
 const get=makeDiagnosticReader(row.access_token);delete row.access_token;
 const accountRead=await get('/users/me');if(!accountRead.ok||String(accountRead.body.id)!==SELLER)throw Error('wrong_seller');
 const report={seller_id:SELLER,read_only:true,ml_methods:['GET'],started_at:new Date().toISOString(),reads:[],cases:[],complete:false};
 async function read(path){const r=await get(path);report.reads.push(r);return r;}
 async function save(){await fs.mkdir(dir,{recursive:true});await fs.writeFile(dir+'/diagnostico-catalogo.json',JSON.stringify(report,null,2));}
 try{
  report.schema=await read('/categories/MLU1196/attributes');report.input_specs=await read('/categories/MLU1196/technical_specs/input');
  for(const c of CASES){
   const result={...c,items:[],queries:[],identity_valid:false};report.cases.push(result);
   for(const id of [c.target,c.peer]){const r=await read(`/items/${id}?include_internal_attributes=true`);if(!r.ok||r.body.id!==id||String(r.body.seller_id)!==SELLER||r.body.user_product_id!==c.up||r.body.catalog_product_id!==c.product)throw Error('item_identity_changed');result.items.push(r.body);}
   result.identity_valid=true;
   for(const status of ['', 'active','paused','closed','under_review']){
    const found=new Set();let total;
    for(let offset=0;;offset+=100){const q=new URLSearchParams({user_product_id:c.up,limit:'100',offset:String(offset)});if(status)q.set('status',status);const r=await read('/users/'+SELLER+'/items/search?'+q);if(!r.ok)throw Error('group_query_failed');const t=checkPage(r.body,offset);if(total!==undefined&&t!==total)throw Error('group_total_changed');total=t;for(const id of r.body.results){if(found.has(id))throw Error('duplicate_group_member');found.add(id);}if(found.size===total)break;}
    const ids=[...found].sort(),expected=['','active'].includes(status)?[c.target,c.peer].sort():[];
    if(JSON.stringify(ids)!==JSON.stringify(expected))throw Error('group_changed');result.queries.push({status:status||'all',ids,complete:true});
   }
   result.product=await read('/products/'+c.product);if(result.product.ok&&result.product.body.id!==c.product)throw Error('unexpected_product_id');
   result.user_product=await read('/user-products/'+c.up);if(result.user_product.ok){const up=result.user_product.body;if(up.id!==c.up||[up.user_id,up.seller_id].filter(v=>v!=null).some(v=>String(v)!==SELLER))throw Error('unexpected_user_product');}
   result.sync=[];for(const id of [c.target,c.peer])result.sync.push(await read('/public/buybox/sync/'+id));
   await save();
  }
  report.complete=report.cases.length===3&&report.cases.every(c=>c.identity_valid&&c.queries.length===5);
 }catch(e){report.stopped=e.message;process.exitCode=1;}
 finally{report.completed_at=new Date().toISOString();await save();console.log(JSON.stringify({read_only:true,complete:report.complete,cases:report.cases.length,read_requests:report.reads.length,failed_reads:report.reads.filter(r=>!r.ok).map(r=>({path:r.path,status:r.status})),stopped:report.stopped}));}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{console.error(/^[a-z0-9_]+$/.test(e.message)?e.message:'diagnostic_failed_credentials_redacted');process.exitCode=1;});
