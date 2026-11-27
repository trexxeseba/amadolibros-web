// Latido de la campaña de Amado Vintage: si hace demasiado que no hay altas nuevas y nada lo explica,
// avisa por ntfy. Antes lo corría el Worker de sync (Amado Libros) cada 5 minutos; desde el
// desenganche de cuentas (Seba, 27/11/2026) corre acá, desde .github/workflows/vintage-latido.yml.
//
// Sólo SELECT sobre los recibos de Vintage en D1 y un POST a ntfy. No usa ningún token de Mercado
// Libre. La reserva "ya avisé" va en una tabla chica de D1 (antes, KV del Worker), con el mismo
// plazo por aviso que tenía: 1 hora para "sin altas", 6 horas para "SBS no publica la lista".
//
//   node scripts/vintage-cloud/latido.mjs
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {d1Client} from './d1.mjs';
import {checkVintageHeartbeat} from '../../functions/_shared/vintage-watch.js';

export const CLAIMS_TABLE='vintage_watch_claims';

// La interfaz de D1 que usa vintage-watch.js (prepare/bind/first), sobre la API de Cloudflare.
export function d1Binding(query){
 const stmt=(sql,params=[])=>({bind:(...p)=>stmt(sql,p),first:async()=>(await query(sql,params))[0]??null});
 return {prepare:sql=>stmt(sql)};
}

// Lo mismo que hacía el KV del Worker: get devuelve algo mientras la reserva esté vigente.
export function d1Claims(query,now=()=>Date.now()){
 let ready=null;
 const schema=()=>ready??=query(`CREATE TABLE IF NOT EXISTS ${CLAIMS_TABLE} (key TEXT PRIMARY KEY,until INTEGER NOT NULL)`);
 return {
  async get(key){await schema();const r=(await query(`SELECT until FROM ${CLAIMS_TABLE} WHERE key=?`,[key]))[0];return r&&Number(r.until)>now()?String(r.until):null;},
  async put(key,_value,{expirationTtl=3600}={}){await schema();await query(`INSERT INTO ${CLAIMS_TABLE}(key,until) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET until=excluded.until`,[key,now()+expirationTtl*1000]);},
 };
}

export async function latido({query=d1Client(),env=process.env,fetchFn=fetch,now=new Date()}={}){
 return checkVintageHeartbeat({
  VINTAGE_WATCH_ENABLED:env.VINTAGE_WATCH_ENABLED??'true',
  VINTAGE_WATCH_STALL_MINUTES:env.VINTAGE_WATCH_STALL_MINUTES??'45',
  VINTAGE_WATCH_WARMUP_MINUTES:env.VINTAGE_WATCH_WARMUP_MINUTES??'60',
  VINTAGE_WATCH_SUPPLIER_GRACE_MINUTES:env.VINTAGE_WATCH_SUPPLIER_GRACE_MINUTES??'240',
  VINTAGE_NOTIFY_URL:env.VINTAGE_NOTIFY_URL,
  ORDERS_DB:d1Binding(query),
  AMADO_KV:d1Claims(query,()=>now.getTime()),
 },{now,fetchFn});
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const r=await latido();
 // Sólo el estado y minutos: nada de publicaciones ni montos (el repo es público).
 console.log(JSON.stringify({state:r.state,reason:r.reason??null,notified:r.notified??null,gapMinutes:r.gapMinutes??null}));
}
