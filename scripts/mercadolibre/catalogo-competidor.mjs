// Foto semanal del catálogo de un vendedor de Mercado Libre (competencia) y qué se movió
// desde la foto anterior. Pensado para HERMES_PROMOSML (seller 471589392): +50 mil
// publicaciones y pocas ventas, así que lo que importa no es qué publica sino qué baja de
// stock o desaparece entre una semana y la otra.
//
// Cómo lo hace:
//  - Lee /sites/MLU/search?seller_id=... con el token de Amado Vintage (sólo lectura).
//    La búsqueda no deja pasar el offset 1000, así que el catálogo se parte en tramos
//    (categoría, después rangos de precio) hasta que cada tramo entre en 1.050 resultados.
//  - Guarda cada foto en D1 (tablas comp_catalogo_*). Si la corrida se corta, la próxima
//    sigue la misma foto por los tramos pendientes.
//  - Con dos fotos completas calcula el movimiento: stock que bajó (venta probable),
//    publicaciones que desaparecieron, nuevas y cambios de precio. Lo deja en D1 y lo
//    manda por mail.
// Los datos del vendedor quedan en D1 y en el mail a Seba: en los logs sólo van conteos.
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {CUENTAS,fechaMontevideo} from '../../precio-ganador/src/config.mjs';
import {fuenteTokenD1} from '../../precio-ganador/src/token.mjs';
import {crearCliente} from '../../precio-ganador/src/ml.mjs';
import {d1Client} from '../vintage-cloud/d1.mjs';
import {sendMail} from '../vintage-cloud/aviso.mjs';

export const SELLER_HERMES='471589392';
export const SITE='MLU';
export const LIMIT=50;
// Último offset que acepta la búsqueda para publicaciones de terceros.
export const MAX_OFFSET=1000;
export const ALCANZABLE=MAX_OFFSET+LIMIT;
const T='comp_catalogo_';
export const TABLES={fotos:T+'fotos',tramos:T+'tramos',items:T+'items',movimientos:T+'movimientos'};
const COLS=['foto_id','item_id','titulo','precio','moneda','cantidad','categoria','dominio','tipo','producto'];
const ROWS_PER_INSERT=9; // 9 filas x 10 columnas = 90 parámetros (D1 admite 100 por consulta)
const LISTADO=300; // filas por tipo de movimiento que se guardan y se informan
export const FOTOS_A_CONSERVAR=6;

export async function schema(query){
 await query(`CREATE TABLE IF NOT EXISTS ${TABLES.fotos} (id INTEGER PRIMARY KEY AUTOINCREMENT,seller_id TEXT NOT NULL,started_at INTEGER NOT NULL,finished_at INTEGER,total_api INTEGER,items INTEGER,parciales INTEGER NOT NULL DEFAULT 0,completa INTEGER NOT NULL DEFAULT 0)`);
 await query(`CREATE TABLE IF NOT EXISTS ${TABLES.tramos} (foto_id INTEGER NOT NULL,clave TEXT NOT NULL,params TEXT NOT NULL,total INTEGER,offset INTEGER NOT NULL DEFAULT 0,estado TEXT NOT NULL,PRIMARY KEY(foto_id,clave))`);
 await query(`CREATE TABLE IF NOT EXISTS ${TABLES.items} (foto_id INTEGER NOT NULL,item_id TEXT NOT NULL,titulo TEXT,precio REAL,moneda TEXT,cantidad INTEGER,categoria TEXT,dominio TEXT,tipo TEXT,producto TEXT,PRIMARY KEY(foto_id,item_id))`);
 await query(`CREATE TABLE IF NOT EXISTS ${TABLES.movimientos} (foto_id INTEGER NOT NULL,item_id TEXT NOT NULL,tipo TEXT NOT NULL,titulo TEXT,antes TEXT,despues TEXT,PRIMARY KEY(foto_id,item_id,tipo))`);
}

