// Foto semanal de un vendedor competidor de Mercado Libre y qué se movió desde la foto
// anterior. Pensado para HERMES_PROMOSML (seller 471589392): +50 mil publicaciones y pocas
// ventas, así que lo revelador no es su catálogo sino qué se mueve de una semana a la otra.
//
// Qué deja ver la API con nuestro token (sondeo del 16/11/2026, scripts/mercadolibre/
// sondeo-competidor.mjs): la búsqueda /sites/MLU/search y la lectura de publicaciones ajenas
// (/items, también en lote) responden 403. Sí abren: la ficha del vendedor (/users, con el
// contador de operaciones concretadas), las ofertas de cada producto de catálogo
// (/products/{id}/items, lo que ya usa la vigilancia de competencia del Worker) y las
// preguntas por publicación. Sobre eso se arma:
//  - Ventas del vendedor: el contador de operaciones concretadas, que el Worker guarda a
//    diario en comp_seller_days. La diferencia entre dos fechas son sus ventas.
//  - Sus publicaciones en los libros que vendemos nosotros: los productos de catálogo donde
//    la vigilancia lo vio alguna vez (comp_snapshots) se vuelven a leer y se guarda su
//    oferta: precio, posición, envío, cantidad si ML la informa, preguntas de la semana.
//  - Movimiento entre fotos: desapareció (sin stock o pausada), nueva, cambio de precio,
//    bajó la cantidad.
// Los datos del vendedor quedan en D1 y en el mail a Seba: en los logs sólo van conteos.
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {CUENTAS,fechaMontevideo} from '../../precio-ganador/src/config.mjs';
import {fuenteTokenD1} from '../../precio-ganador/src/token.mjs';
import {crearCliente} from '../../precio-ganador/src/ml.mjs';
import {d1Client} from '../vintage-cloud/d1.mjs';
import {sendMail} from '../vintage-cloud/aviso.mjs';

export const SELLER_HERMES='471589392';
const T='comp_vendedor_';
export const TABLES={fotos:T+'fotos',items:T+'items',movimientos:T+'movimientos'};
// Tablas del primer intento (búsqueda por vendedor, cerrada por ML): se descartan.
const VIEJAS=['comp_catalogo_fotos','comp_catalogo_tramos','comp_catalogo_items','comp_catalogo_movimientos'];
const COLS=['foto_id','item_id','producto','isbn','nombre','precio','moneda','cantidad','posicion','ofertas','precio_minimo','nuestro_precio','envio_gratis','logistica','preguntas_7d'];
const ROWS_PER_INSERT=6; // 6 filas x 15 columnas = 90 parámetros (D1 admite 100 por consulta)
const LISTADO=300;
export const FOTOS_A_CONSERVAR=12;
export const DIA_MS=86400000;

export async function schema(query){
 for(const t of VIEJAS)await query(`DROP TABLE IF EXISTS ${t}`);
 await query(`CREATE TABLE IF NOT EXISTS ${TABLES.fotos} (id INTEGER PRIMARY KEY AUTOINCREMENT,seller_id TEXT NOT NULL,nickname TEXT,started_at INTEGER NOT NULL,finished_at INTEGER,transacciones INTEGER,ventas_60d INTEGER,nivel TEXT,productos INTEGER,items INTEGER,errores INTEGER NOT NULL DEFAULT 0,completa INTEGER NOT NULL DEFAULT 0)`);
 await query(`CREATE TABLE IF NOT EXISTS ${TABLES.items} (foto_id INTEGER NOT NULL,item_id TEXT NOT NULL,producto TEXT,isbn TEXT,nombre TEXT,precio REAL,moneda TEXT,cantidad INTEGER,posicion INTEGER,ofertas INTEGER,precio_minimo REAL,nuestro_precio REAL,envio_gratis INTEGER,logistica TEXT,preguntas_7d INTEGER,PRIMARY KEY(foto_id,item_id))`);
 await query(`CREATE TABLE IF NOT EXISTS ${TABLES.movimientos} (foto_id INTEGER NOT NULL,item_id TEXT NOT NULL,tipo TEXT NOT NULL,nombre TEXT,antes TEXT,despues TEXT,PRIMARY KEY(foto_id,item_id,tipo))`);
}

