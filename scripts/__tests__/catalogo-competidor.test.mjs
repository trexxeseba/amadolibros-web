import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {tomarFoto,movimiento,informe,asunto,correr,podar,rutaBusqueda,limitesPrecio,TABLES,LIMIT,MAX_OFFSET,ALCANZABLE} from '../mercadolibre/catalogo-competidor.mjs';

// D1 de mentira: SQLite en memoria con la misma firma query(sql,params) que d1Client.
function d1(){
 const db=new DatabaseSync(':memory:');
 return async(sql,params=[])=>{const st=db.prepare(sql);return /^\s*(SELECT|PRAGMA|WITH)\b|\bRETURNING\b/i.test(sql)?st.all(...params).map(r=>({...r})):(st.run(...params),[]);};
}
// Catálogo de mentira de un vendedor, con la búsqueda de ML por encima: filtros de categoría
// y precio, orden por precio, offset tope 1000 y available_filters como los devuelve ML.
function catalogo({cats={MLU1:1500,MLU2:300,MLU3:2200},precioFijo=null}={}){
 const items=[];let n=0;
 for(const [cat,count] of Object.entries(cats))for(let i=0;i<count;i++){n++;items.push({id:`MLU${100000+n}`,title:`Artículo ${n} de ${cat}`,price:precioFijo?.[cat]??(100+(n*37)%900),currency_id:'UYU',available_quantity:1+(n%5),category_id:cat,domain_id:'MLU-X',listing_type_id:'gold_special',catalog_product_id:null});}
 return items;
}
function mlFalso(items,{filtroPrecio=true}={}){
 const calls=[];
 const get=async path=>{
  calls.push(path);
  const u=new URL('https://api.mercadolibre.com'+path);
  if(u.pathname.startsWith('/categories/'))return {name:'Nombre '+u.pathname.split('/')[2]};
  assert.equal(u.pathname,'/sites/MLU/search');
  const seller=u.searchParams.get('seller_id'),cat=u.searchParams.get('category'),price=u.searchParams.get('price'),sort=u.searchParams.get('sort');
  const offset=Number(u.searchParams.get('offset')),limit=Number(u.searchParams.get('limit'));
  if(offset>MAX_OFFSET)throw Object.assign(new Error('http_400'),{status:400});
  assert.equal(limit,LIMIT);assert.equal(seller,'471589392');
  let list=items.filter(it=>!cat||it.category_id===cat);
  if(price){const {lo,hi}=limitesPrecio(price);list=list.filter(it=>(lo==null||it.price>=lo)&&(hi==null||it.price<=hi));}
  if(sort==='price_asc')list=[...list].sort((a,b)=>a.price-b.price);
  if(sort==='price_desc')list=[...list].sort((a,b)=>b.price-a.price);
  const available_filters=[];
  if(!cat){const m=new Map();for(const it of list)m.set(it.category_id,(m.get(it.category_id)??0)+1);available_filters.push({id:'category',values:[...m].map(([id,results])=>({id,results}))});}
  if(filtroPrecio&&!price)available_filters.push({id:'price',values:[{id:'*-400'},{id:'400-700'},{id:'700-*'}]});
  return {paging:{total:list.length,offset,limit},results:list.slice(offset,offset+limit),available_filters};
 };
 return {get,calls,stats:{llamadas:0}};
}

test('rutaBusqueda y limitesPrecio',()=>{
 assert.equal(rutaBusqueda('471589392',{category:'MLU1',price:'100-200',sort:'price_asc'},50),'/sites/MLU/search?seller_id=471589392&limit=50&offset=50&category=MLU1&price=100-200&sort=price_asc');
 assert.deepEqual(limitesPrecio('*-400'),{lo:null,hi:400});
 assert.deepEqual(limitesPrecio('400-700'),{lo:400,hi:700});
 assert.deepEqual(limitesPrecio(undefined),{lo:null,hi:null});
});

