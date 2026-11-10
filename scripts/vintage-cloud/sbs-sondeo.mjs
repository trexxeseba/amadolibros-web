// Sondeo de SÓLO LECTURA de las listas de precios del portal de SBS (la completa, AllPriceList, daba
// error interno el 10/11/2026). Baja cada lista del menú Catálogo y cuenta filas, fecha y ISBN únicos.
// No escribe en D1, no toca Mercado Libre y no guarda los archivos.
//
//   SBS_EMAIL=... SBS_PASSWORD=... node --experimental-sqlite scripts/vintage-cloud/sbs-sondeo.mjs
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {sbsLogin,downloadStock,SBS_PORTAL} from '../vintage-local/renew.mjs';
import {inspectWorkbook} from '../vintage-local/engine.mjs';

export const RUTAS=['/Home/AllPriceList','/Home/GeneralPriceList','/Home/SpanishPriceList','/Home/LanguagesPriceList','/Home/Last15DaysModifiedPriceList'];

export async function sondear({email,password,fetcher=fetch,inspect=inspectWorkbook,log=console.log,dir=null}={}){
 const sesion=await sbsLogin({email,password,fetcher});
 const tmp=dir??await fs.mkdtemp(path.join(os.tmpdir(),'sbs-sondeo-'));
 const out=[];
 for(const ruta of RUTAS){
  const r={ruta};
  try{
   const bytes=await downloadStock(SBS_PORTAL+ruta,{fetcher,cookie:sesion.cookie,origin:sesion.origin});
   const file=path.join(tmp,ruta.split('/').pop()+'.xlsx');await fs.writeFile(file,bytes);
   const x=await inspect(file);
   r.bytes=bytes.length;r.filas=x.rows?.length??null;r.fecha=x.source_date??null;r.isbn_unicos=new Set((x.rows??[]).map(f=>f.isbn)).size;
   r.con_stock=(x.rows??[]).filter(f=>Number(f.stock)>0).length;
   r.muestra=(x.rows??[]).slice(0,2).map(f=>({isbn:f.isbn,stock:f.stock}));
   await fs.rm(file,{force:true});
  }catch(e){r.error=e.code??String(e);r.http=e.detail?.http_status??null;}
  log(JSON.stringify(r));out.push(r);
 }
 return out;
}

async function main(){
 const out=await sondear({email:process.env.SBS_EMAIL,password:process.env.SBS_PASSWORD});
 console.log('=== SONDEO SBS ===');console.log(JSON.stringify(out));
}
if(process.argv[1]?.endsWith('sbs-sondeo.mjs'))await main();
