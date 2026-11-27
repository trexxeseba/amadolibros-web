// Sondeo: qué rutas de la API oficial de Mercado Libre permiten leer publicaciones de un
// vendedor ajeno con nuestro token (Amado Libros desde el desenganche del 27/11/2026, sólo
// lectura; un 403 queda registrado como "no disponible" y no se prueba con otra cuenta). Prueba cada ruta una vez
// y registra sólo código de respuesta, cantidad de resultados y nombres de campos. Nunca
// títulos, precios ni tokens. Corre a mano desde el workflow `Competencia catálogo` con la
// acción `sondeo`. No toca la web pública de Mercado Libre.
import {CUENTAS} from '../../precio-ganador/src/config.mjs';
import {fuenteTokenD1} from '../../precio-ganador/src/token.mjs';
import {crearCliente} from '../../precio-ganador/src/ml.mjs';
import {d1Client} from '../vintage-cloud/d1.mjs';

const arg=(k,d)=>{const i=process.argv.indexOf(k);return i>0?process.argv[i+1]:d;};
const seller=arg('--seller','471589392'),nick=arg('--nickname','HERMES_PROMOSML');
const query=d1Client();
const ml=crearCliente(fuenteTokenD1(CUENTAS.libros),{concurrencia:1,intentos:1}); // sólo GET
const resumen=r=>({tipo:Array.isArray(r)?'array':typeof r,total:r?.paging?.total??null,resultados:Array.isArray(r?.results)?r.results.length:Array.isArray(r)?r.length:null,campos:r&&typeof r==='object'&&!Array.isArray(r)?Object.keys(r).slice(0,25):null,campos_item:Array.isArray(r?.results)&&r.results[0]?Object.keys(r.results[0]).slice(0,40):null,filtros:Array.isArray(r?.available_filters)?r.available_filters.map(f=>f.id):null});
const log=x=>console.log(JSON.stringify(x));
async function api(clave,path){try{const r=await ml.get(path);log({clave,ok:true,...resumen(r)});return r;}catch(e){log({clave,ok:false,...(e?.status===403?{no_disponible:true}:{}),code:e?.code??String(e),status:e?.status??null,detalle:e?.detalle??null});return null;}}

let itemId=null;
try{itemId=(await query('SELECT item_id FROM comp_snapshots WHERE seller_id=? ORDER BY fetched_at DESC LIMIT 1',[seller]))[0]?.item_id??null;log({clave:'d1_item_del_vendedor',hay:!!itemId});}catch(e){log({clave:'d1_item_del_vendedor',ok:false,code:e?.code??String(e)});}
await api('search_seller_id',`/sites/MLU/search?seller_id=${seller}&limit=1`);
await api('search_nickname',`/sites/MLU/search?nickname=${encodeURIComponent(nick)}&limit=1`);
await api('search_q_generica',`/sites/MLU/search?q=libro&limit=1`);
await api('search_q_mas_seller',`/sites/MLU/search?q=libro&seller_id=${seller}&limit=1`);
await api('search_categoria_mas_seller',`/sites/MLU/search?category=MLU1196&seller_id=${seller}&limit=1`);
await api('search_categoria_sola',`/sites/MLU/search?category=MLU1196&limit=1`);
const u=await api('users',`/users/${seller}`);
// Estructura de la reputación: nombres de campos y tipo de cada valor, nunca los valores.
const forma=(o,prof=0)=>o&&typeof o==='object'&&prof<3?Object.fromEntries(Object.entries(o).map(([k,v])=>[k,v&&typeof v==='object'?forma(v,prof+1):v===null?'null':typeof v])):typeof o;
log({clave:'users_reputacion_forma',seller_reputation:forma(u?.seller_reputation),status:forma(u?.status),user_type:typeof u?.user_type});
try{const d=(await query('SELECT COUNT(*) n,SUM(transactions_completed IS NOT NULL) con_dato,MIN(snap_date) desde,MAX(snap_date) hasta FROM comp_seller_days WHERE seller_id=?',[seller]))[0];log({clave:'d1_seller_days',...d});}catch(e){log({clave:'d1_seller_days',ok:false,code:e?.code??String(e)});}
await api('users_items_search',`/users/${seller}/items/search?limit=1`);
try{
 const c=(await query('SELECT COUNT(DISTINCT item_id) n,COUNT(DISTINCT catalog_product_id) productos,MIN(snap_date) desde,MAX(snap_date) hasta FROM comp_snapshots WHERE seller_id=?',[seller]))[0];
 log({clave:'d1_items_del_vendedor',...c});
}catch(e){log({clave:'d1_items_del_vendedor',ok:false,code:e?.code??String(e)});}
if(itemId){
 const lote=await api('item_ajeno_multiget_todo',`/items?ids=${itemId}`);
 const body=Array.isArray(lote)?lote[0]?.body:null;
 log({clave:'item_ajeno_multiget_codigo',codigo:Array.isArray(lote)?lote[0]?.code??null:null,campos:body&&typeof body==='object'?Object.keys(body).slice(0,60):null,available_quantity:body?.available_quantity!==undefined,sold_quantity:body?.sold_quantity!==undefined,initial_quantity:body?.initial_quantity!==undefined});
 const it=await api('item_ajeno',`/items/${itemId}`);
 if(it)log({clave:'item_ajeno_campos_stock',available_quantity:it.available_quantity!==undefined,sold_quantity:it.sold_quantity!==undefined,initial_quantity:it.initial_quantity!==undefined,status:typeof it.status});
 await api('item_ajeno_multiget',`/items?ids=${itemId}&attributes=id,price,available_quantity,sold_quantity,status`);
 await api('item_ajeno_preguntas',`/questions/search?item=${itemId}&limit=1`);
}
log({clave:'fin',ml:ml.stats});