const num=v=>{const n=Number(v);return v==null||v===''||!Number.isFinite(n)?null:n;};
const entero=v=>{const n=num(v);return n==null?null:Math.trunc(n);};
export function fila(fotoId,r){
 return [fotoId,String(r.id),String(r.title??'').slice(0,200),num(r.price),r.currency_id??null,entero(r.available_quantity),r.category_id??null,r.domain_id??null,r.listing_type_id??null,r.catalog_product_id??null];
}
export function rutaBusqueda(seller,params={},offset=0){
 const q=new URLSearchParams({seller_id:String(seller),limit:String(LIMIT),offset:String(offset)});
 if(params.category)q.set('category',params.category);
 if(params.price)q.set('price',params.price);
 if(params.sort)q.set('sort',params.sort);
 return `/sites/${SITE}/search?${q}`;
}
// Límites numéricos de un rango de precio "a-b" ("*" = abierto).
export function limitesPrecio(price){
 const [a,b]=String(price??'*-*').split('-');
 return {lo:a==='*'||a===''?null:Number(a),hi:b==='*'||b===''?null:Number(b)};
}
const valoresFiltro=(page,id)=>{const f=(page?.available_filters??[]).find(x=>x?.id===id);return Array.isArray(f?.values)?f.values.filter(v=>v?.id!=null):[];};

// En qué tramos hijos se parte un tramo que no entra en 1.050 resultados. Primero por
// categoría (lo que ofrece la propia búsqueda), después por rangos de precio y, si hace
// falta, partiendo el rango al medio. null = no se puede partir más.
export async function dividir(params,page,{precioExtremo}){
 const cats=valoresFiltro(page,'category').filter(v=>v.id!==params.category);
 if(cats.length>1)return cats.map(c=>({params:{...params,category:c.id},nombre:`cat:${c.id}`}));
 if(!params.price){
  const rangos=valoresFiltro(page,'price');
  if(rangos.length>1)return rangos.map(r=>({params:{...params,price:r.id},nombre:`p:${r.id}`}));
 }
 let {lo,hi}=limitesPrecio(params.price);
 if(lo==null)lo=await precioExtremo(params,'price_asc');
 if(hi==null)hi=await precioExtremo(params,'price_desc');
 if(lo==null||hi==null||!(hi-lo>=1))return null;
 const mid=Math.floor((lo+hi)/2);
 return [{params:{...params,price:`${lo}-${mid}`},nombre:`p:${lo}-${mid}`},{params:{...params,price:`${mid}-${hi}`},nombre:`p:${mid}-${hi}`}];
}

async function enTandas(items,n,fn){for(let i=0;i<items.length;i+=n)await Promise.all(items.slice(i,i+n).map(fn));}

