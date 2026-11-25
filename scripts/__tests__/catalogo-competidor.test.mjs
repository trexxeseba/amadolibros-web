import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {tomarFoto,movimiento,informe,asunto,correr,podar,serieVentas,leerVendedor,ofertaDelVendedor,preguntasRecientes,pulso,TABLES,DIA_MS} from '../mercadolibre/catalogo-competidor.mjs';

const HERMES='471589392',OTRO='555',NOSOTROS='2341378249';
const DIA=d=>new Date(Date.UTC(2026,10,d,12)).toISOString();
const AHORA=Date.parse(DIA(16));

// D1 de mentira: SQLite en memoria con la misma firma query(sql,params) que d1Client, con las
// tablas de la vigilancia de competencia del Worker ya cargadas.
function d1({productos=['MLU-P1','MLU-P2','MLU-P3'],dias=[]}={}){
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE comp_snapshots(snap_date TEXT,catalog_product_id TEXT,item_id TEXT,seller_id TEXT,price REAL,PRIMARY KEY(snap_date,catalog_product_id,item_id));
 CREATE TABLE comp_targets(catalog_product_id TEXT PRIMARY KEY,isbn TEXT,own_price REAL,priority INTEGER);
 CREATE TABLE comp_vendedor_dias(fecha TEXT NOT NULL,seller_id TEXT NOT NULL,nickname TEXT,operaciones INTEGER,nivel TEXT,at INTEGER NOT NULL,PRIMARY KEY(fecha,seller_id));
 CREATE TABLE comp_catalogo_fotos(id INTEGER);`);
 productos.forEach((p,i)=>{db.prepare('INSERT INTO comp_snapshots VALUES(?,?,?,?,?)').run('2026-11-10',p,`MLU9${i}`,HERMES,500);db.prepare('INSERT INTO comp_targets VALUES(?,?,?,?)').run(p,`978000000000${i}`,900+i,1);});
 for(const [fecha,n] of dias)db.prepare('INSERT INTO comp_vendedor_dias VALUES(?,?,?,?,?,?)').run(fecha,HERMES,'HERMES_PROMOSML',n,'gold',0);
 return async(sql,params=[])=>{const st=db.prepare(sql);return /^\s*(SELECT|PRAGMA|WITH)\b|\bRETURNING\b/i.test(sql)?st.all(...params).map(r=>({...r})):(st.run(...params),[]);};
}
// API de ML de mentira: ficha del vendedor, ofertas por producto, nombre del producto y preguntas.
function mlFalso({ofertas,transacciones=1200,ventas60=40,preguntas={}}){
 const calls=[];
 return {calls,stats:{llamadas:0},get:async path=>{
  calls.push(path);
  const u=new URL('https://api.mercadolibre.com'+path);
  // De un tercero, Mercado Libre muestra sólo el total de operaciones y el nivel.
  if(u.pathname===`/users/${HERMES}`)return {id:Number(HERMES),nickname:'HERMES_PROMOSML',seller_reputation:{level_id:'5_green',power_seller_status:'gold',transactions:{period:'historic',total:transacciones}}};
  let m=u.pathname.match(/^\/products\/([^/]+)\/items$/);
  if(m){const o=ofertas[m[1]];if(!o)throw Object.assign(new Error('http_404'),{status:404,code:'http_404'});return {results:o};}
  m=u.pathname.match(/^\/products\/([^/]+)$/);
  if(m)return {id:m[1],name:`Libro ${m[1]}`};
  if(u.pathname==='/questions/search'){const item=u.searchParams.get('item');return {total:(preguntas[item]??[]).length,questions:(preguntas[item]??[]).map(d=>({date_created:d}))};}
  throw Object.assign(new Error('ruta_inesperada '+path),{status:500});
 }};
}
const oferta=(item,seller,price,extra={})=>({item_id:item,seller_id:seller,price,currency_id:'UYU',shipping:{free_shipping:price>700,logistic_type:'xd_drop_off'},...extra});
const OFERTAS={
 'MLU-P1':[oferta('MLU90',HERMES,650),oferta('MLU1',NOSOTROS,600),oferta('MLU2',OTRO,700)],
 'MLU-P2':[oferta('MLU91',HERMES,800,{available_quantity:3}),oferta('MLU3',NOSOTROS,850)],
 'MLU-P3':[oferta('MLU4',OTRO,300)], // HERMES ya no está en este producto
};

test('leerVendedor, ofertaDelVendedor y preguntasRecientes',()=>{
 assert.deepEqual(leerVendedor({nickname:'X',seller_reputation:{power_seller_status:'gold',transactions:{period:'historic',total:12}}}),{nickname:'X',transacciones:12,ventas_60d:null,nivel:'gold'});
 assert.deepEqual(leerVendedor({nickname:'X',seller_reputation:{level_id:'5_green',transactions:{completed:'7',total:9},metrics:{sales:{completed:3}}}}),{nickname:'X',transacciones:9,ventas_60d:3,nivel:'5_green'});
 assert.deepEqual(leerVendedor(null),{nickname:null,transacciones:null,ventas_60d:null,nivel:null});
 const o=ofertaDelVendedor(OFERTAS['MLU-P1'],HERMES);
 assert.deepEqual(o,{item_id:'MLU90',precio:650,moneda:'UYU',cantidad:null,posicion:2,ofertas:3,precio_minimo:600,envio_gratis:0,logistica:'xd_drop_off'});
 assert.equal(ofertaDelVendedor(OFERTAS['MLU-P3'],HERMES),null);
 assert.equal(preguntasRecientes({questions:[{date_created:DIA(15)},{date_created:DIA(1)},{date_created:'basura'}]},AHORA),1);
});

test('la foto guarda la ficha del vendedor y sus ofertas en nuestros productos',async()=>{
 const query=d1(),ml=mlFalso({ofertas:OFERTAS,preguntas:{MLU90:[DIA(14),DIA(2)]}});
 const out=await tomarFoto({ml,query,seller:HERMES,now:()=>AHORA,intervalMs:0});
 assert.equal(out.completa,true);
 assert.equal(out.productos,3);
 assert.equal(out.items,2);
 assert.equal(out.errores,0);
 assert.equal(out.con_cantidad,1);
 assert.equal(out.transacciones,1200);
 const rows=await query(`SELECT item_id,producto,isbn,nombre,precio,cantidad,posicion,ofertas,precio_minimo,nuestro_precio,envio_gratis,preguntas_7d FROM ${TABLES.items} WHERE foto_id=? ORDER BY item_id`,[out.foto_id]);
 assert.deepEqual(rows,[
  {item_id:'MLU90',producto:'MLU-P1',isbn:'9780000000000',nombre:'Libro MLU-P1',precio:650,cantidad:null,posicion:2,ofertas:3,precio_minimo:600,nuestro_precio:900,envio_gratis:0,preguntas_7d:1},
  {item_id:'MLU91',producto:'MLU-P2',isbn:'9780000000001',nombre:'Libro MLU-P2',precio:800,cantidad:3,posicion:1,ofertas:2,precio_minimo:800,nuestro_precio:901,envio_gratis:1,preguntas_7d:0},
 ]);
 // Las tablas del primer intento se descartan.
 assert.deepEqual(await query("SELECT name FROM sqlite_master WHERE name LIKE 'comp_catalogo_%'"),[]);
});

test('en la segunda foto no se vuelve a pedir el nombre del producto y se siguen los productos ya vistos',async()=>{
 const query=d1();
 await tomarFoto({ml:mlFalso({ofertas:OFERTAS}),query,seller:HERMES,now:()=>AHORA,intervalMs:0});
 const ml=mlFalso({ofertas:OFERTAS});
 await tomarFoto({ml,query,seller:HERMES,now:()=>AHORA+DIA_MS,intervalMs:0});
 assert.ok(!ml.calls.some(p=>/^\/products\/[^/]+$/.test(p)),ml.calls.join('\n'));
 assert.equal(ml.calls.filter(p=>p.endsWith('/items?limit=50')).length,3);
});

test('movimiento: desaparecidas, nuevas, precios y cantidad entre dos fotos; serie de ventas',async()=>{
 const query=d1({dias:[['2026-11-01',1100],['2026-11-08',1150],['2026-11-09',1160],['2026-11-15',1190],['2026-11-16',1200]]});
 const f1=await tomarFoto({ml:mlFalso({ofertas:OFERTAS,transacciones:1190}),query,seller:HERMES,now:()=>AHORA-DIA_MS,intervalMs:0});
 const despues={
  'MLU-P1':[oferta('MLU1',NOSOTROS,600)], // HERMES desapareció
  'MLU-P2':[oferta('MLU91',HERMES,780,{available_quantity:2}),oferta('MLU3',NOSOTROS,850)], // bajó precio y cantidad
  'MLU-P3':[oferta('MLU92',HERMES,290),oferta('MLU4',OTRO,300)], // nueva
 };
 const f2=await tomarFoto({ml:mlFalso({ofertas:despues,transacciones:1200}),query,seller:HERMES,now:()=>AHORA,intervalMs:0});
 const mov=await movimiento({query,seller:HERMES});
 assert.equal(mov.actual.id,f2.foto_id);assert.equal(mov.anterior.id,f1.foto_id);
 assert.deepEqual(mov.totales,{vendidos:1,desaparecidos:1,nuevos:1,precios:1});
 assert.equal(mov.desaparecidos[0].item_id,'MLU90');
 assert.equal(mov.nuevos[0].item_id,'MLU92');
 assert.deepEqual([mov.precios[0].precio_antes,mov.precios[0].precio_despues],[800,780]);
 assert.deepEqual([mov.vendidos[0].cantidad_antes,mov.vendidos[0].cantidad_despues],[3,2]);
 const guardado=await query(`SELECT tipo,COUNT(*) n FROM ${TABLES.movimientos} WHERE foto_id=? GROUP BY tipo ORDER BY tipo`,[f2.foto_id]);
 assert.deepEqual(guardado,[{tipo:'desaparecido',n:1},{tipo:'nuevo',n:1},{tipo:'precio',n:1},{tipo:'vendido',n:1}]);
 const serie=await serieVentas(query,HERMES);
 assert.deepEqual(serie.semana,{desde:'2026-11-09',hasta:'2026-11-16',ventas:40});
 assert.deepEqual(serie.dias.map(d=>d.ventas),[50,10,30,10]);
 const texto=informe(mov,{serie});
 assert.match(texto,/HERMES_PROMOSML \(471589392\)/);
 assert.match(texto,/Última semana \(2026-11-09 a 2026-11-16\): 40 operaciones/);
 assert.match(texto,/Entre las dos fotos .*: 10 operaciones/);
 assert.match(texto,/DESAPARECIDAS .*: 1\.\n- Libro MLU-P1 \| estaba \$650 en el puesto 2/);
 assert.match(texto,/BAJÓ LA CANTIDAD .*: 1\.\n- Libro MLU-P2 \| 3 -> 2 u\./);
 assert.match(texto,/NUEVAS: 1\.\n- Libro MLU-P3 \| \$290 \(nosotros \$902\)/);
 assert.match(texto,/CAMBIOS DE PRECIO: 1\.\n- Libro MLU-P2 \| \$800 -> \$780/);
 assert.match(texto,/_CustId_471589392/);
 assert.equal(asunto(mov,serie),'HERMES_PROMOSML: 40 operaciones en la semana, 1 bajas y 1 nuevas en nuestros libros');
});

test('la primera foto ya informa ventas de la semana y avisa que el movimiento sale en la próxima',async()=>{
 const query=d1({dias:[['2026-11-09',1160],['2026-11-16',1200]]});
 await tomarFoto({ml:mlFalso({ofertas:OFERTAS}),query,seller:HERMES,now:()=>AHORA,intervalMs:0});
 const mov=await movimiento({query,seller:HERMES}),serie=await serieVentas(query,HERMES);
 assert.equal(mov.anterior,null);
 assert.equal(mov.listado.length,2);
 const texto=informe(mov,{serie});
 assert.match(texto,/Es la primera foto/);
 assert.match(texto,/Hoy: 1\.200 operaciones en total\./);
 assert.match(texto,/Mercado Libre muestra de un vendedor ajeno/);
 assert.match(texto,/SUS PUBLICACIONES EN NUESTROS LIBROS/);
 assert.equal(asunto(mov,serie),'HERMES_PROMOSML: 40 operaciones en la semana, 2 publicaciones en nuestros libros');
});

test('un producto que falla no tira la foto: se cuenta como error',async()=>{
 const query=d1();
 const base=mlFalso({ofertas:OFERTAS});
 const ml={...base,get:async p=>{if(p.startsWith('/products/MLU-P2/items'))throw Object.assign(new Error('http_500'),{status:500,code:'http_500'});return base.get(p);}};
 const out=await tomarFoto({ml,query,seller:HERMES,now:()=>AHORA,intervalMs:0});
 assert.equal(out.completa,true);assert.equal(out.errores,1);assert.equal(out.items,1);
});

test('correr toma la foto, manda el informe por mail y sólo loguea conteos',async()=>{
 const query=d1({dias:[['2026-11-09',1160],['2026-11-16',1200]]}),mails=[],logs=[];
 const out=await correr({query,ml:mlFalso({ofertas:OFERTAS}),seller:HERMES,intervalMs:0,send:async m=>{mails.push(m);return 'enviado';},log:x=>logs.push(x),runUrl:'https://ejemplo/run/1'});
 assert.equal(out.mail,'enviado');
 assert.equal(mails.length,1);
 assert.equal(mails[0].prefijo,'Competencia ML');
 assert.match(mails[0].texto,/compite en 2 publicaciones de 3 productos/);
 assert.match(mails[0].texto,/Corrida: https:\/\/ejemplo\/run\/1/);
 assert.ok(!JSON.stringify(logs).includes('Libro MLU'));
});

test('podar deja las últimas fotos',async()=>{
 const query=d1();
 for(let i=0;i<4;i++)await tomarFoto({ml:mlFalso({ofertas:OFERTAS}),query,seller:HERMES,now:()=>AHORA+i,intervalMs:0});
 assert.equal((await query(`SELECT COUNT(*) n FROM ${TABLES.fotos}`))[0].n,4);
 assert.equal(await podar(query,HERMES,2),2);
 assert.equal((await query(`SELECT COUNT(*) n FROM ${TABLES.items}`))[0].n,4);
});

test('la foto anota el día y el pulso diario arma la serie sin tomar foto',async()=>{
 const query=d1();
 await tomarFoto({ml:mlFalso({ofertas:OFERTAS,transacciones:1000}),query,seller:HERMES,now:()=>AHORA-7*DIA_MS,intervalMs:0});
 for(let d=6;d>=1;d--)await pulso({ml:mlFalso({ofertas:OFERTAS,transacciones:1000+(7-d)*3}),query,seller:HERMES,now:()=>AHORA-d*DIA_MS});
 const hoy=await pulso({ml:mlFalso({ofertas:OFERTAS,transacciones:1021}),query,seller:HERMES,now:()=>AHORA});
 assert.equal(hoy.con_contador,true);
 // Dos pulsos el mismo día: una sola fila, con el último valor.
 await pulso({ml:mlFalso({ofertas:OFERTAS,transacciones:1022}),query,seller:HERMES,now:()=>AHORA+3600000});
 assert.equal((await query(`SELECT COUNT(*) n FROM ${TABLES.dias}`))[0].n,8);
 const serie=await serieVentas(query,HERMES);
 assert.equal(serie.semana.ventas,22);
 assert.deepEqual(serie.dias.map(d=>d.ventas),[3,3,3,3,3,3,4]);
 const out=await correr({query,ml:mlFalso({ofertas:OFERTAS}),seller:HERMES,accion:'pulso',send:async()=>{throw new Error('el pulso no manda mail');},log:()=>{}});
 assert.equal(out.pulso.evento,'pulso');
});
