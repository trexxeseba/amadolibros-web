// Corrección del 18/11/2026 (no se mergea): CIERRA en Amado Libros las 149 publicaciones creadas por error
// en esa cuenta. Cierra (status closed, a pedido de Seba; no borra), solo las del archivo, y solo si son de Libros, están pausadas o activas
// y llevan la marca HERMES- en su SKU. Una por vez, con pausa.
import fs from 'node:fs/promises';
import {CUENTAS} from '../precio-ganador/src/config.mjs';
import {fuenteTokenD1} from '../precio-ganador/src/token.mjs';
import {crearCliente} from '../precio-ganador/src/ml.mjs';
const ml=crearCliente(fuenteTokenD1(CUENTAS.libros),{concurrencia:1});
const pausa=ms=>new Promise(r=>setTimeout(r,ms));
const ids=(await fs.readFile('hermes-monitor/pausar-libros-2026-11-18.txt','utf8')).split('\n').map(s=>s.trim()).filter(s=>/^MLU\d+$/.test(s));
const cuenta={};const sumar=k=>{cuenta[k]=(cuenta[k]||0)+1;};
for(const id of ids){
 await pausa(500);
 let it;try{it=await ml.get(`/items/${id}`);}catch(e){sumar('no_se_pudo_leer');console.log(id,'no_se_pudo_leer',e.code);continue;}
 if(String(it.seller_id)!==CUENTAS.libros.sellerId||!String(it.seller_custom_field||'').startsWith('HERMES-')){sumar('no_es_de_hermes_no_se_toca');continue;}
 if(it.status!=='active'&&it.status!=='paused'){sumar('ya_'+it.status);continue;}
 try{await ml.put(`/items/${id}`,{status:'closed'});}catch(e){sumar('fallo_'+e.code);console.log(id,'fallo',e.code);continue;}
 const d=await ml.get(`/items/${id}`).catch(()=>null);
 sumar(d?.status==='closed'?'cerrada':'no_quedo_cerrada_'+d?.status);
 await pausa(300);
}
console.log('RESUMEN',JSON.stringify({total:ids.length,...cuenta}));
