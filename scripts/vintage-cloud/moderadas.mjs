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
import {ipRisk} from '../../worker-sync/ip-risk.js';

const VINTAGE='2341378249';
const FIELDS='id,title,status,sub_status,catalog_listing,catalog_product_id,date_created,seller_custom_field,tags,price,original_price';

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
 // Cupo de publicaciones de Vintage (sólo lectura).
 try{const cap=await crearCliente(fuenteTokenD1(CUENTAS.vintage),{concurrencia:1}).get('/marketplace/users/cap');console.log(JSON.stringify({cupo:cap}));}catch(e){console.log(JSON.stringify({cupo:'error',error:e.code??String(e),status:e.status??null}));}
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
 // Denuncias del Brand Protection Program (documentación oficial "Publicaciones denunciadas"): los
 // parámetros offset, date_created y status son obligatorios aunque vayan vacíos.
 let casos=null;const intento=async path=>{try{return await ml.get(path);}catch(e){return {error:e.code??String(e),status:e.status??null};}};
 casos=await intento('/moderations/pppi/cases?offset=0&date_created=&status=');
 console.log('=== PPPI ===');console.log(JSON.stringify(casos).slice(0,6000));
 const listaCasos=(Array.isArray(casos)?casos:[]).filter(c=>c?.case_id!==undefined);
 const detalleCasos=[];
 for(const c of listaCasos.slice(0,40)){const d=await intento(`/moderations/pppi/case/${c.case_id}`);detalleCasos.push({case_id:c.case_id,item_id:d?.item_info?.item_id??c.item_id,titulo:d?.item_info?.title??null,estado:d?.current_status??c.current_status,motivo_id:d?.reason_id??null,denunciante:d?.public_member_name??null,creada:d?.date_created??c.date_created,vence:d?.due_date??c.due_date,error:d?.error??null});}
 console.log('=== PPPI_DETALLE ===');console.log(JSON.stringify(detalleCasos));
 // Última moderación de cada publicación con infracción de propiedad intelectual: filtro que la generó y texto detectado.
 const ipIds=[...new Set(infractions.filter(i=>/COPIAS|PI_|FAKE|PPPI/i.test(i.filter_subgroup??'')).map(i=>i.element_id).filter(Boolean))];
 const ultimas=[];
 for(const id of ipIds){const m=await intento(`/moderations/last_moderation/${id}-ITM`);ultimas.push({id,moderacion:Array.isArray(m)?m.map(x=>({filtro:x.name,fecha:x.date_created,evidencias:x.evidences??[],textos:(x.wordings??[]).map(w=>`${w.type}: ${w.value}`)})):m});}
 console.log('=== ULTIMA_MODERACION ===');console.log(JSON.stringify(ultimas).slice(0,12000));
 // Publicaciones con moderación activa (status pending agrupa under_review y sus sub_status).
 const pendientes=await intento(`/users/${VINTAGE}/items/search?status=pending&limit=50`);
 console.log('=== PENDIENTES ===');console.log(JSON.stringify({total:pendientes?.paging?.total??null,ids:pendientes?.results??null,error:pendientes?.error??null}));
 // Avisos vigentes de Mercado Libre al vendedor y reputación (sólo lectura).
 const avisos=await intento('/communications/notices?limit=20&offset=0');
 console.log('=== AVISOS ===');console.log(JSON.stringify(avisos).slice(0,6000));
 const usuario=await intento(`/users/${VINTAGE}`);
 console.log('=== REPUTACION ===');console.log(JSON.stringify(usuario?.seller_reputation??usuario).slice(0,3000));
 // Altas de las últimas 24 horas (recibos publicados en D1) con los datos actuales de cada publicación:
 // sirve para comprobar que lo que publica la campaña es de catálogo y limpio para el filtro. Sólo lectura.
 const altas=[];
 try{
  const dq=d1Client(),desde=Date.now()-24*3600000;
  const recibos=await dq("SELECT item_id,isbn,state,created_at FROM ml_vintage_pub_receipts WHERE seller_id=? AND state='published' AND created_at>=? ORDER BY created_at",[VINTAGE,desde]);
  for(let i=0;i<recibos.length;i+=20){
   const grupo=recibos.slice(i,i+20).filter(r=>r.item_id);
   if(!grupo.length)continue;
   const r=await ml.get(`/items?ids=${grupo.map(x=>x.item_id).join(',')}&attributes=id,title,status,catalog_listing,price,available_quantity,seller_custom_field,sub_status,attributes`).catch(()=>[]);
   for(const e of r??[]){const it=e?.body;if(e?.code!==200||!it)continue;const pub=(it.attributes??[]).find(a=>['BOOK_PUBLISHER','PUBLISHER'].includes(a?.id))?.value_name??'';
    altas.push({id:it.id,titulo:it.title,estado:it.status,sub_estado:it.sub_status??[],catalogo:it.catalog_listing===true,editorial:pub,precio:it.price,stock:it.available_quantity,riesgo_filtro:ipRisk(it.title,pub),creada:recibos.find(x=>x.item_id===it.id)?.created_at??null});}
  }
 }catch(e){console.log(JSON.stringify({altas_hoy:'error',error:e.code??String(e)}));}
 console.log('=== ALTAS_24H ===');console.log(JSON.stringify({total:altas.length,catalogo:altas.filter(a=>a.catalogo).length,tradicionales:altas.filter(a=>!a.catalogo).length,con_riesgo_filtro:altas.filter(a=>a.riesgo_filtro).length,activas:altas.filter(a=>a.estado==='active').length,lista:altas.slice(0,150)}));
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
 const rows=items.map(it=>({id:it.id,title:it.title,status:it.status,sub_status:it.sub_status??[],catalogo:it.catalog_listing===true,dia_creada:String(it.date_created??'').slice(0,10),origen:origin(receipts.get(it.id)),sku:it.seller_custom_field??null,precio:it.price??null}));
 const byId=new Map(rows.map(r=>[r.id,r]));
 // Las de propiedad intelectual (copias/réplicas y falsificaciones), con su publicación.
 const pi=infractions.filter(i=>/COPIAS|PI_|FAKE/i.test(i.filter_subgroup??'')).map(i=>({subgrupo:i.filter_subgroup,fecha:String(i.date_created??'').slice(0,16),motivo:i.reason,publicacion:byId.get(i.element_id)??{id:i.element_id},filtro_actual:ipRisk(byId.get(i.element_id)?.title),evidencias:i.evidences??null,texto_detectado:JSON.stringify(i).match(/"text_matched":"([^"]{0,200})"/)?.[1]??null}));
 console.log('=== PROPIEDAD INTELECTUAL ===');console.log(JSON.stringify(pi));
 const resumen={infracciones:infractions.length,publicaciones_citadas:ids.length,leidas:rows.length,por_campo:porCampo,por_dia_infraccion:count(fechas,x=>x),por_catalogo:count(rows,r=>r.catalogo),por_origen:count(rows,r=>r.origen),por_dia_creada:count(rows,r=>r.dia_creada),por_estado:count(rows,r=>r.status)};
 // Auditoría: todas las publicaciones de la cuenta contra el filtro de propiedad intelectual.
 let auditoria=null;
 if(!args.includes('--sin-auditoria')&&process.env.VINTAGE_AUDITORIA!=='no'){
  const all=[];let scroll=null;
  for(let page=0;page<1000;page++){
   const q=new URLSearchParams({search_type:'scan',limit:'100'});if(scroll)q.set('scroll_id',scroll);
   let r;try{r=await ml.get(`/users/${VINTAGE}/items/search?${q}`);}catch(e){console.log(JSON.stringify({auditoria:'error_busqueda',error:e.code??String(e)}));break;}
   if(!Array.isArray(r?.results)||!r.results.length)break;all.push(...r.results);scroll=r.scroll_id??null;if(!scroll)break;
  }
  const risky=[];
  for(let i=0;i<all.length;i+=20){
   const group=all.slice(i,i+20);
   try{const r=await ml.get(`/items?ids=${group.join(',')}&attributes=id,title,status,catalog_listing,seller_custom_field,available_quantity,sale_terms,price,sold_quantity`);for(const e of r??[]){const it=e?.body;if(e?.code!==200||!it)continue;const risk=ipRisk(it.title);if(risk)risky.push({id:it.id,title:it.title,status:it.status,grupo:risk,catalogo:it.catalog_listing===true,campaña:/^AMADO-AR-/.test(it.seller_custom_field??''),stock:it.available_quantity??null,vendidos:it.sold_quantity??null,precio:it.price??null,demanda:(it.sale_terms??[]).some(t=>t?.id==='MANUFACTURING_TIME'),dias:(it.sale_terms??[]).find(t=>t?.id==='MANUFACTURING_TIME')?.value_name??null});}}
   catch(e){console.log(JSON.stringify({auditoria:'error_detalle',error:e.code??String(e)}));}
  }
  auditoria={revisadas:all.length,riesgosas:risky.length,activas:risky.filter(r=>r.status==='active').length,por_grupo:count(risky,r=>r.grupo),por_estado:count(risky,r=>r.status),de_la_campaña:risky.filter(r=>r.campaña).length,lista:risky};
  console.log('=== AUDITORIA ===');console.log(JSON.stringify({...auditoria,lista:risky.slice(0,150)}));
  // Lista completa, una por línea, para armar la planilla desde el registro (el artefacto no siempre se puede bajar).
  for(const r of risky)console.log('AUD\t'+[r.id,r.grupo,r.campaña?'campaña':'otra_linea',r.catalogo?'catalogo':'tradicional',r.status,String(r.title??'').replace(/[\t\n]/g,' '),r.demanda?'a_demanda':'stock',r.dias??'',r.stock??'',r.vendidos??'',r.precio??''].join('\t'));
 }
 await fs.mkdir(out,{recursive:true});
 await fs.writeFile(path.join(out,'moderadas.json'),JSON.stringify({cuentas,resumen,infracciones:infractions,publicaciones:rows,auditoria,casos_pppi:casos,altas_24h:altas,casos_detalle:detalleCasos,ultimas_moderaciones:ultimas,pendientes,avisos,reputacion:usuario?.seller_reputation??null},null,2));
 console.log('=== MODERADAS ===');
 console.log(JSON.stringify({cuentas,resumen,muestra:rows.slice(0,60)}));
}
if(process.argv[1]?.endsWith('moderadas.mjs'))await main();
