// Solo lectura: en cada ficha, dónde está el precio de Hermes frente al resto de las ofertas.
//   node hermes-monitor/mercado.mjs <fichas.json>
// Una ficha por vez, 500 ms de pausa. Imprime una línea por ficha y un resumen. Datos públicos.
import fs from 'node:fs/promises';
import {CUENTAS} from '../precio-ganador/src/config.mjs';
import {fuenteTokenD1} from '../precio-ganador/src/token.mjs';
import {crearCliente} from '../precio-ganador/src/ml.mjs';
import {ofertaDeHermes} from './lib.mjs';

const pausa=ms=>new Promise(r=>setTimeout(r,ms));
const ml=crearCliente(fuenteTokenD1(CUENTAS.libros),{concurrencia:1});
const fichas=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
const filas=[];
for(const f of fichas){
 const ofertas=[];
 for(let off=0;off<150;off+=50){
  await pausa(500);
  let r;try{r=await ml.get(`/products/${f.producto}/items?limit=50&offset=${off}`);}catch(e){break;}
  ofertas.push(...(r?.results??[]));
  if(ofertas.length>=(r?.paging?.total??0))break;
 }
 const h=ofertaDeHermes(ofertas);
 const precios=ofertas.map(o=>o.price).filter(p=>p>0).sort((a,b)=>a-b);
 if(!h||!precios.length){filas.push({n:f.n,sin:true});continue;}
 const puesto=precios.filter(p=>p<h.price).length+1;
 const mediana=precios[Math.floor(precios.length/2)];
 filas.push({n:f.n,hermes:h.price,min:precios[0],mediana,puesto,de:precios.length});
 console.log(`${f.n}\thermes ${h.price}\tmin ${precios[0]}\tmediana ${mediana}\tpuesto ${puesto}/${precios.length}`);
}
const ok=filas.filter(f=>!f.sin);
const pct=(a,b)=>Math.round(100*a/b);
console.log('\nRESUMEN',JSON.stringify({fichas:filas.length,leidas:ok.length,sin_oferta_hermes:filas.length-ok.length,
 hermes_mas_barato_que_la_mediana:ok.filter(f=>f.hermes<=f.mediana).length,
 hermes_en_el_tercio_mas_barato:ok.filter(f=>f.puesto<=Math.ceil(f.de/3)).length,
 hermes_mas_de_el_doble_del_minimo:ok.filter(f=>f.hermes>2*f.min).length,
 mediana_de_hermes_sobre_minimo_pct:pct(ok.map(f=>f.hermes/f.min).sort((a,b)=>a-b)[Math.floor(ok.length/2)]*100,100)}));