const num=v=>{const n=Number(v);return v==null||v===''||!Number.isFinite(n)?null:n;};
const entero=v=>{const n=num(v);return n==null?null:Math.trunc(n);};
async function enTandas(items,n,fn){for(let i=0;i<items.length;i+=n)await Promise.all(items.slice(i,i+n).map(fn));}

// Ficha pública del vendedor: lo que importa para medir ventas y confianza.
export function leerVendedor(u){
 const r=u?.seller_reputation??{};
 return {nickname:typeof u?.nickname==='string'?u.nickname:null,transacciones:entero(r?.transactions?.completed),ventas_60d:entero(r?.metrics?.sales?.completed),nivel:r?.power_seller_status??r?.level_id??null};
}
// Oferta del vendedor dentro de las ofertas de un producto de catálogo, con su posición por precio.
export function ofertaDelVendedor(ofertas,seller){
 const lista=(Array.isArray(ofertas)?ofertas:[]).filter(o=>typeof o?.item_id==='string').sort((a,b)=>(num(a.price)??Infinity)-(num(b.price)??Infinity));
 const i=lista.findIndex(o=>String(o.seller_id??'')===String(seller));
 if(i<0)return null;
 const o=lista[i];
 return {item_id:o.item_id,precio:num(o.price),moneda:o.currency_id??null,cantidad:entero(o.available_quantity),posicion:i+1,ofertas:lista.length,precio_minimo:num(lista[0]?.price),envio_gratis:o.shipping?.free_shipping?1:0,logistica:o.shipping?.logistic_type??null};
}
export function preguntasRecientes(data,now=Date.now(),dias=7){
 const desde=now-dias*DIA_MS;
 return (Array.isArray(data?.questions)?data.questions:[]).filter(q=>{const t=Date.parse(q?.date_created??'');return Number.isFinite(t)&&t>=desde;}).length;
}

