import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {isIP} from 'node:net';
import {stockIsFresh} from '../../worker-sync/publication-policy.js';

export const SBS_SOURCE='https://sbs-distribuidora-lista.s3.sa-east-1.amazonaws.com/Listado+completo+de+libros.xlsx';
const destination='https://amadolibros-sync.undiaes.workers.dev/publisher/sbs-stock';
const problem=(code,detail={})=>Object.assign(new Error(code),{code,detail});
export async function parseWorkbook(bytes,{env=process.env}={}){
 const directory=await fs.mkdtemp(join(tmpdir(),'amado-sbs-'));
 try{
  const source=join(directory,'stock.xlsx'),output=join(directory,'stock.json');
  await fs.writeFile(source,bytes);
  const parser=join(dirname(fileURLToPath(import.meta.url)),'prepare-supplier-feed.py');
  const result=spawnSync(env.SBS_PYTHON||'python3',[parser,source,output,'--weight-unit',env.SUPPLIER_WEIGHT_UNIT||'kg'],{encoding:'utf8',timeout:120000,maxBuffer:65536});
  if(result.status!==0)throw problem('supplier_workbook_invalid');
  return JSON.parse(await fs.readFile(output,'utf8'));
 }finally{await fs.rm(directory,{recursive:true,force:true});}
}
export async function refreshSbsStock({env=process.env,fetchImpl=fetch,parse=parseWorkbook,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 let source;try{source=new URL(env.SUPPLIER_FEED_URL||SBS_SOURCE);}catch{throw problem('invalid_supplier_source');}
 const host=source.hostname.replace(/^\[|\]$/g,'');
 if(source.protocol!=='https:'||source.username||source.password||isIP(host)||host==='localhost'||/\.(local|internal)$/.test(host))throw problem('invalid_supplier_source');
 const headers={'Cache-Control':'no-cache'};
 if(env.SUPPLIER_FEED_AUTHORIZATION)headers.Authorization=env.SUPPLIER_FEED_AUTHORIZATION;
 let bytes,lastModified;
 try{
  const response=await fetchImpl(source,{headers,redirect:'manual',signal:AbortSignal.timeout(60000)});
  if(!response.ok||!response.body)throw problem('supplier_download_failed',{http_status:response.status});
  lastModified=response.headers.get('last-modified');
  const reader=response.body.getReader(),chunks=[];let length=0;
  for(;;){const {value,done}=await reader.read();if(done)break;length+=value.length;if(length>64*1024*1024){await reader.cancel();throw problem('supplier_file_too_large');}chunks.push(value);}
  bytes=Buffer.concat(chunks);
 }catch(error){throw error.code?error:problem('supplier_download_failed');}
 const input=await parse(bytes,{env});
 if(!stockIsFresh(input.source_date,now()))throw problem('supplier_stock_stale_or_future',{source_date:input.source_date,last_modified:lastModified});
 if(!Array.isArray(input.rows)||!input.rows.length||input.rows.length>250000)throw problem('invalid_supplier_rows');
 // No run lookup, ML token, feed attachment, publication or queue tick.
 if(!env.SYNC_SECRET)throw problem('supplier_ingestion_secret_not_configured');
 const hash=createHash('sha256').update(bytes).digest('hex');
 const feedId=`${hash.slice(0,8)}-${hash.slice(8,12)}-${hash.slice(12,16)}-${hash.slice(16,20)}-${hash.slice(20,32)}`;
 async function command(action,args){
  for(let attempt=0;attempt<3;attempt++){
   try{
    const response=await fetchImpl(destination,{method:'POST',headers:{Authorization:`Bearer ${env.SYNC_SECRET}`,'Content-Type':'application/json'},body:JSON.stringify({action,args}),redirect:'manual',signal:AbortSignal.timeout(90000)});
    let body;try{body=await response.json();}catch{throw problem('supplier_ingestion_invalid_response');}
    if(!response.ok){if(response.status>=500||response.status===429)throw problem('supplier_ingestion_retryable');throw problem('supplier_ingestion_rejected',{http_status:response.status,reason:typeof body.error==='string'&&/^[a-z_]+$/.test(body.error)?body.error:'unknown'});}
    return body;
   }catch(error){
    if(error.code==='supplier_ingestion_rejected'||attempt===2)throw error.code?error:problem('supplier_ingestion_unavailable');
    await sleep(2000*2**attempt);
   }
  }
 }
 const begin=await command('begin',{feed_id:feedId,source_date:input.source_date,source_sha256:hash,expected_rows:input.rows.length});
 if(begin.state!=='ready'){
  for(let offset=0;offset<input.rows.length;offset+=200)await command('import',{feed_id:feedId,rows:input.rows.slice(offset,offset+200)});
  await command('commit',{feed_id:feedId});
 }
 return {state:begin.state==='ready'?'unchanged':'stock_ready',feed_id:feedId,source_date:input.source_date,rows:input.rows.length,source_sha256:hash,last_modified:lastModified,publication_writes:false};
}
async function main(){
 let result;
 try{result=await refreshSbsStock();}
 catch(error){result={state:'failed',error:error.code||'supplier_refresh_failed',...error.detail,publication_writes:false};process.exitCode=1;}
 console.log(JSON.stringify(result));
 if(process.env.GITHUB_STEP_SUMMARY)await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,`### Stock SBS\n\nEstado: **${result.state}**\n\n${result.error?`Motivo: ${result.error}\n\n`:''}Fecha del proveedor: ${result.source_date||'no disponible'}\n\nSolo ingresa stock para Vintage. No publica, no actualiza precios ni cambia publicaciones de Amado Libros.\n`);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main();
