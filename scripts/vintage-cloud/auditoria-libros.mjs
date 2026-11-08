// Auditoría de SÓLO LECTURA de Amado Libros (440298103) con el mismo filtro de propiedad intelectual
// de Vintage. Decisión de Seba (08/11/2026): si Vintage cae, Libros cae con ella (cuentas asociadas).
// Recorre todas las publicaciones de la cuenta y lista las riesgosas. No cambia nada.
//
//   node scripts/vintage-cloud/auditoria-libros.mjs
import {CUENTAS} from '../../precio-ganador/src/config.mjs';
import {fuenteTokenD1} from '../../precio-ganador/src/token.mjs';
import {crearCliente} from '../../precio-ganador/src/ml.mjs';
import {ipRisk} from '../../worker-sync/ip-risk.js';

const LIBROS='440298103';
const publisherOf=it=>(it?.attributes??[]).find(a=>['BOOK_PUBLISHER','PUBLISHER'].includes(a?.id))?.value_name??null;

async function main(){
 const ml=crearCliente(fuenteTokenD1(CUENTAS.libros),{concurrencia:3});
 const me=await ml.get('/users/me');
 if(String(me?.id)!==LIBROS)throw new Error('cuenta_inesperada');
 const all=[];let scroll=null;
 for(let page=0;page<1500;page++){
  const q=new URLSearchParams({search_type:'scan',limit:'100'});if(scroll)q.set('scroll_id',scroll);
  let r;try{r=await ml.get(`/users/${LIBROS}/items/search?${q}`);}catch(e){console.log(JSON.stringify({busqueda:'error',error:e.code??String(e)}));break;}
  if(!Array.isArray(r?.results)||!r.results.length)break;all.push(...r.results);scroll=r.scroll_id??null;if(!scroll)break;
 }
 const risky=[];const porEstado={};
 for(let i=0;i<all.length;i+=20){
  const group=all.slice(i,i+20);
  let r;try{r=await ml.get(`/items?ids=${group.join(',')}&attributes=id,title,status,catalog_listing,seller_custom_field,attributes,price,sold_quantity`);}catch(e){console.log(JSON.stringify({detalle:'error',error:e.code??String(e)}));continue;}
  for(const e of r??[]){
   const it=e?.body;if(e?.code!==200||!it)continue;
   porEstado[it.status]=(porEstado[it.status]??0)+1;
   const risk=ipRisk(it.title,publisherOf(it));
   if(risk){risky.push({id:it.id,title:it.title,status:it.status,grupo:risk,catalogo:it.catalog_listing===true,vendidos:it.sold_quantity??0,precio:it.price??null});console.log('LIB\t'+[it.id,risk,it.status,it.catalog_listing===true?'catalogo':'tradicional',it.sold_quantity??0,it.price??'',String(it.title??'').replace(/[\t\n]/g,' ')].join('\t'));}
  }
 }
 const count=fn=>risky.reduce((m,x)=>{const k=String(fn(x));m[k]=(m[k]??0)+1;return m;},{});
 console.log('=== LIBROS ===');
 console.log(JSON.stringify({revisadas:all.length,por_estado:porEstado,riesgosas:risky.length,activas_riesgosas:risky.filter(r=>r.status==='active').length,con_ventas:risky.filter(r=>r.vendidos>0).length,por_grupo:count(r=>r.grupo)}));
}
await main();
