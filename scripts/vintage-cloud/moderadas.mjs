// Diagnóstico de SÓLO LECTURA de las infracciones de Amado Vintage en Mercado Libre (suspensión por
// propiedad intelectual del 08/11/2026). Sólo GET a Mercado Libre y SELECT a D1: no cambia nada.
//
// 1. Estado de venta de las cuentas (sell/list allow y si el mail de la cuenta coincide con el de la
//    suspensión, sin mostrar el mail).
// 2. Todas las infracciones de Vintage (/moderations/infractions/{seller}), agrupadas por motivo y día.
// 3. Las publicaciones infractoras: catálogo o no, día de creación y si las creó la campaña (D1).
//
//   node scripts/vintage-cloud/moderadas.mjs --salida <carpeta> [--mail-local <usuario del mail>]
import fs from 'node:fs/promises';
import path from 'node:path';
import {CUENTAS} from '../../precio-ganador/src/config.mjs';
import {fuenteTokenD1} from '../../precio-ganador/src/token.mjs';
import {crearCliente} from '../../precio-ganador/src/ml.mjs';
import {d1Client} from './d1.mjs';

const VINTAGE='2341378249';
const FIELDS='id,title,status,sub_status,catalog_listing,catalog_product_id,date_created,seller_custom_field,tags';

// Campos escalares de una infracción, aplanados (para agrupar sin saber de antemano la forma exacta).
export function flatten(obj,prefix='',out={}){
 for(const [k,v] of Object.entries(obj??{})){
  const key=prefix?`${prefix}.${k}`:k;
  if(v&&typeof v==='object'&&!Array.isArray(v))flatten(v,key,out);
  else if(!Array.isArray(v))out[key]=v;
 }
 return out;
}
export function elementIds(infraction){
 const text=JSON.stringify(infraction);
 return [...new Set(text.match(/MLU\d{6,}/g)??[])];
}
export function origin(receipt){
 if(!receipt)return 'fuera_de_la_campaña';
 return receipt.created_at>=Date.parse('2026-11-05T17:00:00Z')?'nube':'pc_o_web';
}

async function accountStatus(cuenta,mailLocal){
 const ml=crearCliente(fuenteTokenD1(cuenta),{concurrencia:1});
 try{
  const me=await ml.get('/users/me');
  const local=String(me.email??'').split('@')[0].toLowerCase();
  return {cuenta:cuenta.nombre,vender:me.status?.sell?.allow??null,vender_codigos:me.status?.sell?.codes??[],publicar:me.status?.list?.allow??null,publicar_codigos:me.status?.list?.codes??[],mail_coincide:mailLocal?local===mailLocal.toLowerCase():null};
 }catch(e){return {cuenta:cuenta.nombre,error:e.code??String(e)};}
}

async function main(){
 const args=process.argv.slice(2),get=n=>args.includes(n)?args[args.indexOf(n)+1]:undefined;
 const out=get('--salida')??'.',mailLocal=get('--mail-local')??'newisalo25';
 const cuentas=[await accountStatus(CUENTAS.vintage,mailLocal),await accountStatus(CUENTAS.libros,mailLocal)];
 console.log(JSON.stringify({cuentas}));
 const ml=crearCliente(fuenteTokenD1(CUENTAS.vintage),{concurrencia:2});
 const infractions=[];
 for(let offset=0;offset<2000;offset+=10){
  let r;try{r=await ml.get(`/moderations/infractions/${VINTAGE}?offset=${offset}&limit=10`);}catch(e){console.log(JSON.stringify({infracciones:'error',offset,error:e.code??String(e)}));break;}
  const list=Array.isArray(r?.infractions)?r.infractions:[];
  if(offset===0)console.log(JSON.stringify({infracciones_total:r?.paging?.total??null,ejemplo:list[0]??null}));
  infractions.push(...list);
  if(list.length<10)break;
 }
 const count=(rows,fn)=>rows.reduce((m,x)=>{const k=String(fn(x));m[k]=(m[k]??0)+1;return m;},{});
 const flat=infractions.map(i=>flatten(i));
 const porCampo={};
 for(const f of flat)for(const [k,v] of Object.entries(f)){if(/date|_id$|^id$|url|text|description/i.test(k)&&!/reason|type|status/i.test(k))continue;(porCampo[k]??={})[String(v)]=((porCampo[k]??{})[String(v)]??0)+1;}
 const fechas=flat.map(f=>Object.entries(f).find(([k,v])=>/date/i.test(k)&&typeof v==='string')?.[1]??'').map(d=>d.slice(0,10));
 const ids=[...new Set(infractions.flatMap(elementIds))];
 const items=[];
 for(let i=0;i<ids.length;i+=20){
  const group=ids.slice(i,i+20);
  try{const r=await ml.get(`/items?ids=${group.join(',')}&attributes=${FIELDS}`);for(const e of r??[])if(e?.code===200&&e.body)items.push(e.body);}catch(e){console.log(JSON.stringify({items:'error',error:e.code??String(e)}));}
 }
 const query=d1Client(),receipts=new Map();
 for(let i=0;i<ids.length;i+=80){
  const group=ids.slice(i,i+80);
  for(const r of await query(`SELECT item_id,isbn,created_at FROM ml_vintage_pub_receipts WHERE seller_id=? AND item_id IN (${group.map(()=>'?').join(',')})`,[VINTAGE,...group]))receipts.set(r.item_id,r);
 }
 const rows=items.map(it=>({id:it.id,title:it.title,status:it.status,sub_status:it.sub_status??[],catalogo:it.catalog_listing===true,dia_creada:String(it.date_created??'').slice(0,10),origen:origin(receipts.get(it.id)),sku:it.seller_custom_field??null}));
 const resumen={infracciones:infractions.length,publicaciones_citadas:ids.length,leidas:rows.length,por_campo:porCampo,por_dia_infraccion:count(fechas,x=>x),por_catalogo:count(rows,r=>r.catalogo),por_origen:count(rows,r=>r.origen),por_dia_creada:count(rows,r=>r.dia_creada),por_estado:count(rows,r=>r.status)};
 await fs.mkdir(out,{recursive:true});
 await fs.writeFile(path.join(out,'moderadas.json'),JSON.stringify({cuentas,resumen,infracciones:infractions,publicaciones:rows},null,2));
 console.log('=== MODERADAS ===');
 console.log(JSON.stringify({cuentas,resumen,muestra:rows.slice(0,60)}));
}
if(process.argv[1]?.endsWith('moderadas.mjs'))await main();
