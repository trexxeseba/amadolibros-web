// Pausa preventiva en Amado Vintage (seller 2341378249) de las publicaciones ACTIVAS que:
//  - son de las editoriales Hodder Education, Alma Edizioni o Eli Edizioni (campo editorial o título), o
//  - mencionan ebook, e-book, libro electrónico, acceso digital o simplemente "digital" en el título o en la descripción.
// Orden de Seba, 09/11/2026: sólo Vintage, PAUSAR (no eliminar), guardar el listado con ID, título y
// motivo. Una publicación que cumple varios motivos se cuenta una sola vez (el primero en el orden
// editorial, título, descripción). Nunca toca otra cuenta: processOne revisa el vendedor.
//
//   node scripts/vintage-cloud/pausar-ebook.mjs [--real] [--sin-descripciones] [--respaldo <archivo.jsonl>]
import fs from 'node:fs/promises';
import {CUENTAS} from '../../precio-ganador/src/config.mjs';
import {fuenteTokenD1} from '../../precio-ganador/src/token.mjs';
import {crearCliente} from '../../precio-ganador/src/ml.mjs';
import {normalizeText} from '../../worker-sync/ip-risk.js';
import {processOne,SELLER} from './pausar.mjs';

export const MAX_PAUSAR=6000;
const PUBLISHER_FIELD=/^hodder\b|^(alma|eli)( edizioni)?$/;
const PUBLISHER_TITLE=/\b(hodder|alma edizioni|eli edizioni)\b/;
// Regla más dura (Seba, 09/11/2026: "siempre priorizamos la cuenta sobre un libro"): "digital" sola también cuenta,
// igual que en el filtro de altas (worker-sync/ip-risk.js).
const EBOOK=/\be ?books?\b|\blibro electronico\b|\bacceso digital\b|\bdigital(es)?\b/;

// Motivo por el que una publicación se pausa según su título y su editorial, o null.
export function motivoPorFicha({title,publisher}){
 const pub=normalizeText(publisher),tit=normalizeText(title);
 if(PUBLISHER_FIELD.test(pub)||PUBLISHER_TITLE.test(pub))return 'editorial';
 if(PUBLISHER_TITLE.test(tit))return 'editorial';
 if(EBOOK.test(tit))return 'ebook_en_titulo';
 return null;
}
export const motivoPorDescripcion=text=>EBOOK.test(normalizeText(text))?'ebook_en_descripcion':null;
const publisherOf=it=>(it?.attributes??[]).find(a=>['BOOK_PUBLISHER','PUBLISHER'].includes(a?.id))?.value_name??'';

export async function listActive(ml,log=console.log){
 const all=[];let scroll=null;
 for(let page=0;page<400;page++){
  const q=new URLSearchParams({search_type:'scan',limit:'100',status:'active'});if(scroll)q.set('scroll_id',scroll);
  let r;try{r=await ml.get(`/users/${SELLER}/items/search?${q}`);}catch(e){log(JSON.stringify({barrido:'error_busqueda',error:e.code??String(e)}));break;}
  if(!Array.isArray(r?.results)||!r.results.length)break;all.push(...r.results);scroll=r.scroll_id??null;if(!scroll)break;
 }
 return all;
}

// Devuelve {revisadas,coincidencias:[{id,title,motivo}]}. Primero título y editorial; la descripción
// (una lectura por publicación) sólo para las que no coincidieron, salvo conDescripciones=false.
export async function buscar(ml,{conDescripciones=true,concurrency=4,log=console.log}={}){
 const all=await listActive(ml,log),hits=new Map(),rest=[];
 for(let i=0;i<all.length;i+=20){
  const group=all.slice(i,i+20);
  let r;try{r=await ml.get(`/items?ids=${group.join(',')}&attributes=id,title,status,attributes`);}catch(e){log(JSON.stringify({barrido:'error_detalle',error:e.code??String(e)}));continue;}
  for(const e of r??[]){
   const it=e?.body;if(e?.code!==200||!it||it.status!=='active')continue;
   const motivo=motivoPorFicha({title:it.title,publisher:publisherOf(it)});
   if(motivo)hits.set(it.id,{id:it.id,title:it.title,motivo});else rest.push({id:it.id,title:it.title});
  }
 }
 let sinDescripcion=0;
 if(conDescripciones){
  let next=0;
  await Promise.all(Array.from({length:concurrency},async()=>{for(;;){
   const it=rest[next++];if(!it)return;
   let d;try{d=await ml.get(`/items/${it.id}/description`);}catch{sinDescripcion++;continue;}
   const motivo=motivoPorDescripcion(d?.plain_text??d?.text??'');
   if(motivo)hits.set(it.id,{id:it.id,title:it.title,motivo});
  }}));
 }
 const coincidencias=[...hits.values()];
 for(const h of coincidencias)log('EBOOK\t'+[h.id,h.motivo,String(h.title??'').replace(/[\t\n]/g,' ')].join('\t'));
 return {revisadas:all.length,sin_descripcion:sinDescripcion,coincidencias};
}

async function main(){
 const args=process.argv.slice(2),get=n=>args.includes(n)?args[args.indexOf(n)+1]:undefined,real=args.includes('--real');
 const ml=crearCliente(fuenteTokenD1(CUENTAS.vintage),{concurrencia:4});
 const found=await buscar(ml,{conDescripciones:!args.includes('--sin-descripciones')});
 const porMotivo={};for(const h of found.coincidencias)porMotivo[h.motivo]=(porMotivo[h.motivo]??0)+1;
 console.log('=== BUSQUEDA ===');console.log(JSON.stringify({revisadas:found.revisadas,sin_descripcion:found.sin_descripcion,a_pausar:found.coincidencias.length,por_motivo:porMotivo}));
 if(found.coincidencias.length>MAX_PAUSAR){console.log(JSON.stringify({pausa:'no_se_hace',motivo:'demasiadas_coincidencias',tope:MAX_PAUSAR}));process.exitCode=1;return;}
 if(!real)return;
 const archivo=get('--respaldo')??'artifacts/vintage/respaldo-ebook.jsonl';
 await fs.mkdir(archivo.replace(/[^/]*$/,'')||'.',{recursive:true});await fs.writeFile(archivo,'');
 const respaldo=async item=>{await fs.appendFile(archivo,JSON.stringify(item)+'\n');};
 const cuenta={};let next=0;
 await Promise.all(Array.from({length:2},async()=>{for(;;){const h=found.coincidencias[next++];if(!h)return;const r=await processOne(ml,h.id,{real:true,respaldo});cuenta[r.resultado]=(cuenta[r.resultado]??0)+1;console.log('PAUSA_EBOOK\t'+[r.id,h.motivo,r.resultado,String(r.titulo??h.title??'').replace(/[\t\n]/g,' '),r.error??''].join('\t'));}}));
 console.log('=== PAUSA_EBOOK ===');console.log(JSON.stringify({total:found.coincidencias.length,resultados:cuenta}));
 if((cuenta.sigue_activa??0)>0||(cuenta.error??0)>0||(cuenta.no_se_pudo_leer??0)>0)process.exitCode=1;
}
if(process.argv[1]?.endsWith('pausar-ebook.mjs'))await main();
