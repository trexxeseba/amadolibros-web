// Pausa de las publicaciones de Amado Vintage con riesgo de propiedad intelectual
// (decisión de Seba, 08/11/2026: pausar, no eliminar; pausar permite revisar y conserva todo).
//
// Sólo toca los números de la lista aprobada (scripts/vintage-cloud/pausar-2026-11-09.txt) y sólo
// si la publicación es de Vintage (2341378249). Por cada una:
//   1. guarda un respaldo completo de la publicación (JSON) antes de tocarla;
//   2. la pone en pausa (status paused), sin cerrar ni borrar nada;
//   3. vuelve a leerla y registra el estado final: pausada, ya inactiva, ya cerrada, falló o sigue activa.
// Sin --real sólo lee e informa. El objetivo verificable: ninguna del conjunto queda activa.
//
//   node scripts/vintage-cloud/pausar.mjs --lista <archivo> [--real] [--respaldo <archivo.jsonl>]
import fs from 'node:fs/promises';
import {CUENTAS} from '../../precio-ganador/src/config.mjs';
import {fuenteTokenD1} from '../../precio-ganador/src/token.mjs';
import {crearCliente} from '../../precio-ganador/src/ml.mjs';

export const SELLER='2341378249';

export async function readList(file){
 const text=await fs.readFile(file,'utf8');
 return [...new Set(text.split('\n').map(l=>l.trim()).filter(l=>/^MLU\d+$/.test(l)))];
}

const isbnOf=item=>String(item?.seller_custom_field??'').replace(/^AMADO-AR-/,'');

// Una publicación: respalda, pausa (en real) y verifica. ml = {get, put}. respaldo(item) guarda el JSON completo.
export async function processOne(ml,id,{real,respaldo=async()=>{}}){
 let item;
 try{item=await ml.get(`/items/${id}`);}catch(e){return {id,resultado:'no_se_pudo_leer',error:e.code??String(e)};}
 const base={id,titulo:item?.title??'',isbn:isbnOf(item),precio:item?.price??null,stock:item?.available_quantity??null,a_demanda:(item?.sale_terms??[]).some(t=>t?.id==='MANUFACTURING_TIME'),catalogo:Boolean(item?.catalog_listing),estado_antes:item?.status??null};
 if(String(item?.seller_id)!==SELLER)return {...base,resultado:'otra_cuenta_no_se_toca'};
 if(!real)return {...base,resultado:item.status==='active'?'se_pausaria':'ya_no_esta_activa'};
 await respaldo({respaldado_el:new Date().toISOString(),...item});
 if(item.status!=='active'&&item.status!=='paused')return {...base,resultado:'ya_inactiva'}; // cerrada, inactiva por denuncia, etc.
 try{
  if(item.status==='active')await ml.put(`/items/${id}`,{status:'paused'});
  const despues=await ml.get(`/items/${id}`);
  if(despues?.status==='active')return {...base,resultado:'sigue_activa',estado_despues:despues.status};
  return {...base,resultado:'pausada',estado_despues:despues?.status??null};
 }catch(e){return {...base,resultado:'error',error:e.code??String(e),status:e.status??null};}
}

export async function run({ids,ml,real,respaldo,log=console.log,concurrency=2}){
 const out=[];let next=0;
 await Promise.all(Array.from({length:concurrency},async()=>{for(;;){const id=ids[next++];if(!id)return;const r=await processOne(ml,id,{real,respaldo});out.push(r);log('PAUSA\t'+[r.id,r.resultado,r.isbn??'',r.a_demanda?'a_demanda':'stock',r.catalogo?'catalogo':'',r.stock??'',r.precio??'',r.estado_antes??'',String(r.titulo??'').replace(/[\t\n]/g,' '),r.error??''].join('\t'));}}));
 const count=out.reduce((m,r)=>{m[r.resultado]=(m[r.resultado]??0)+1;return m;},{});
 const pendientes=out.filter(r=>['sigue_activa','error','no_se_pudo_leer'].includes(r.resultado)).map(r=>r.id);
 return {total:ids.length,real,resultados:count,sin_resolver:pendientes};
}

async function main(){
 const args=process.argv.slice(2),get=n=>args.includes(n)?args[args.indexOf(n)+1]:undefined;
 const ids=await readList(get('--lista'));
 const real=args.includes('--real');
 const archivo=get('--respaldo')??'artifacts/vintage/respaldo-pausa.jsonl';
 if(real){await fs.mkdir(archivo.replace(/[^/]*$/,'')||'.',{recursive:true});await fs.writeFile(archivo,'');}
 const respaldo=async item=>{await fs.appendFile(archivo,JSON.stringify(item)+'\n');};
 const ml=crearCliente(fuenteTokenD1(CUENTAS.vintage),{concurrencia:2});
 const summary=await run({ids,ml,real,respaldo});
 console.log('=== PAUSA ===');console.log(JSON.stringify(summary));
 if(real&&summary.sin_resolver.length)process.exitCode=1;
}
if(process.argv[1]?.endsWith('pausar.mjs'))await main();
