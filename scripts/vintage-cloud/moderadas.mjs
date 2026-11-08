// Diagnóstico de SÓLO LECTURA de las publicaciones de Amado Vintage moderadas por Mercado Libre
// (suspensión del 08/11/2026 por propiedad intelectual). Sólo GET a Mercado Libre y SELECT a D1:
// no cambia ninguna publicación ni ningún dato.
//
// 1. Busca las publicaciones de la cuenta en estados de moderación (under_review, inactive y las
//    pausadas con sub_status de moderación) y pide su detalle por /items/bulk.
// 2. Pide las infracciones de la cuenta (/moderations/infractions/{seller}) si el endpoint responde.
// 3. Cruza cada una con los recibos de la campaña en D1 (si la creó el publicador, cuándo) y separa
//    por catálogo / sin catálogo, día de creación, editorial y motivo.
//
//   node scripts/vintage-cloud/moderadas.mjs --salida <carpeta>
import fs from 'node:fs/promises';
import path from 'node:path';
import {CUENTAS} from '../../precio-ganador/src/config.mjs';
import {fuenteTokenD1} from '../../precio-ganador/src/token.mjs';
import {crearCliente} from '../../precio-ganador/src/ml.mjs';
import {d1Client} from './d1.mjs';

const SELLER='2341378249';
const MODERATION=/forbidden|infring|intellectual|copyright|counterfeit|replica|moderat|deleted|suspended|under_review|banned|warning|picture|freeze/i;
const FIELDS='id,title,status,sub_status,catalog_listing,catalog_product_id,date_created,last_updated,seller_custom_field,tags,health,pictures,attributes';

export function classify(item,receipt){
 const pub=(item.attributes??[]).find(a=>a.id==='BOOK_PUBLISHER')?.value_name??(item.attributes??[]).find(a=>a.id==='PUBLISHER')?.value_name??null;
 return {
  id:item.id,title:item.title,status:item.status,sub_status:item.sub_status??[],tags:(item.tags??[]).filter(t=>MODERATION.test(t)),
  catalogo:item.catalog_listing===true,date_created:item.date_created,dia:String(item.date_created??'').slice(0,10),
  sku:item.seller_custom_field??null,editorial:pub,fotos:(item.pictures??[]).length,
  origen:receipt?(receipt.created_at>=Date.parse('2026-11-05T17:00:00Z')?'nube':'pc_o_web'):'fuera_de_la_campaña',
 };
}
export const isModerated=item=>['under_review','inactive'].includes(item.status)||(item.sub_status??[]).some(s=>MODERATION.test(s))||(item.tags??[]).some(t=>MODERATION.test(t));

async function main(){
 const args=process.argv.slice(2),out=args[args.indexOf('--salida')+1]??'.';
 const ml=crearCliente(fuenteTokenD1(CUENTAS.vintage),{concurrencia:3});
 const query=d1Client();
 const ids=new Set();
 for(const status of ['under_review','inactive','paused']){
  let scroll=null;
  for(let page=0;page<400;page++){
   const q=new URLSearchParams({search_type:'scan',limit:'100',status});if(scroll)q.set('scroll_id',scroll);
   let r;try{r=await ml.get(`/users/${SELLER}/items/search?${q}`);}catch(e){console.log(JSON.stringify({buscar:status,error:e.code??String(e)}));break;}
   if(!Array.isArray(r?.results)||!r.results.length)break;
   r.results.forEach(id=>ids.add(id));scroll=r.scroll_id??null;if(!scroll)break;
  }
  console.log(JSON.stringify({estado:status,acumuladas:ids.size}));
 }
 const all=[...ids],items=[];
 for(let i=0;i<all.length;i+=20){
  const group=all.slice(i,i+20);
  try{const r=await ml.get(`/items?ids=${group.join(',')}&attributes=${FIELDS}`);for(const e of r??[])if(e?.code===200&&e.body)items.push(e.body);}
  catch{try{const r=await ml.get(`/items/bulk?ids=${group.join(',')}&attributes=${FIELDS}`);for(const e of r??[])if((e?.code??e?.status_code)===200&&e.body)items.push(e.body);}catch(e){console.log(JSON.stringify({detalle:'error',error:e.code??String(e)}));}}
 }
 const moderated=items.filter(isModerated);
 const receipts=new Map();
 const ids2=moderated.map(i=>i.id);
 for(let i=0;i<ids2.length;i+=80){
  const group=ids2.slice(i,i+80);
  for(const r of await query(`SELECT item_id,isbn,created_at,run_id FROM ml_vintage_pub_receipts WHERE seller_id=? AND item_id IN (${group.map(()=>'?').join(',')})`,[SELLER,...group]))receipts.set(r.item_id,r);
 }
 const rows=moderated.map(i=>classify(i,receipts.get(i.id)));
 let infracciones=null;
 try{infracciones=await ml.get(`/moderations/infractions/${SELLER}?limit=50`);}catch(e){infracciones={error:e.code??String(e),status:e.status??null};}
 const count=key=>rows.reduce((m,r)=>{const k=String(r[key]);m[k]=(m[k]??0)+1;return m;},{});
 const subs={};for(const r of rows)for(const s of r.sub_status)subs[s]=(subs[s]??0)+1;
 const resumen={revisadas:items.length,moderadas:rows.length,por_estado:count('status'),por_sub_status:subs,por_catalogo:count('catalogo'),por_origen:count('origen'),por_dia:count('dia'),editoriales:Object.entries(count('editorial')).sort((a,b)=>b[1]-a[1]).slice(0,25)};
 await fs.mkdir(out,{recursive:true});
 await fs.writeFile(path.join(out,'moderadas.json'),JSON.stringify({resumen,infracciones,publicaciones:rows},null,2));
 console.log('=== MODERADAS ===');
 console.log(JSON.stringify({resumen,infracciones:JSON.stringify(infracciones).slice(0,6000),muestra:rows.slice(0,40)}));
}
if(process.argv[1]?.endsWith('moderadas.mjs'))await main();
