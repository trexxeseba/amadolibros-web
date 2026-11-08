// Pausa (o elimina) las publicaciones de Amado Vintage con riesgo de propiedad intelectual
// (pedido de Seba, 08/11/2026, después de la suspensión de la cuenta).
//
// Sólo toca los números de la lista aprobada (scripts/vintage-cloud/eliminar-2026-11-09.txt) y sólo
// si la publicación es de Vintage (2341378249). Por defecto PAUSA (status paused): es reversible y
// conserva el historial (decisión de Seba del 08/11, tras la evaluación externa). Con --eliminar
// cierra y borra, que es irreversible. Sin --real sólo lee e informa.
// Cada fila queda en el registro (ELIM ...) con ISBN, título y precio, para venderlos por otro lado.
//
//   node scripts/vintage-cloud/eliminar.mjs --lista <archivo> [--real] [--eliminar]
import fs from 'node:fs/promises';
import {CUENTAS} from '../../precio-ganador/src/config.mjs';
import {fuenteTokenD1} from '../../precio-ganador/src/token.mjs';
import {crearCliente} from '../../precio-ganador/src/ml.mjs';

export const SELLER='2341378249';
const FIELDS='id,seller_id,status,title,seller_custom_field,price,available_quantity,sale_terms,catalog_listing';

export async function readList(file){
 const text=await fs.readFile(file,'utf8');
 return [...new Set(text.split('\n').map(l=>l.trim()).filter(l=>/^MLU\d+$/.test(l)))];
}

// Una publicación: decide y, en real, cierra y borra. ml = {get, put}.
export async function processOne(ml,id,{real,eliminar=false}){
 let item;
 try{item=await ml.get(`/items/${id}?attributes=${FIELDS}`);}catch(e){return {id,resultado:'no_se_pudo_leer',error:e.code??String(e)};}
 const base={id,titulo:item?.title??'',isbn:String(item?.seller_custom_field??'').replace(/^AMADO-AR-/,''),precio:item?.price??null,stock:item?.available_quantity??null,a_demanda:(item?.sale_terms??[]).some(t=>t?.id==='MANUFACTURING_TIME'),estado_antes:item?.status??null};
 if(String(item?.seller_id)!==SELLER)return {...base,resultado:'otra_cuenta_no_se_toca'};
 if(!real)return {...base,resultado:eliminar?'se_eliminaria':'se_pausaria'};
 try{
  if(!eliminar){
   if(item.status==='paused')return {...base,resultado:'ya_pausada'};
   if(item.status!=='active')return {...base,resultado:'no_activa_no_se_toca'};
   await ml.put(`/items/${id}`,{status:'paused'});
   return {...base,resultado:'pausada'};
  }
  if(item.status!=='closed')await ml.put(`/items/${id}`,{status:'closed'});
  await ml.put(`/items/${id}`,{deleted:'true'});
  return {...base,resultado:'eliminada'};
 }catch(e){return {...base,resultado:'error',error:e.code??String(e),status:e.status??null};}
}

export async function run({ids,ml,real,eliminar=false,log=console.log,concurrency=2}){
 const out=[];let next=0;
 await Promise.all(Array.from({length:concurrency},async()=>{for(;;){const id=ids[next++];if(!id)return;const r=await processOne(ml,id,{real,eliminar});out.push(r);log('ELIM\t'+[r.id,r.resultado,r.isbn??'',r.a_demanda?'a_demanda':'stock',r.stock??'',r.precio??'',r.estado_antes??'',String(r.titulo??'').replace(/[\t\n]/g,' '),r.error??''].join('\t'));}}));
 const count=out.reduce((m,r)=>{m[r.resultado]=(m[r.resultado]??0)+1;return m;},{});
 return {total:ids.length,real,eliminar,resultados:count};
}

async function main(){
 const args=process.argv.slice(2),get=n=>args.includes(n)?args[args.indexOf(n)+1]:undefined;
 const ids=await readList(get('--lista'));
 const real=args.includes('--real'),eliminar=args.includes('--eliminar');
 const ml=crearCliente(fuenteTokenD1(CUENTAS.vintage),{concurrencia:2});
 const summary=await run({ids,ml,real,eliminar});
 console.log('=== ELIMINACION ===');console.log(JSON.stringify(summary));
}
if(process.argv[1]?.endsWith('eliminar.mjs'))await main();