// Toma (o sigue tomando) la foto del catálogo del vendedor. Devuelve conteos; nunca títulos.
export async function tomarFoto({ml,query,seller=SELLER_HERMES,now=Date.now,maxMs=90*60000,intervalMs=250,sleep=ms=>new Promise(r=>setTimeout(r,ms)),reanudarHoras=96,onStatus=()=>{}}){
 await schema(query);
 const t0=now();
 const stats={llamadas:0,items:0,tramos:0,divididos:0,parciales:0,reanudada:false};
 let foto=(await query(`SELECT * FROM ${TABLES.fotos} WHERE seller_id=? AND completa=0 AND started_at>? ORDER BY id DESC LIMIT 1`,[String(seller),t0-reanudarHoras*3600000]))[0];
 if(foto)stats.reanudada=true;
 else{
  foto=(await query(`INSERT INTO ${TABLES.fotos}(seller_id,started_at) VALUES(?,?) RETURNING *`,[String(seller),t0]))[0];
  await query(`INSERT INTO ${TABLES.tramos}(foto_id,clave,params,estado) VALUES(?,?,?,?)`,[foto.id,'raiz','{}','pendiente']);
 }
 const buscar=async(params,offset)=>{stats.llamadas++;return await ml.get(rutaBusqueda(seller,params,offset));};
 const precioExtremo=async(params,sort)=>num((await buscar({...params,sort},0))?.results?.[0]?.price);
 const guardar=async results=>{
  const filas=(results??[]).filter(r=>r?.id!=null).map(r=>fila(foto.id,r));
  const grupos=[];for(let i=0;i<filas.length;i+=ROWS_PER_INSERT)grupos.push(filas.slice(i,i+ROWS_PER_INSERT));
  await enTandas(grupos,4,g=>query(`INSERT OR IGNORE INTO ${TABLES.items}(${COLS.join(',')}) VALUES ${g.map(()=>`(${COLS.map(()=>'?').join(',')})`).join(',')}`,g.flat()));
  stats.items+=filas.length;
 };
 const agotado=()=>now()-t0>maxMs;
 while(!agotado()){
  const tramo=(await query(`SELECT * FROM ${TABLES.tramos} WHERE foto_id=? AND estado='pendiente' ORDER BY clave LIMIT 1`,[foto.id]))[0];
  if(!tramo)break;
  const params=JSON.parse(tramo.params);let offset=tramo.offset??0,total=tramo.total;
  while(true){
   const page=await buscar(params,offset);
   const results=Array.isArray(page?.results)?page.results:[];
   if(total==null)total=entero(page?.paging?.total)??results.length;
   if(offset===0&&total>ALCANZABLE){
    const hijos=await dividir(params,page,{precioExtremo});
    if(hijos){
     for(const h of hijos)await query(`INSERT OR IGNORE INTO ${TABLES.tramos}(foto_id,clave,params,estado) VALUES(?,?,?,?)`,[foto.id,`${tramo.clave}/${h.nombre}`,JSON.stringify(h.params),'pendiente']);
     await query(`UPDATE ${TABLES.tramos} SET total=?,estado='dividido' WHERE foto_id=? AND clave=?`,[total,foto.id,tramo.clave]);
     stats.divididos++;break;
    }
   }
   await guardar(results);
   offset+=LIMIT;
   const fin=offset>=total||results.length<LIMIT||offset>MAX_OFFSET;
   const estado=!fin?'pendiente':offset<total&&offset>MAX_OFFSET?'parcial':'listo';
   await query(`UPDATE ${TABLES.tramos} SET total=?,offset=?,estado=? WHERE foto_id=? AND clave=?`,[total,offset,estado,foto.id,tramo.clave]);
   if(fin){stats.tramos++;if(estado==='parcial')stats.parciales++;break;}
   if(agotado())break;
   await sleep(intervalMs);
  }
  onStatus({evento:'tramo',foto_id:foto.id,...stats});
 }
 const pendientes=(await query(`SELECT COUNT(*) n FROM ${TABLES.tramos} WHERE foto_id=? AND estado='pendiente'`,[foto.id]))[0].n;
 const n=(await query(`SELECT COUNT(*) n FROM ${TABLES.items} WHERE foto_id=?`,[foto.id]))[0].n;
 if(pendientes>0){onStatus({evento:'tiempo_agotado',foto_id:foto.id,pendientes,guardados:n,...stats});return {foto_id:foto.id,completa:false,pendientes,guardados:n,...stats};}
 const parciales=(await query(`SELECT COUNT(*) n FROM ${TABLES.tramos} WHERE foto_id=? AND estado='parcial'`,[foto.id]))[0].n;
 const raiz=(await query(`SELECT total FROM ${TABLES.tramos} WHERE foto_id=? AND clave='raiz'`,[foto.id]))[0];
 await query(`UPDATE ${TABLES.fotos} SET finished_at=?,total_api=?,items=?,parciales=?,completa=1 WHERE id=?`,[now(),raiz?.total??null,n,parciales,foto.id]);
 await podar(query,seller);
 const out={foto_id:foto.id,completa:true,total_api:raiz?.total??null,guardados:n,...stats,parciales};
 onStatus({evento:'foto_completa',...out});
 return out;
}

// Borra fotos viejas (y sus filas) para que D1 no crezca sin fin.
export async function podar(query,seller,conservar=FOTOS_A_CONSERVAR){
 const viejas=await query(`SELECT id FROM ${TABLES.fotos} WHERE seller_id=? AND completa=1 ORDER BY id DESC LIMIT -1 OFFSET ?`,[String(seller),conservar]);
 for(const {id} of viejas)for(const t of [TABLES.items,TABLES.tramos,TABLES.movimientos,TABLES.fotos])await query(`DELETE FROM ${t} WHERE ${t===TABLES.fotos?'id':'foto_id'}=?`,[id]);
 return viejas.length;
}