// Toma la foto: ficha del vendedor y sus ofertas en los productos de catálogo nuestros donde
// la vigilancia lo vio alguna vez. Devuelve conteos; nunca títulos.
export async function tomarFoto({ml,query,seller=SELLER_HERMES,now=Date.now,intervalMs=200,sleep=ms=>new Promise(r=>setTimeout(r,ms)),onStatus=()=>{}}){
 await schema(query);
 const t0=now();
 const vendedor=leerVendedor(await ml.get(`/users/${seller}`));
 const foto=(await query(`INSERT INTO ${TABLES.fotos}(seller_id,nickname,started_at,transacciones,ventas_60d,nivel) VALUES(?,?,?,?,?,?) RETURNING *`,[String(seller),vendedor.nickname,t0,vendedor.transacciones,vendedor.ventas_60d,vendedor.nivel]))[0];
 const vistos=await query(`SELECT s.catalog_product_id producto,MAX(t.isbn) isbn,MAX(t.own_price) nuestro_precio FROM comp_snapshots s LEFT JOIN comp_targets t ON t.catalog_product_id=s.catalog_product_id WHERE s.seller_id=? GROUP BY s.catalog_product_id`,[String(seller)]);
 const previos=await query(`SELECT i.producto,MAX(i.isbn) isbn,MAX(i.nombre) nombre,MAX(i.nuestro_precio) nuestro_precio FROM ${TABLES.items} i JOIN ${TABLES.fotos} f ON f.id=i.foto_id WHERE f.seller_id=? AND i.producto IS NOT NULL GROUP BY i.producto`,[String(seller)]);
 const productos=new Map();
 for(const p of previos)productos.set(p.producto,{producto:p.producto,isbn:p.isbn,nombre:p.nombre,nuestro_precio:p.nuestro_precio});
 for(const v of vistos){const prev=productos.get(v.producto)??{};productos.set(v.producto,{producto:v.producto,isbn:v.isbn??prev.isbn??null,nombre:prev.nombre??null,nuestro_precio:v.nuestro_precio??prev.nuestro_precio??null});}
 const stats={productos:productos.size,items:0,errores:0,llamadas:0,con_cantidad:0};
 const filas=[];
 for(const p of productos.values()){
  let ofertas=null;
  try{stats.llamadas++;ofertas=(await ml.get(`/products/${encodeURIComponent(p.producto)}/items?limit=50`))?.results??[];}
  catch(e){if(e?.status===404)ofertas=[];else{stats.errores++;onStatus({evento:'producto_error',code:e?.code??String(e)});continue;}}
  const o=ofertaDelVendedor(ofertas,seller);
  if(!o)continue;
  if(!p.nombre){try{stats.llamadas++;p.nombre=String((await ml.get(`/products/${encodeURIComponent(p.producto)}`))?.name??'').slice(0,200)||null;}catch{}}
  let preguntas=null;
  try{stats.llamadas++;preguntas=preguntasRecientes(await ml.get(`/questions/search?item=${encodeURIComponent(o.item_id)}&limit=50&sort_fields=date_created&sort_types=DESC`),now());}catch{}
  if(o.cantidad!=null)stats.con_cantidad++;
  filas.push([foto.id,o.item_id,p.producto,p.isbn,p.nombre,o.precio,o.moneda,o.cantidad,o.posicion,o.ofertas,o.precio_minimo,p.nuestro_precio,o.envio_gratis,o.logistica,preguntas]);
  stats.items++;
  if(intervalMs)await sleep(intervalMs);
 }
 const grupos=[];for(let i=0;i<filas.length;i+=ROWS_PER_INSERT)grupos.push(filas.slice(i,i+ROWS_PER_INSERT));
 await enTandas(grupos,4,g=>query(`INSERT OR IGNORE INTO ${TABLES.items}(${COLS.join(',')}) VALUES ${g.map(()=>`(${COLS.map(()=>'?').join(',')})`).join(',')}`,g.flat()));
 await query(`UPDATE ${TABLES.fotos} SET finished_at=?,productos=?,items=?,errores=?,completa=1 WHERE id=?`,[now(),stats.productos,stats.items,stats.errores,foto.id]);
 await podar(query,seller);
 const out={foto_id:foto.id,completa:true,...stats,transacciones:vendedor.transacciones,ventas_60d:vendedor.ventas_60d};
 onStatus({evento:'foto_completa',...out});
 return out;
}

export async function podar(query,seller,conservar=FOTOS_A_CONSERVAR){
 const viejas=await query(`SELECT id FROM ${TABLES.fotos} WHERE seller_id=? AND completa=1 ORDER BY id DESC LIMIT -1 OFFSET ?`,[String(seller),conservar]);
 for(const {id} of viejas)for(const t of [TABLES.items,TABLES.movimientos,TABLES.fotos])await query(`DELETE FROM ${t} WHERE ${t===TABLES.fotos?'id':'foto_id'}=?`,[id]);
 return viejas.length;
}

// Serie diaria del contador de operaciones concretadas (comp_seller_days, lo carga el Worker).
export async function serieVentas(query,seller,dias=28){
 let rows=[];
 try{rows=await query(`SELECT snap_date,transactions_completed FROM comp_seller_days WHERE seller_id=? AND transactions_completed IS NOT NULL ORDER BY snap_date DESC LIMIT ?`,[String(seller),dias+1]);}catch{return {dias:[],semana:null,primera:null,ultima:null};}
 rows=rows.slice().reverse();
 const out=[];
 for(let i=1;i<rows.length;i++)out.push({fecha:rows[i].snap_date,acumulado:rows[i].transactions_completed,ventas:Math.max(0,rows[i].transactions_completed-rows[i-1].transactions_completed)});
 const ultima=rows.at(-1)??null;
 const hace7=rows.filter(r=>r.snap_date<=sumarDias(ultima?.snap_date,-7)).at(-1)??null;
 return {dias:out.slice(-dias),semana:ultima&&hace7?{desde:hace7.snap_date,hasta:ultima.snap_date,ventas:ultima.transactions_completed-hace7.transactions_completed}:null,primera:rows[0]??null,ultima};
}
const sumarDias=(fecha,n)=>fecha?new Date(Date.parse(fecha+'T12:00:00Z')+n*DIA_MS).toISOString().slice(0,10):'';

