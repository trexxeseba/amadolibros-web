// Renovación de la conexión local de Vintage sin navegador.
//
// Hace lo mismo que el dueño hace a mano en el panel, en este orden:
//   revocar la conexión anterior -> cargar el stock del proveedor
//   (begin/import/commit) -> iniciar el lote con ese stock (start) ->
//   habilitar la PC y emitir la conexión nueva (grant).
// Se autentica con VINTAGE_RENEW_SECRET (secreto de Pages) en vez de la sesión
// del panel. Sin ese secreto la ruta responde 503 y no hace nada. Sólo opera
// sobre el lote de Amado Vintage: no acepta vendedor, política ni run_id.
import {createVintageBulk,VintageBulkStore,BULK_RUN} from './meli-vintage-bulk.js';
import {createLocalAccess} from './vintage-local-access.js';
import {VINTAGE_SELLER_ID,vintageTokens} from './meli-vintage-token.js';
import {localExecutorState,stopLocalExecutor} from './vintage-executor-state.js';
import {vintagePolicy,vintageCompetitivePolicy} from '../../worker-sync/vintage-pricing.js';
import {PublicationError,policyHash,sha256} from '../../worker-sync/publication-policy.js';

export const RENEW_FIELDS={
 begin:['feed_id','source_date','source_sha256','expected_rows'],
 import:['feed_id','rows'],
 commit:['feed_id'],
 renew:['feed_id'],
 revoke:[],
 status:[],
 keepalive:[],
};
// keepalive renueva el token de Vintage si le quedan menos de 3 horas, para que Precio Ganador
// (que sólo lo lee de D1 y espera 8 minutos) lo encuentre vigente sin depender de la PC.
// Nunca devuelve el token: sólo su vencimiento.
export const KEEPALIVE_MARGIN_MS=3*3600000;
const VINTAGE_APP_ID='4741021817925208';
// Un ejecutor vivo consulta al servidor cada pocos segundos. Con actividad
// reciente no se le quita la clave: primero hay que detenerlo con `revoke`.
export const LIVE_WINDOW_MS=120000;

// Claves de corrida del publicador de la nube: el workflow genera una al azar, guarda su hash en
// D1 con vencimiento y la borra al terminar. Quien puede escribir en D1 ya tiene los tokens de
// Mercado Libre, así que no abre nada nuevo y evita un secreto más en GitHub.
export const CLOUD_KEYS_TABLE='ml_vintage_cloud_keys';
export async function authorizeRenew(env,header,now=Date.now()){
 const secret=env?.VINTAGE_RENEW_SECRET,given=String(header??'').replace(/^Bearer /,'');
 const hasSecret=typeof secret==='string'&&secret.length>=32;
 if(hasSecret&&await sha256(given)===await sha256(secret))return;
 if(/^[a-f0-9]{64}$/.test(given)&&env?.ORDERS_DB){
  const table=await env.ORDERS_DB.prepare("SELECT name FROM sqlite_master WHERE name=?").bind(CLOUD_KEYS_TABLE).first();
  if(table&&await env.ORDERS_DB.prepare(`SELECT 1 FROM ${CLOUD_KEYS_TABLE} WHERE key_hash=? AND expires_at>?`).bind(await sha256(given),now).first())return;
 }
 if(!hasSecret&&!/^[a-f0-9]{64}$/.test(given))throw new PublicationError('renew_not_configured',503);
 throw new PublicationError('renew_unauthorized',401);
}

