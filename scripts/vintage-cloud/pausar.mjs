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
import {ipRisk} from '../../worker-sync/ip-risk.js';

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

// Barrido previo (sólo lectura): todas las publicaciones ACTIVAS de la cuenta contra el filtro de
// propiedad intelectual. Devuelve las riesgosas que están activas y NO están en la lista aprobada
// (por ejemplo, la publicación de catálogo gemela de una tradicional que sí está en la lista).
export async function sweepActive(ml,approved,{log=console.log}={}){
 const all=[];let scroll=null;
 for(let page=0;page<400;page++){
  const q=new URLSearchParams({search_type:'scan',limit:'100',status:'active'});if(scroll)q.set('scroll_id',scroll);
  let r;try{r=await ml.get(`/users/${SELLER}/items/search?${q}`);}catch(e){log(JSON.stringify({barrido:'error_busqueda',error:e.code??String(e)}));break;}
  if(!Array.isArray(r?.results)||!r.results.length)break;all.push(...r.results);scroll=r.scroll_id??null;if(!scroll)break;
 }
 const fuera=[];
 for(let i=0;i<all.length;i+=20){
  const group=all.slice(i,i+20);
  let r;try{r=await ml.get(`/items?ids=${group.join(',')}&attributes=id,title,status,catalog_listing,catalog_product_id,seller_custom_field,attributes`);}catch(e){log(JSON.stringify({barrido:'error_detalle',error:e.code??String(e)}));continue;}
  for(const e of r??[]){
   const it=e?.body;if(e?.code!==200||!it||it.status!=='active')continue;
   const publisher=(it.attributes??[]).find(a=>['BOOK_PUBLISHER','PUBLISHER'].includes(a?.id))?.value_name??null;
   const risk=ipRisk(it.title,publisher);
   if(risk&&!approved.has(it.id)){fuera.push({id:it.id,title:it.title,grupo:risk,catalogo:it.catalog_listing===true,ficha:it.catalog_product_id??null,isbn:isbnOf(it)});log('FUERA_DE_LISTA\t'+[it.id,risk,it.catalog_listing===true?'catalogo':'tradicional',it.catalog_product_id??'',isbnOf(it),String(it.title??'').replace(/[\t\n]/g,' ')].join('\t'));}
  }
 }
 return {activas_revisadas:all.length,riesgosas_fuera_de_lista:fuera};
}

export async function run({ids,ml,real,respaldo,log=console.log,concurrency=2}){
 const out=[];let next=0;
 await Promise.all(Array.from({length:concurrency},async()=>{for(;;){const id=ids[next++];if(!id)return;const r=await processOne(ml,id,{real,respaldo});out.push(r);log('PAUSA\t'+[r.id,r.resultado,r.isbn??'',r.a_demanda?'a_demanda':'stock',r.catalogo?'catalogo':'',r.stock??'',r.precio??'',r.estado_antes??'',String(r.titulo??'').replace(/[\t\n]/g,' '),r.error??''].join('\t'));}}));
 const count=out.reduce((m,r)=>{m[r.resultado]=(m[r.resultado]??0)+1;return m;},{});
 const pendientes=out.filter(r=>['sigue_activa','error','no_se_pudo_leer'].includes(r.resultado)).map(r=>r.id);
 return {total:ids.length,real,resultados:count,sin_resolver:pendientes};
}

// Eliminar una publicación fuera de la lista (decisión de Seba, 09/11/2026: las "infectadas" que el
// barrido encuentra se eliminan, no se pausan). Respalda el JSON completo, la pausa, la cierra y la
// borra; verifica el estado final. Si Mercado Libre no deja borrarla (ventas pendientes, por ejemplo)
// queda cerrada, que ya es inactiva para siempre.
export async function eliminarUna(ml,id,{respaldo=async()=>{}}={}){
 let item;
 try{item=await ml.get(`/items/${id}`);}catch(e){return {id,resultado:'no_se_pudo_leer',error:e.code??String(e)};}
 const base={id,titulo:item?.title??'',isbn:isbnOf(item),estado_antes:item?.status??null};
 if(String(item?.seller_id)!==SELLER)return {...base,resultado:'otra_cuenta_no_se_toca'};
 await respaldo({respaldado_el:new Date().toISOString(),...item});
 try{
  if(item.status==='active')await ml.put(`/items/${id}`,{status:'paused'});
  const pausada=await ml.get(`/items/${id}`);
  if(pausada?.status==='active')return {...base,resultado:'sigue_activa'};
  if(pausada?.status!=='closed')await ml.put(`/items/${id}`,{status:'closed'});
  let borrada=false;
  try{await ml.put(`/items/${id}`,{deleted:'true'});borrada=true;}catch{borrada=false;}
  const fin=await ml.get(`/items/${id}`).catch(()=>null);
  const estado=fin?.status??'no_se_puede_leer';
  if(estado==='active')return {...base,resultado:'sigue_activa',estado_despues:estado};
  return {...base,resultado:borrada?'eliminada':'cerrada_no_borrada',estado_despues:estado};
 }catch(e){return {...base,resultado:'error',error:e.code??String(e),status:e.status??null};}
}
export const MAX_ELIMINAR_FUERA=300;