// Qué se movió entre las dos últimas fotos. Guarda el detalle en D1 y lo devuelve.
export async function movimiento({query,seller=SELLER_HERMES}){
 await schema(query);
 const fotos=await query(`SELECT * FROM ${TABLES.fotos} WHERE seller_id=? AND completa=1 ORDER BY id DESC LIMIT 2`,[String(seller)]);
 const actual=fotos[0]??null,anterior=fotos[1]??null;
 const out={seller:String(seller),actual,anterior,listado:[],vendidos:[],desaparecidos:[],nuevos:[],precios:[],totales:{vendidos:0,desaparecidos:0,nuevos:0,precios:0}};
 if(!actual)return out;
 const I=TABLES.items;
 out.listado=await query(`SELECT * FROM ${I} WHERE foto_id=? ORDER BY COALESCE(preguntas_7d,0) DESC,posicion ASC,item_id LIMIT ?`,[actual.id,LISTADO]);
 if(!anterior)return out;
 const [b,a]=[actual.id,anterior.id];
 out.vendidos=await query(`SELECT a.item_id,a.nombre,a.precio precio_antes,b.precio precio_despues,a.cantidad cantidad_antes,b.cantidad cantidad_despues FROM ${I} a JOIN ${I} b ON b.foto_id=? AND b.item_id=a.item_id WHERE a.foto_id=? AND a.cantidad IS NOT NULL AND b.cantidad IS NOT NULL AND b.cantidad<a.cantidad ORDER BY (a.cantidad-b.cantidad) DESC,a.item_id LIMIT ?`,[b,a,LISTADO]);
 out.precios=await query(`SELECT a.item_id,a.nombre,a.precio precio_antes,b.precio precio_despues,b.nuestro_precio FROM ${I} a JOIN ${I} b ON b.foto_id=? AND b.item_id=a.item_id WHERE a.foto_id=? AND a.precio IS NOT NULL AND b.precio IS NOT NULL AND b.precio<>a.precio ORDER BY ABS(b.precio-a.precio) DESC,a.item_id LIMIT ?`,[b,a,LISTADO]);
 out.desaparecidos=await query(`SELECT a.item_id,a.nombre,a.precio,a.cantidad,a.posicion,a.preguntas_7d FROM ${I} a WHERE a.foto_id=? AND NOT EXISTS(SELECT 1 FROM ${I} b WHERE b.foto_id=? AND b.item_id=a.item_id) ORDER BY a.posicion ASC,a.item_id LIMIT ?`,[a,b,LISTADO]);
 out.nuevos=await query(`SELECT b.item_id,b.nombre,b.precio,b.cantidad,b.posicion,b.nuestro_precio FROM ${I} b WHERE b.foto_id=? AND NOT EXISTS(SELECT 1 FROM ${I} a WHERE a.foto_id=? AND a.item_id=b.item_id) ORDER BY b.item_id LIMIT ?`,[b,a,LISTADO]);
 out.totales={vendidos:out.vendidos.length,desaparecidos:out.desaparecidos.length,nuevos:out.nuevos.length,precios:out.precios.length};
 await query(`DELETE FROM ${TABLES.movimientos} WHERE foto_id=?`,[b]);
 const filas=[
  ...out.vendidos.map(r=>[b,r.item_id,'vendido',r.nombre,String(r.cantidad_antes),String(r.cantidad_despues)]),
  ...out.desaparecidos.map(r=>[b,r.item_id,'desaparecido',r.nombre,String(r.precio??''),'']),
  ...out.nuevos.map(r=>[b,r.item_id,'nuevo',r.nombre,'',String(r.precio??'')]),
  ...out.precios.map(r=>[b,r.item_id,'precio',r.nombre,String(r.precio_antes),String(r.precio_despues)]),
 ];
 const grupos=[];for(let i=0;i<filas.length;i+=15)grupos.push(filas.slice(i,i+15));
 await enTandas(grupos,4,g=>query(`INSERT OR IGNORE INTO ${TABLES.movimientos}(foto_id,item_id,tipo,nombre,antes,despues) VALUES ${g.map(()=>'(?,?,?,?,?,?)').join(',')}`,g.flat()));
 return out;
}

