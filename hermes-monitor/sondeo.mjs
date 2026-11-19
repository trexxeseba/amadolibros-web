// Prueba temporal de lectura (no se mergea): por qué Mercado Libre dejó dos publicaciones en revisión.
import fs from 'node:fs';
import {CUENTAS} from '../precio-ganador/src/config.mjs';
import {fuenteTokenD1} from '../precio-ganador/src/token.mjs';
import {crearCliente} from '../precio-ganador/src/ml.mjs';
import {CUENTA_HERMES} from './lib.mjs';
const ml=crearCliente(fuenteTokenD1(CUENTAS[CUENTA_HERMES]),{concurrencia:1});
const pausa=ms=>new Promise(r=>setTimeout(r,ms));
const get=async p=>{await pausa(400);try{return await ml.get(p);}catch(e){return {error:e.code,detalle:e.detalle};}};
for(const id of ['MLU1541303152','MLU1541276786']){
 const it=await get('/items/'+id);
 console.log('=== ITEM',id,JSON.stringify({status:it.status,sub_status:it.sub_status,title:it.title??it.family_name,price:it.price,date_created:it.date_created,last_updated:it.last_updated,health:it.health,tags:it.tags,catalog_listing:it.catalog_listing,fotos:(it.pictures||[]).map(p=>p.size+' '+p.max_size),atributos:(it.attributes||[]).map(a=>a.id+'='+a.value_name).slice(0,14),sku:it.seller_custom_field}));
 const m=await get(`/moderations/last_moderation/${id}-ITM`);
 console.log('MODERACION',JSON.stringify(m).slice(0,1500));
}
// ¿cuántas de las últimas 60 publicadas no están activas?
const pub=JSON.parse(fs.readFileSync(process.env.RUNNER_TEMP+'/pub.json','utf8'));
const ult=Object.entries(pub).filter(([,v])=>v.item_id&&v.ts).sort((a,b)=>b[1].ts-a[1].ts).slice(0,60);
const cuenta={};const malos=[];
for(const [k,v] of ult){const it=await get('/items/'+v.item_id);const e=(it.status||'err')+'/'+((it.sub_status||[]).join(',')||'-');cuenta[e]=(cuenta[e]||0)+1;if(it.status!=='active'&&!String(it.sub_status).includes('picture_download_pending'))malos.push(k+' '+v.item_id+' '+e);}
console.log('ESTADO de las últimas 60:',JSON.stringify(cuenta));
console.log('NO ACTIVAS:',malos.join(' | ')||'ninguna');