// Qué se movió entre las dos últimas fotos completas. Guarda el detalle en D1 y lo devuelve.
export async function movimiento({query,seller=SELLER_HERMES}){
 await schema(query);
 const fotos=await query(`SELECT * FROM ${TABLES.fotos} WHERE seller_id=? AND completa=1 ORDER BY id DESC LIMIT 2`,[String(seller)]);
 const actual=fotos[0]??null,anterior=fotos[1]??null;
 const out={seller:String(seller),actual,anterior,vendidos:[],desaparecidos:[],nuevos:[],precios:[],totales:{vendidos:0,unidades:0,desaparecidos:0,nuevos:0,precios:0}};
 if(!actual||!anterior)return out;
 const I=TABLES.items,[b,a]=[actual.id,anterior.id];
 out.vendidos=await query(`SELECT a.item_id,a.titulo,a.precio precio_antes,b.precio precio_despues,a.cantidad cantidad_antes,b.cantidad cantidad_despues,a.categoria FROM ${I} a JOIN ${I} b ON b.foto_id=? AND b.item_id=a.item_id WHERE a.foto_id=? AND a.cantidad IS NOT NULL AND b.cantidad IS NOT NULL AND b.cantidad<a.cantidad ORDER BY (a.cantidad-b.cantidad) DESC,a.item_id LIMIT ?`,[b,a,LISTADO]);
 out.precios=await query(`SELECT a.item_id,a.titulo,a.precio precio_antes,b.precio precio_despues,a.categoria FROM ${I} a JOIN ${I} b ON b.foto_id=? AND b.item_id=a.item_id WHERE a.foto_id=? AND a.precio IS NOT NULL AND b.precio IS NOT NULL AND b.precio<>a.precio ORDER BY ABS(b.precio-a.precio) DESC,a.item_id LIMIT ?`,[b,a,LISTADO]);
 out.desaparecidos=await query(`SELECT a.item_id,a.titulo,a.precio,a.cantidad,a.categoria FROM ${I} a WHERE a.foto_id=? AND NOT EXISTS(SELECT 1 FROM ${I} b WHERE b.foto_id=? AND b.item_id=a.item_id) ORDER BY COALESCE(a.cantidad,999999) ASC,a.item_id LIMIT ?`,[a,b,LISTADO]);
 out.nuevos=await query(`SELECT b.item_id,b.titulo,b.precio,b.cantidad,b.categoria FROM ${I} b WHERE b.foto_id=? AND NOT EXISTS(SELECT 1 FROM ${I} a WHERE a.foto_id=? AND a.item_id=b.item_id) ORDER BY b.item_id LIMIT ?`,[b,a,LISTADO]);
 const cuenta=async(sql,args)=>(await query(sql,args))[0]?.n??0;
 out.totales={
  vendidos:await cuenta(`SELECT COUNT(*) n FROM ${I} a JOIN ${I} b ON b.foto_id=? AND b.item_id=a.item_id WHERE a.foto_id=? AND b.cantidad<a.cantidad`,[b,a]),
  unidades:await cuenta(`SELECT COALESCE(SUM(a.cantidad-b.cantidad),0) n FROM ${I} a JOIN ${I} b ON b.foto_id=? AND b.item_id=a.item_id WHERE a.foto_id=? AND b.cantidad<a.cantidad`,[b,a]),
  precios:await cuenta(`SELECT COUNT(*) n FROM ${I} a JOIN ${I} b ON b.foto_id=? AND b.item_id=a.item_id WHERE a.foto_id=? AND b.precio<>a.precio`,[b,a]),
  desaparecidos:await cuenta(`SELECT COUNT(*) n FROM ${I} a WHERE a.foto_id=? AND NOT EXISTS(SELECT 1 FROM ${I} b WHERE b.foto_id=? AND b.item_id=a.item_id)`,[a,b]),
  nuevos:await cuenta(`SELECT COUNT(*) n FROM ${I} b WHERE b.foto_id=? AND NOT EXISTS(SELECT 1 FROM ${I} a WHERE a.foto_id=? AND a.item_id=b.item_id)`,[b,a]),
 };
 await query(`DELETE FROM ${TABLES.movimientos} WHERE foto_id=?`,[b]);
 const filas=[
  ...out.vendidos.map(r=>[b,r.item_id,'vendido',r.titulo,String(r.cantidad_antes),String(r.cantidad_despues)]),
  ...out.desaparecidos.map(r=>[b,r.item_id,'desaparecido',r.titulo,String(r.cantidad??''),'']),
  ...out.nuevos.map(r=>[b,r.item_id,'nuevo',r.titulo,'',String(r.cantidad??'')]),
  ...out.precios.map(r=>[b,r.item_id,'precio',r.titulo,String(r.precio_antes),String(r.precio_despues)]),
 ];
 const grupos=[];for(let i=0;i<filas.length;i+=15)grupos.push(filas.slice(i,i+15));
 await enTandas(grupos,4,g=>query(`INSERT OR IGNORE INTO ${TABLES.movimientos}(foto_id,item_id,tipo,titulo,antes,despues) VALUES ${g.map(()=>'(?,?,?,?,?,?)').join(',')}`,g.flat()));
 return out;
}