async function main(){
 const args=process.argv.slice(2),get=n=>args.includes(n)?args[args.indexOf(n)+1]:undefined;
 if(args.includes('--eliminar-lista')){
  // Eliminar la lista de infectadas (orden de Seba, 09/11/2026). Sólo con --real. Respaldo antes de cada una.
  const aEliminar=await readList(get('--eliminar-lista'));
  if(!args.includes('--real')){console.log(JSON.stringify({eliminar:'sin_real_no_se_hace_nada',total:aEliminar.length}));return;}
  const archivoE=get('--respaldo')??'artifacts/vintage/respaldo-eliminar.jsonl';
  await fs.mkdir(archivoE.replace(/[^/]*$/,'')||'.',{recursive:true});await fs.writeFile(archivoE,'');
  const respaldoE=async item=>{await fs.appendFile(archivoE,JSON.stringify(item)+'\n');};
  const mlE=crearCliente(fuenteTokenD1(CUENTAS.vintage),{concurrencia:2}),cuentaE={};let nextE=0;
  await Promise.all(Array.from({length:2},async()=>{for(;;){const id=aEliminar[nextE++];if(!id)return;const r=await eliminarUna(mlE,id,{respaldo:respaldoE});cuentaE[r.resultado]=(cuentaE[r.resultado]??0)+1;console.log('ELIMINA\t'+[r.id,r.resultado,(r.titulo??'').replace(/[\t\n]/g,' '),r.isbn??'',r.estado_despues??r.error??''].join('\t'));}}));
  console.log('=== ELIMINAR ===');console.log(JSON.stringify({total:aEliminar.length,resultados:cuentaE}));
  if((cuentaE.sigue_activa??0)>0||(cuentaE.error??0)>0||(cuentaE.no_se_pudo_leer??0)>0)process.exitCode=1;
  return;
 }
 const ids=await readList(get('--lista'));
 const real=args.includes('--real');
 const archivo=get('--respaldo')??'artifacts/vintage/respaldo-pausa.jsonl';
 if(real){await fs.mkdir(archivo.replace(/[^/]*$/,'')||'.',{recursive:true});await fs.writeFile(archivo,'');}
 const respaldo=async item=>{await fs.appendFile(archivo,JSON.stringify(item)+'\n');};
 const ml=crearCliente(fuenteTokenD1(CUENTAS.vintage),{concurrencia:2});
 // Barrido de catálogo antes de pausar: riesgosas activas que no están en la lista aprobada.
 let barrido=null;
 if(args.includes('--barrido')){barrido=await sweepActive(ml,new Set(ids));console.log('=== BARRIDO ===');console.log(JSON.stringify({...barrido,riesgosas_fuera_de_lista:barrido.riesgosas_fuera_de_lista.slice(0,200)}));}
 const summary=await run({ids,ml,real,respaldo});
 // Las riesgosas activas fuera de la lista: con --eliminar-fuera y --real se eliminan (hasta el tope;
 // si son más, algo raro pasa con el filtro y sólo se pausan).
 if(real&&barrido&&args.includes('--eliminar-fuera')){
  const fuera=barrido.riesgosas_fuera_de_lista,eliminar=fuera.length<=MAX_ELIMINAR_FUERA,cuenta={};
  if(!eliminar)console.log('FUERA_MUCHAS\t'+fuera.length+'\tsólo se pausan');
  for(const f of fuera){
   const r=eliminar?await eliminarUna(ml,f.id,{respaldo}):await processOne(ml,f.id,{real:true,respaldo});
   cuenta[r.resultado]=(cuenta[r.resultado]??0)+1;
   console.log((eliminar?'ELIMINA':'PAUSA_FUERA')+'\t'+[r.id,r.resultado,(r.titulo??'').replace(/[\t\n]/g,' '),r.isbn??'',r.estado_despues??r.error??''].join('\t'));
  }
  console.log('=== FUERA_DE_LISTA ===');console.log(JSON.stringify({total:fuera.length,accion:eliminar?'eliminar':'pausar',resultados:cuenta}));
  if((cuenta.sigue_activa??0)>0)process.exitCode=1;
 }
 console.log('=== PAUSA ===');console.log(JSON.stringify({...summary,fuera_de_lista:barrido?barrido.riesgosas_fuera_de_lista.length:null}));
 if(real&&summary.sin_resolver.length)process.exitCode=1;
}
if(process.argv[1]?.endsWith('pausar.mjs'))await main();