const pesos=v=>v==null?'-':`$${Math.round(Number(v)).toLocaleString('es-UY')}`;
const link=id=>`https://articulo.mercadolibre.com.uy/${String(id).replace(/^MLU/,'MLU-')}`;
const fecha=ms=>ms?fechaMontevideo(new Date(ms)):'?';
const nombre=r=>r.nombre??(r.isbn?`ISBN ${r.isbn}`:r.item_id);

// Texto del mail: primero cuánto vende el vendedor, después qué se movió en nuestros libros.
export function informe(mov,{serie=null,seller=mov.seller}={}){
 const L=[];
 const {actual,anterior,totales:t}=mov;
 const quien=`${actual?.nickname??'vendedor'} (${seller})`;
 if(!actual)return `Competencia ${seller}: todavía no hay una foto completa.`;
 L.push(`${quien}. Foto del ${fecha(actual.finished_at)}.`,'');
 L.push('CUÁNTO VENDE (contador de operaciones concretadas de su ficha pública)');
 if(actual.transacciones!=null)L.push(`- Hoy: ${actual.transacciones.toLocaleString('es-UY')} operaciones concretadas en total${actual.ventas_60d!=null?`; ${actual.ventas_60d} ventas en los últimos 60 días según Mercado Libre`:''}.`);
 if(serie?.semana)L.push(`- Última semana (${serie.semana.desde} a ${serie.semana.hasta}): ${serie.semana.ventas} ventas.`);
 if(serie?.primera&&serie?.ultima&&serie.primera.snap_date!==serie.ultima.snap_date)L.push(`- Desde el ${serie.primera.snap_date}: ${serie.ultima.transactions_completed-serie.primera.transactions_completed} ventas en ${Math.round((Date.parse(serie.ultima.snap_date)-Date.parse(serie.primera.snap_date))/DIA_MS)} días.`);
 if(serie?.dias?.length)L.push(`- Por día: ${serie.dias.map(d=>`${d.fecha.slice(5)}: ${d.ventas}`).join(' | ')}`);
 if(anterior?.transacciones!=null&&actual.transacciones!=null)L.push(`- Entre las dos fotos (${fecha(anterior.finished_at)} a ${fecha(actual.finished_at)}): ${actual.transacciones-anterior.transacciones} ventas.`);
 L.push('',`EN NUESTROS LIBROS: compite en ${actual.items} publicaciones de ${actual.productos} productos de catálogo que vendemos nosotros.`);
 if(!anterior){
  L.push('Es la primera foto: el movimiento publicación por publicación sale en la próxima, comparando contra esta.');
 }else{
  L.push(`Movimiento desde la foto del ${fecha(anterior.finished_at)}:`,'');
  L.push(`DESAPARECIDAS (se quedó sin stock o la pausó): ${t.desaparecidos}.`);
  for(const r of mov.desaparecidos.slice(0,60))L.push(`- ${nombre(r)} | estaba ${pesos(r.precio)} en el puesto ${r.posicion??'?'} | ${link(r.item_id)}`);
  L.push('',`BAJÓ LA CANTIDAD (venta probable): ${t.vendidos}.`);
  for(const r of mov.vendidos.slice(0,60))L.push(`- ${nombre(r)} | ${r.cantidad_antes} -> ${r.cantidad_despues} u. | ${pesos(r.precio_despues)} | ${link(r.item_id)}`);
  L.push('',`NUEVAS: ${t.nuevos}.`);
  for(const r of mov.nuevos.slice(0,40))L.push(`- ${nombre(r)} | ${pesos(r.precio)} (nosotros ${pesos(r.nuestro_precio)}) | ${link(r.item_id)}`);
  L.push('',`CAMBIOS DE PRECIO: ${t.precios}.`);
  for(const r of mov.precios.slice(0,40))L.push(`- ${nombre(r)} | ${pesos(r.precio_antes)} -> ${pesos(r.precio_despues)} (nosotros ${pesos(r.nuestro_precio)}) | ${link(r.item_id)}`);
 }
 const conPreguntas=mov.listado.filter(r=>(r.preguntas_7d??0)>0);
 L.push('',`PREGUNTAS RECIBIDAS EN LA SEMANA: ${conPreguntas.length} publicaciones con preguntas.`);
 for(const r of conPreguntas.slice(0,40))L.push(`- ${nombre(r)} | ${r.preguntas_7d} pregunta(s) | ${pesos(r.precio)} | ${link(r.item_id)}`);
 L.push('',`SUS PUBLICACIONES EN NUESTROS LIBROS (hasta 100): precio de ${actual.nickname??'él'} | nuestro precio | el más barato del producto | puesto entre las ofertas`);
 for(const r of mov.listado.slice(0,100))L.push(`- ${nombre(r)} | ${pesos(r.precio)} | ${pesos(r.nuestro_precio)} | ${pesos(r.precio_minimo)} | ${r.posicion??'?'} de ${r.ofertas??'?'}${r.cantidad!=null?` | ${r.cantidad} u.`:''}${r.envio_gratis?' | envío gratis':''} | ${link(r.item_id)}`);
 L.push('','NOTA: Mercado Libre cerró a las aplicaciones la búsqueda por vendedor y la lectura de publicaciones ajenas, así que su catálogo completo (más de 50 mil publicaciones) sólo se ve desde el navegador:',`https://listado.mercadolibre.com.uy/_CustId_${seller}`);
 return L.join('\n');
}