test('la foto trae todo el catálogo una sola vez, partiendo por categoría y precio',async()=>{
 const items=catalogo(),query=d1(),ml=mlFalso(items);
 const out=await tomarFoto({ml,query,seller:'471589392',sleep:async()=>{},now:()=>1000});
 assert.equal(out.completa,true);
 assert.equal(out.total_api,4000);
 assert.equal(out.guardados,items.length);
 assert.equal(out.parciales,0);
 const rows=await query(`SELECT item_id,titulo,precio,cantidad,categoria FROM ${TABLES.items} WHERE foto_id=? ORDER BY item_id`,[out.foto_id]);
 assert.equal(rows.length,items.length);
 assert.equal(new Set(rows.map(r=>r.item_id)).size,items.length);
 assert.deepEqual(rows[0],{item_id:'MLU100001',titulo:'Artículo 1 de MLU1',precio:137,cantidad:2,categoria:'MLU1'});
 const tramos=await query(`SELECT clave,estado,total FROM ${TABLES.tramos} WHERE foto_id=? ORDER BY clave`,[out.foto_id]);
 assert.equal(tramos.find(t=>t.clave==='raiz').estado,'dividido');
 assert.equal(tramos.find(t=>t.clave==='raiz/cat:MLU2').estado,'listo');
 assert.ok(tramos.some(t=>t.clave.startsWith('raiz/cat:MLU3/p:')&&t.estado==='listo'));
 assert.ok(!ml.calls.some(p=>Number(new URL('x://x'+p).searchParams.get('offset'))>MAX_OFFSET));
 // Sin ir página por página de los 4.000 en un solo tramo: el tope de offset obliga a partir.
 assert.ok(ml.calls.length<200,String(ml.calls.length));
});

test('si no hay filtro de precio, parte el rango al medio hasta que entre',async()=>{
 const items=catalogo({cats:{MLU9:1400}}),query=d1(),ml=mlFalso(items,{filtroPrecio:false});
 const out=await tomarFoto({ml,query,seller:'471589392',sleep:async()=>{},now:()=>1000});
 assert.equal(out.completa,true);assert.equal(out.guardados,1400);assert.equal(out.parciales,0);
 assert.ok(ml.calls.some(p=>p.includes('sort=price_asc'))&&ml.calls.some(p=>p.includes('sort=price_desc')));
});

test('un tramo con más de 1.050 publicaciones al mismo precio queda parcial, no cuelga',async()=>{
 const items=catalogo({cats:{MLU7:1200}},{precioFijo:{MLU7:500}}).map(i=>({...i,price:500}));
 const query=d1(),ml=mlFalso(items,{filtroPrecio:false});
 const out=await tomarFoto({ml,query,seller:'471589392',sleep:async()=>{},now:()=>1000});
 assert.equal(out.completa,true);
 assert.equal(out.parciales,1);
 assert.equal(out.guardados,ALCANZABLE);
});

test('si se acaba el tiempo, la próxima corrida sigue la misma foto',async()=>{
 const items=catalogo(),query=d1();
 let t=0;const now=()=>t;
 const ml=mlFalso(items);
 const paso=mlFalso(items);paso.get=async p=>{t+=1000;return ml.get(p);};
 const corte=await tomarFoto({ml:paso,query,seller:'471589392',sleep:async()=>{},now,maxMs:20000});
 assert.equal(corte.completa,false);
 assert.ok(corte.pendientes>0);
 assert.ok(corte.guardados<items.length);
 const sigue=await tomarFoto({ml,query,seller:'471589392',sleep:async()=>{},now:()=>t+1});
 assert.equal(sigue.reanudada,true);
 assert.equal(sigue.completa,true);
 assert.equal(sigue.foto_id,corte.foto_id);
 assert.equal(sigue.guardados,items.length);
 assert.equal((await query(`SELECT COUNT(*) n FROM ${TABLES.fotos}`))[0].n,1);
});

