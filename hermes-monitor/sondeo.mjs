// Sondeo de LECTURA (no escribe nada en Mercado Libre): muestra qué datos entrega la API oficial
// para unas pocas fichas de catálogo, para saber de dónde sacar precio y stock de Hermes.
// Una consulta por vez, con 500 ms de pausa. Sólo imprime datos públicos de las fichas.
import fs from 'node:fs/promises';
import {CUENTAS} from '../precio-ganador/src/config.mjs';
import {fuenteTokenD1} from '../precio-ganador/src/token.mjs';
import {crearCliente} from '../precio-ganador/src/ml.mjs';

const pausa=ms=>new Promise(r=>setTimeout(r,ms));
const ml=crearCliente(fuenteTokenD1(CUENTAS.libros),{concurrencia:1});
const fichas=JSON.parse(await fs.readFile(process.argv[2],'utf8')).slice(0,Number(process.argv[3]||3));
const get=async(path)=>{await pausa(500);try{return await ml.get(path);}catch(e){console.log('ERR',path,e.code,JSON.stringify(e.detalle));return null;}};
const campos=(o,ks)=>Object.fromEntries(ks.map(k=>[k,o?.[k]]));

const vendedores=new Map(); // seller_id -> {nickname, fichas}
for(const f of fichas){
 console.log('\n=== ficha',f.n,f.producto);
 const lista=await get(`/products/${f.producto}/items?limit=50`);
 const ofertas=lista?.results??[];
 console.log('ofertas',ofertas.length,'de',lista?.paging?.total);
 for(const o of ofertas){
  if(!vendedores.has(o.seller_id)){
   const u=await get(`/users/${o.seller_id}`);
   vendedores.set(o.seller_id,{nickname:u?.nickname??null});
  }
 }
 const hermes=ofertas.filter(o=>/hermes/i.test(vendedores.get(o.seller_id)?.nickname??''));
 console.log('ofertas de Hermes:',JSON.stringify(hermes.map(o=>({item:o.item_id,seller:o.seller_id,precio:o.price}))));
 // Para ver qué stock/estado expone un item ajeno: el de Hermes si hay, si no el primero.
 const muestra=hermes[0]??ofertas[0];
 if(muestra){
  const it=await get(`/items/${muestra.item_id}`);
  console.log('item',muestra.item_id,JSON.stringify(campos(it,['status','sub_status','price','available_quantity','sold_quantity','seller_id','catalog_listing','condition'])));
 }
}
console.log('\nvendedores vistos:',JSON.stringify([...vendedores].map(([id,v])=>[id,v.nickname])));
console.log('llamadas',JSON.stringify(ml.stats));