export function asunto(mov,serie=null){
 if(!mov.actual)return 'competencia: sin foto completa';
 const quien=mov.actual.nickname??mov.seller;
 const semana=serie?.semana?`${serie.semana.ventas} ventas en la semana`:`${mov.actual.transacciones??'?'} ventas en total`;
 if(!mov.anterior)return `${quien}: ${semana}, ${mov.actual.items} publicaciones en nuestros libros`;
 return `${quien}: ${semana}, ${mov.totales.desaparecidos} bajas y ${mov.totales.nuevos} nuevas en nuestros libros`;
}

export async function correr({seller=SELLER_HERMES,accion='foto',intervalMs=200,query=null,ml=null,send=sendMail,runUrl=process.env.RUN_URL??null,log=x=>console.log(JSON.stringify(x))}={}){
 query??=d1Client();
 ml??=crearCliente(fuenteTokenD1(CUENTAS.vintage),{concurrencia:1});
 let foto=null;
 if(accion==='foto')foto=await tomarFoto({ml,query,seller,intervalMs,onStatus:log});
 const mov=await movimiento({query,seller});
 const serie=await serieVentas(query,seller);
 const texto=informe(mov,{serie,seller})+(runUrl?`\n\nCorrida: ${runUrl}`:'');
 const mail=await send({asunto:asunto(mov,serie),texto,prefijo:'Competencia ML'});
 log({evento:'informe',foto_id:mov.actual?.id??null,anterior_id:mov.anterior?.id??null,totales:mov.totales,semana:serie?.semana?.ventas??null,mail,ml:ml.stats});
 return {foto,mov,serie,mail};
}

async function main(){
 const arg=(k,d)=>{const i=process.argv.indexOf(k);return i>0?process.argv[i+1]:d;};
 const seller=String(arg('--seller',SELLER_HERMES));
 if(!/^\d{3,15}$/.test(seller))throw new Error('seller_invalido');
 const accion=arg('--accion','foto');
 if(!['foto','informe'].includes(accion))throw new Error('accion_invalida');
 try{
  await correr({seller,accion,intervalMs:Math.max(0,Number(arg('--interval-ms',200))||0)});
 }catch(e){
  const code=e?.code??e?.message??'error';
  console.log(JSON.stringify({evento:'error',code,status:e?.status??null,detalle:e?.detalle??null}));
  await sendMail({asunto:`competencia ${seller}: la corrida falló`,texto:`Error: ${code}${e?.status?` (HTTP ${e.status})`:''}${e?.detalle?`\n${JSON.stringify(e.detalle)}`:''}${process.env.RUN_URL?`\n\nCorrida: ${process.env.RUN_URL}`:''}`,prefijo:'Competencia ML'}).catch(()=>{});
  process.exitCode=1;
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main();