test('movimiento: ventas probables, desaparecidas, nuevas y precios entre dos fotos',async()=>{
 const base=catalogo({cats:{MLU1:120,MLU2:40}}),query=d1();
 const f1=await tomarFoto({ml:mlFalso(base),query,seller:'471589392',sleep:async()=>{},now:()=>1000});
 const despues=base.map(i=>({...i}));
 despues[0].available_quantity=despues[0].available_quantity-1; // una venta
 despues[1].available_quantity=1;despues[1].price=despues[1].price+50; // venta y suba de precio
 despues.splice(5,2); // dos desaparecen
 despues.push({id:'MLU999999',title:'Nuevo',price:999,currency_id:'UYU',available_quantity:3,category_id:'MLU2'});
 const f2=await tomarFoto({ml:mlFalso(despues),query,seller:'471589392',sleep:async()=>{},now:()=>2000});
 assert.notEqual(f1.foto_id,f2.foto_id);
 const mov=await movimiento({query,seller:'471589392'});
 assert.equal(mov.actual.id,f2.foto_id);assert.equal(mov.anterior.id,f1.foto_id);
 assert.deepEqual(mov.totales,{vendidos:2,unidades:1+(base[1].available_quantity-1),desaparecidos:2,nuevos:1,precios:1});
 assert.deepEqual(mov.vendidos.map(r=>r.item_id).sort(),[base[0].id,base[1].id].sort());
 assert.deepEqual(mov.desaparecidos.map(r=>r.item_id),[base[5].id,base[6].id]);
 assert.deepEqual(mov.nuevos.map(r=>r.item_id),['MLU999999']);
 assert.equal(mov.precios[0].precio_despues,base[1].price+50);
 const guardado=await query(`SELECT tipo,COUNT(*) n FROM ${TABLES.movimientos} WHERE foto_id=? GROUP BY tipo ORDER BY tipo`,[f2.foto_id]);
 assert.deepEqual(guardado,[{tipo:'desaparecido',n:2},{tipo:'nuevo',n:1},{tipo:'precio',n:1},{tipo:'vendido',n:2}]);
 const texto=informe(mov,{nombres:{MLU1:'Libros'},categorias:[{categoria:'MLU1',n:120,promedio:500,minimo:100,maximo:999}]});
 assert.match(texto,/VENTAS PROBABLES \(bajó el stock\): 2 publicaciones/);
 assert.match(texto,/Artículo 1 de MLU1 \| 2 -> 1 u\./);
 assert.match(texto,/https:\/\/articulo\.mercadolibre\.com\.uy\/MLU-100001/);
 assert.match(texto,/DESAPARECIDAS .*: 2\./);
 assert.match(texto,/- Libros: 120 publicaciones/);
 assert.equal(asunto(mov),'competencia 471589392: 2 ventas probables, 2 bajas, 1 nuevas');
});

test('la primera foto avisa que el movimiento sale en la próxima',async()=>{
 const query=d1();
 await tomarFoto({ml:mlFalso(catalogo({cats:{MLU1:10}})),query,seller:'471589392',sleep:async()=>{},now:()=>1000});
 const mov=await movimiento({query,seller:'471589392'});
 assert.equal(mov.anterior,null);
 assert.match(informe(mov),/Es la primera foto/);
 assert.equal(asunto(mov),'competencia 471589392: primera foto, 10 publicaciones');
});

test('correr toma la foto, manda el informe por mail y sólo loguea conteos',async()=>{
 const query=d1(),mails=[],logs=[];
 const ml=mlFalso(catalogo({cats:{MLU1:30}}));
 const out=await correr({query,ml,seller:'471589392',send:async m=>{mails.push(m);return 'enviado';},log:x=>logs.push(x),runUrl:'https://ejemplo/run/1'});
 assert.equal(out.mail,'enviado');
 assert.equal(mails.length,1);
 assert.equal(mails[0].prefijo,'Competencia ML');
 assert.match(mails[0].texto,/30 publicaciones guardadas/);
 assert.match(mails[0].texto,/Nombre MLU1: 30 publicaciones/);
 assert.match(mails[0].texto,/Corrida: https:\/\/ejemplo\/run\/1/);
 assert.ok(!JSON.stringify(logs).includes('Artículo'));
});

test('podar deja las últimas fotos completas',async()=>{
 const query=d1(),items=catalogo({cats:{MLU1:3}});
 for(let i=0;i<8;i++)await tomarFoto({ml:mlFalso(items),query,seller:'471589392',sleep:async()=>{},now:()=>1000+i});
 assert.equal((await query(`SELECT COUNT(*) n FROM ${TABLES.fotos}`))[0].n,6);
 assert.equal((await query(`SELECT COUNT(*) n FROM ${TABLES.items}`))[0].n,18);
 assert.equal(await podar(query,'471589392',2),4);
 assert.equal((await query(`SELECT COUNT(*) n FROM ${TABLES.items}`))[0].n,6);
});
