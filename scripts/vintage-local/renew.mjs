// Renueva desde la PC la conexión local de Vintage, sin navegador.
//
// 1. Descarga el Excel público del proveedor y lo guarda donde el motor lo lee.
// 2. Lo lee con el mismo lector que el panel (misma fecha interna y mismo hash).
// 3. Revoca la conexión anterior, carga el stock en D1 y pide una conexión nueva
//    a /operations/vintage-renew con VINTAGE_RENEW_SECRET.
// 4. Guarda la conexión en el archivo que usa engine.mjs.
// No hace ninguna llamada a Mercado Libre ni crea publicaciones.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {inspectWorkbook,checkConfiguration} from './engine.mjs';
import {stockIsFresh} from '../../worker-sync/publication-policy.js';

export const SBS_SOURCE='https://sbs-distribuidora-lista.s3.sa-east-1.amazonaws.com/Listado+completo+de+libros.xlsx';
export const RENEW_ENDPOINT='https://www.amadolibros.com/operations/vintage-renew';
const MAX_BYTES=64*1024*1024,MIN_ROWS=10000;
const problem=(code,detail={})=>Object.assign(new Error(code),{code,detail});

export function feedIdFromHash(hash){
 if(!/^[a-f0-9]{64}$/.test(hash))throw problem('invalid_stock_hash');
 return `${hash.slice(0,8)}-${hash.slice(8,12)}-${hash.slice(12,16)}-${hash.slice(16,20)}-${hash.slice(20,32)}`;
}
async function writeAtomic(file,data){
 await fs.mkdir(path.dirname(file),{recursive:true});
 const temp=file+'.tmp';await fs.writeFile(temp,data);await fs.rename(temp,file);
}
export async function downloadStock(source,{fetcher=fetch}={}){
 const response=await fetcher(source,{headers:{'Cache-Control':'no-cache'},redirect:'manual',signal:AbortSignal.timeout(120000)});
 if(!response.ok||!response.body)throw problem('supplier_download_failed',{http_status:response.status});
 const reader=response.body.getReader(),chunks=[];let length=0;
 for(;;){const {value,done}=await reader.read();if(done)break;length+=value.length;if(length>MAX_BYTES){await reader.cancel();throw problem('supplier_file_too_large');}chunks.push(value);}
 return Buffer.concat(chunks);
}
export function makeRenewClient(secret,{fetcher=fetch,endpoint=RENEW_ENDPOINT}={}){
 if(typeof secret!=='string'||secret.length<32)throw problem('renew_secret_missing');
 return async(action,args={})=>{
  const response=await fetcher(endpoint,{method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:JSON.stringify({action,args}),redirect:'manual',signal:AbortSignal.timeout(90000)});
  let body;try{body=await response.json();}catch{throw problem('renew_invalid_response',{http_status:response.status});}
  if(!response.ok)throw problem(/^[a-z0-9_]{1,100}$/.test(body?.error??'')?body.error:'renew_rejected',{http_status:response.status,action});
  return body;
 };
}
export async function renewConnection({excel,connection,secret,source=SBS_SOURCE,fetcher=fetch,inspect=inspectWorkbook,now=Date.now,log=()=>{}}){
 const bytes=await downloadStock(source,{fetcher});
 await writeAtomic(excel,bytes);
 const input=await inspect(excel);
 if(!stockIsFresh(input.source_date,now()))throw problem('supplier_stock_stale',{source_date:input.source_date});
 if(!Array.isArray(input.rows)||input.rows.length<MIN_ROWS)throw problem('supplier_rows_below_minimum',{rows:input.rows?.length??0});
 const feed_id=feedIdFromHash(input.source_sha256),post=makeRenewClient(secret,{fetcher});
 log({step:'revoke'});await post('revoke');
 const begin=await post('begin',{feed_id,source_date:input.source_date,source_sha256:input.source_sha256,expected_rows:input.rows.length});
 if(begin.state!=='ready'){
  for(let i=0;i<input.rows.length;i+=200){await post('import',{feed_id,rows:input.rows.slice(i,i+200)});if(i%2000===0)log({step:'import',done:Math.min(i+200,input.rows.length),total:input.rows.length});}
  await post('commit',{feed_id});
 }
 log({step:'renew'});
 const c=await post('renew',{feed_id});
 checkConfiguration(c);
 await writeAtomic(connection,JSON.stringify(c,null,2));
 return {state:'renewed',feed_id,source_date:input.source_date,rows:input.rows.length,expires_at:c.expires_at,published_receipts:(c.receipts??[]).filter(r=>r.state==='published').length};
}
async function main(){
 const args=process.argv.slice(2),get=name=>args.includes(name)?args[args.indexOf(name)+1]:undefined;
 let secret=process.env.VINTAGE_RENEW_SECRET;
 if(!secret&&get('--secret-file'))secret=(await fs.readFile(get('--secret-file'),'utf8')).trim();
 try{
  const result=await renewConnection({excel:get('--excel'),connection:get('--connection'),secret,source:get('--source')||SBS_SOURCE,log:x=>console.log(JSON.stringify(x))});
  console.log(JSON.stringify(result));
 }catch(error){
  const code=/^[a-z0-9_]{1,100}$/.test(error.code??'')?error.code:'renew_failed';
  console.log(JSON.stringify({state:'failed',error:code,...(error.detail??{})}));
  process.exitCode=code==='supplier_stock_stale'||code==='supplier_stock_stale_or_future'?3:2;
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main();
