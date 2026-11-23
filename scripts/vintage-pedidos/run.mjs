import {pathToFileURL} from 'node:url';
import {fuenteTokenD1} from '../../precio-ganador/src/token.mjs';
import {CUENTAS} from '../../precio-ganador/src/config.mjs';
import {BASE,TABLE,SELLER,F,START,fail,safeError,syncSales,id} from './core.mjs';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export function clients({env=process.env,fetcher=fetch,tokenSource}={}) {
 if(!env.AIRTABLE_TOKEN)throw fail('falta_airtable_token');
 const source=tokenSource||fuenteTokenD1(CUENTAS.vintage,{esperaMaxMs:0});
 async function json(url,options,service){
  let res;
  try{res=await fetcher(url,{...options,redirect:'error',signal:AbortSignal.timeout(25000)});}
  catch{throw fail(service+'_transporte');}
  if(!res.ok)throw fail(service+'_http_'+res.status);
  try{return await res.json();}catch{throw fail(service+'_json_invalido');}
 }
 async function mlRequest(method,path,body){
  if(!path.startsWith('/'))throw fail('ruta_invalida');
  return json('https://api.mercadolibre.com'+path,{
   method,headers:{Authorization:'Bearer '+await source.getToken(),'Content-Type':'application/json','X-Public':'true'},
   ...(body?{body:JSON.stringify(body)}:{})
  },'ml');
 }
 let lastAt=0;
 async function ar(method,path='',body){
  await sleep(Math.max(0,260-(Date.now()-lastAt)));lastAt=Date.now();
  return json('https://api.airtable.com/v0/'+BASE+'/'+TABLE+path,{
   method,headers:{Authorization:'Bearer '+env.AIRTABLE_TOKEN,'Content-Type':'application/json'},
   ...(body?{body:JSON.stringify(body)}:{})
  },'airtable');
 }
 const at={
  async list(){
   const rows=[];let offset;
   for(let page=0;page<100;page++){
    const q=new URLSearchParams({pageSize:'100',filterByFormula:"AND({ML Venta ID}!='',FIND('AMADO_VINTAGE',{Detalle canal}))"});
    for(const field of Object.values(F))q.append('fields[]',field);
    if(offset)q.set('offset',offset);
    const d=await ar('GET','?'+q);
    if(!Array.isArray(d.records))throw fail('airtable_respuesta_invalida');
    rows.push(...d.records);
    if(!d.offset)return rows;
    offset=d.offset;
   }
   throw fail('airtable_paginacion_incompleta');
  },
  async get(recordId){
   if(!/^rec[a-zA-Z0-9]+$/.test(recordId))throw fail('registro_invalido');
   return ar('GET','/'+recordId);
  },
  async patch(recordId,fields){
   if(!/^rec[a-zA-Z0-9]+$/.test(recordId))throw fail('registro_invalido');
   return ar('PATCH','/'+recordId,{fields});
  },
  async upsert(fields){
   // Only the ID is sent to an existing record: never reset human progress on retries.
   const d=await ar('PATCH','',{performUpsert:{fieldsToMergeOn:[F.id]},records:[{fields:{[F.id]:fields[F.id]}}]});
   const row=d.records?.[0];if(!row?.id)throw fail('airtable_upsert_invalido');
   const isNew=(d.createdRecords||[]).includes(row.id);
   if(isNew || !row.fields?.[F.detail]){
    // If the process died between ID reservation and initialization, recover it.
    // Importer-owned rows without channel are included in list() via recovery search.
    return at.patch(row.id,fields);
   }
   return row;
  }
 };
 const ml={
  get:path=>mlRequest('GET',path),
  write:(method,path,body)=>mlRequest(method,path,body),
  reportError:code=>console.error('Sincronización: '+code),
  async search(start){
   if(!Number.isFinite(Date.parse(start))||Date.parse(start)<Date.parse(START))throw fail('fecha_inicio_invalida');
   const found=[];const to=new Date().toISOString();
   for(let offset=0;offset<10000;offset+=50){
    const q=new URLSearchParams({seller:SELLER,'order.date_created.from':start,'order.date_created.to':to,sort:'date_desc',limit:'50',offset:String(offset)});
    const d=await ml.get('/orders/search?'+q);
    if(!Array.isArray(d.results)||!Number.isInteger(d.paging?.total))throw fail('ventas_respuesta_invalida');
    for(const o of d.results)found.push(id(o.id));
    if(offset+d.results.length>=d.paging.total)return found;
    if(!d.results.length)throw fail('ventas_paginacion_incompleta');
   }
   throw fail('ventas_superan_limite_paginacion');
  }
 };
 return {ml,at};
}
export async function main(){
 const real=process.argv.includes('--real');
 if(real && process.env.GITHUB_REF!=='refs/heads/main')throw fail('escritura_solo_main');
 const {ml,at}=clients();
 const stats=await syncSales({ml,at,real});
 console.log(JSON.stringify({mode:real?'real':'prueba',...stats}));
 if(stats.errors)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 main().catch(e=>{console.error('Sincronización detenida: '+safeError(e));process.exitCode=1;});
}
