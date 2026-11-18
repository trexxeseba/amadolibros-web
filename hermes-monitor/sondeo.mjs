// Sondeo de LECTURA (no escribe nada en Mercado Libre): muestra qué datos entrega la API oficial
// para unas pocas fichas de catálogo de Hermes, para saber de dónde sacar precio y stock.
// Una consulta por vez, con 500 ms de pausa. Sólo imprime datos públicos de las fichas.
import fs from 'node:fs/promises';
import {CUENTAS} from '../precio-ganador/src/config.mjs';
import {fuenteTokenD1} from '../precio-ganador/src/token.mjs';
import {crearCliente} from '../precio-ganador/src/ml.mjs';

const pausa=ms=>new Promise(r=>setTimeout(r,ms));
const ml=crearCliente(fuenteTokenD1(CUENTAS.libros),{concurrencia:1});
const fichas=JSON.parse(await fs.readFile(process.argv[2],'utf8')).slice(0,Number(process.argv[3]||3));
const forma=(v,d=0)=>v&&typeof v==='object'?(Array.isArray(v)?`[${v.length}]`+(v[0]&&d<2?forma(v[0],d+1):''):'{'+Object.entries(v).slice(0,25).map(([k,x])=>`${k}:${forma(x,d+1)}`).join(',')+'}'):JSON.stringify(v)?.slice(0,60);
const probar=async(path)=>{await pausa(500);try{const r=await ml.get(path);console.log('OK ',path,'\n   ',forma(r));return r;}catch(e){console.log('ERR',path,e.code,JSON.stringify(e.detalle));return null;}};

for(const f of fichas){
 console.log('\n=== ficha',f.n,f.producto);
 const p=await probar(`/products/${f.producto}`);
 await probar(`/products/${f.producto}/items?limit=5`);
 const win=p?.buy_box_winner?.item_id;
 if(win)await probar(`/items/${win}`);
}
await probar('/sites/MLU/search?nickname=HERMESPROMOS&limit=1');
console.log('\nllamadas',JSON.stringify(ml.stats));