export async function resumenCategorias(query,fotoId,limite=20){
 return query(`SELECT categoria,COUNT(*) n,ROUND(AVG(precio)) promedio,MIN(precio) minimo,MAX(precio) maximo,SUM(CASE WHEN cantidad IS NOT NULL THEN 1 ELSE 0 END) con_stock FROM ${TABLES.items} WHERE foto_id=? GROUP BY categoria ORDER BY n DESC LIMIT ?`,[fotoId,limite]);
}
export async function nombresCategorias(ml,ids){
 const out={};
 for(const id of [...new Set(ids.filter(Boolean))].slice(0,30)){try{out[id]=(await ml.get(`/categories/${id}`))?.name??id;}catch{out[id]=id;}}
 return out;
}

const pesos=v=>v==null?'-':`$${Math.round(Number(v)).toLocaleString('es-UY')}`;
const link=id=>`https://articulo.mercadolibre.com.uy/${String(id).replace(/^MLU/,'MLU-')}`;
const linea=(r,extra)=>`- ${r.titulo??r.item_id} | ${extra} | ${link(r.item_id)}`;
const fecha=ms=>ms?fechaMontevideo(new Date(ms)):'?';

// Texto del mail: primero lo que se vendió, después lo que desapareció, nuevos y precios.
export function informe(mov,{categorias=[],nombres={},seller=mov.seller}={}){
 const L=[];
 const {actual,anterior,totales:t}=mov;
 const cat=id=>nombres[id]??id??'sin categoría';
 if(!actual)return `Competencia ${seller}: todavía no hay una foto completa del catálogo.`;
 L.push(`Vendedor ${seller}. Foto del ${fecha(actual.finished_at)}: ${actual.items} publicaciones guardadas (la búsqueda informa ${actual.total_api??'?'}).`);
 if(actual.parciales)L.push(`Aviso: ${actual.parciales} tramo(s) quedaron parciales porque tienen más de ${ALCANZABLE} publicaciones al mismo precio; faltan algunas.`);
 if(!anterior){
  L.push('','Es la primera foto: el movimiento (qué vende) sale en la próxima, comparando contra esta.');
 }else{
  L.push(`Comparada con la foto del ${fecha(anterior.finished_at)} (${anterior.items} publicaciones).`,'');
  L.push(`VENTAS PROBABLES (bajó el stock): ${t.vendidos} publicaciones, ${t.unidades} unidades.`);
  for(const r of mov.vendidos.slice(0,100))L.push(linea(r,`${r.cantidad_antes} -> ${r.cantidad_despues} u. | ${pesos(r.precio_despues)} | ${cat(r.categoria)}`));
  L.push('',`DESAPARECIDAS (estaban y ya no se listan; agotadas o dadas de baja): ${t.desaparecidos}.`);
  for(const r of mov.desaparecidos.slice(0,60))L.push(linea(r,`${r.cantidad??'?'} u. | ${pesos(r.precio)} | ${cat(r.categoria)}`));
  L.push('',`NUEVAS: ${t.nuevos}.`);
  for(const r of mov.nuevos.slice(0,40))L.push(linea(r,`${r.cantidad??'?'} u. | ${pesos(r.precio)} | ${cat(r.categoria)}`));
  L.push('',`CAMBIOS DE PRECIO: ${t.precios}.`);
  for(const r of mov.precios.slice(0,40))L.push(linea(r,`${pesos(r.precio_antes)} -> ${pesos(r.precio_despues)} | ${cat(r.categoria)}`));
 }
 if(categorias.length){
  L.push('','QUÉ PUBLICA, POR CATEGORÍA (las más grandes):');
  for(const c of categorias)L.push(`- ${cat(c.categoria)}: ${c.n} publicaciones, precio promedio ${pesos(c.promedio)} (de ${pesos(c.minimo)} a ${pesos(c.maximo)})`);
 }
 return L.join('\n');
}