export function createVintageRenew({bulk=createVintageBulk(),access=createLocalAccess(),tokens=vintageTokens,now=Date.now}={}){
 async function renew(env,{feed_id}){
  const state=await localExecutorState(env,now());
  if(state.active&&state.last_at&&now()-state.last_at<LIVE_WINDOW_MS)throw new PublicationError('local_executor_running',409);
  // Conexión olvidada o sin uso reciente: se revoca y se emite una nueva.
  if(state.active)await stopLocalExecutor(env);
  const store=new VintageBulkStore(env.ORDERS_DB,{sellerId:VINTAGE_SELLER_ID});
  await store.initialize();
  const run=await store.run(BULK_RUN);
  if(!run)throw new PublicationError('bulk_not_found',404);
  const hash=await applyCompetitivePolicy(env,store,run);
  await bulk.command(env,'start',{feed_id,policy_hash:hash});
  return access.grant(env);
 }
 // Precio competitivo de Vintage (decisión del dueño): se aplica una sola vez, acá, con
 // el ejecutor local ya detenido. Queda registrado como enmienda (hash anterior -> nuevo)
 // para que la PC acepte el cambio de política sin tratarlo como una política ajena. Los
 // trabajos todavía sin alta ni recibo vuelven a pendiente para cotizarse con la política nueva.
 async function applyCompetitivePolicy(env,store,run){
  const current=vintagePolicy(JSON.parse(run.policy_json)),wanted=vintageCompetitivePolicy(current);
  const hash=await policyHash(wanted);
  if(hash===run.policy_hash)return hash;
  if(run.lease_until>now())throw new PublicationError('run_busy',409);
  await env.ORDERS_DB.batch([
   env.ORDERS_DB.prepare('INSERT OR IGNORE INTO ml_vintage_bulk_policy_amendments VALUES(?,?,?,?,?,?)').bind(run.id,run.policy_hash,hash,run.policy_json,JSON.stringify(wanted),now()),
   store.stmt('UPDATE ml_pub_runs SET policy_json=?,policy_hash=?,approved_hash=?,updated_at=? WHERE id=? AND policy_hash=?',JSON.stringify(wanted),hash,hash,now(),run.id,run.policy_hash),
   store.stmt("UPDATE ml_pub_jobs SET state='pending',payload_json=NULL,next_at=0,error_code=NULL WHERE run_id=? AND item_id IS NULL AND state IN ('pending','validated','retry') AND NOT EXISTS(SELECT 1 FROM ml_vintage_pub_receipts r WHERE r.seller_id=? AND r.isbn=ml_vintage_pub_jobs.isbn)",run.id,VINTAGE_SELLER_ID),
  ]);
  return hash;
 }
 async function keepalive(env){
  const read=async()=>Number((await env.ORDERS_DB.prepare('SELECT access_expires_at FROM ml_oauth_sellers WHERE app_id=? AND seller_id=?').bind(VINTAGE_APP_ID,VINTAGE_SELLER_ID).first())?.access_expires_at??0);
  const before=await read();
  if(before-now()>=KEEPALIVE_MARGIN_MS)return {refreshed:false,expires_at:before};
  // Vencer el token actual en D1 obliga al proveedor a rotarlo (con su lock y su control de identidad).
  await env.ORDERS_DB.prepare('UPDATE ml_oauth_sellers SET access_expires_at=0 WHERE app_id=? AND seller_id=? AND access_expires_at=?').bind(VINTAGE_APP_ID,VINTAGE_SELLER_ID,before).run();
  try{await tokens.getAccessToken(env);}
  catch(error){
   // Si Mercado Libre no rotó, el token anterior sigue sirviendo: se le devuelve su vencimiento.
   await env.ORDERS_DB.prepare('UPDATE ml_oauth_sellers SET access_expires_at=? WHERE app_id=? AND seller_id=? AND access_expires_at=0').bind(before,VINTAGE_APP_ID,VINTAGE_SELLER_ID).run();
   throw error;
  }
  return {refreshed:true,expires_at:await read()};
 }
 async function command(env,header,action,args={}){
  await authorizeRenew(env,header,now());
  if(!Object.hasOwn(RENEW_FIELDS,action))throw new PublicationError('invalid_renew_action',400);
  if(action==='status')return bulk.status(env);
  if(action==='keepalive')return keepalive(env);
  if(['begin','import','commit'].includes(action))return bulk.command(env,action,args);
  // Revocar también pausa el lote: ningún ejecutor sigue publicando.
  if(action==='revoke')return bulk.command(env,'pause',{run_id:BULK_RUN});
  return renew(env,args);
 }
 return {command};
}