export function asunto(mov){
 if(!mov.actual)return 'competencia: sin foto completa';
 if(!mov.anterior)return `competencia ${mov.seller}: primera foto, ${mov.actual.items} publicaciones`;
 return `competencia ${mov.seller}: ${mov.totales.vendidos} ventas probables, ${mov.totales.desaparecidos} bajas, ${mov.totales.nuevos} nuevas`;
}

export async function correr({seller=SELLER_HERMES,accion='foto',maxMinutes=150,intervalMs=250,query=null,ml=null,send=sendMail,runUrl=process.env.RUN_URL??null,log=x=>console.log(JSON.stringify(x))}={}){
 query??=d1Client();
 ml??=crearCliente(fuenteTokenD1(CUENTAS.vintage),{concurrencia:1});
 let foto=null;
 if(accion==='foto'){
  foto=await tomarFoto({ml,query,seller,maxMs:maxMinutes*60000,intervalMs,onStatus:log});
  if(!foto.completa){
   log({evento:'foto_incompleta',...foto,ml:ml.stats});
   await send({asunto:`competencia ${seller}: la foto quedó a medias`,texto:`Se guardaron ${foto.guardados} publicaciones y quedan ${foto.pendientes} tramos pendientes. La próxima corrida la sigue desde ahí.${runUrl?`\n\nCorrida: ${runUrl}`:''}`,prefijo:'Competencia ML'});
   return {foto,mail:'foto_incompleta'};
  }
 }
 const mov=await movimiento({query,seller});
 const categorias=mov.actual?await resumenCategorias(query,mov.actual.id):[];
 const ids=[...categorias.map(c=>c.categoria),...[...mov.vendidos,...mov.desaparecidos,...mov.nuevos,...mov.precios].map(r=>r.categoria)];
 const nombres=await nombresCategorias(ml,ids);
 const texto=informe(mov,{categorias,nombres,seller})+(runUrl?`\n\nCorrida: ${runUrl}`:'');
 const mail=await send({asunto:asunto(mov),texto,prefijo:'Competencia ML'});
 log({evento:'informe',foto_id:mov.actual?.id??null,anterior_id:mov.anterior?.id??null,totales:mov.totales,mail,ml:ml.stats});
 return {foto,mov,mail};
}

async function main(){
 const arg=(k,d)=>{const i=process.argv.indexOf(k);return i>0?process.argv[i+1]:d;};
 const seller=String(arg('--seller',SELLER_HERMES));
 if(!/^\d{3,15}$/.test(seller))throw new Error('seller_invalido');
 const accion=arg('--accion','foto');
 if(!['foto','informe'].includes(accion))throw new Error('accion_invalida');
 try{
  await correr({seller,accion,maxMinutes:Math.max(1,Number(arg('--max-minutes',150))||150),intervalMs:Math.max(0,Number(arg('--interval-ms',250))||0)});
 }catch(e){
  const code=e?.code??e?.message??'error';
  console.log(JSON.stringify({evento:'error',code,status:e?.status??null,detalle:e?.detalle??null}));
  await sendMail({asunto:`competencia ${seller}: la corrida falló`,texto:`Error: ${code}${e?.status?` (HTTP ${e.status})`:''}${e?.detalle?`\n${JSON.stringify(e.detalle)}`:''}${process.env.RUN_URL?`\n\nCorrida: ${process.env.RUN_URL}`:''}`,prefijo:'Competencia ML'}).catch(()=>{});
  process.exitCode=1;
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main();
