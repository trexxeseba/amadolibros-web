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
import {VINTAGE_SELLER_ID} from './meli-vintage-token.js';
import {localExecutorState,stopLocalExecutor} from './vintage-executor-state.js';
import {vintagePolicy} from '../../worker-sync/vintage-pricing.js';
import {PublicationError,policyHash,sha256} from '../../worker-sync/publication-policy.js';

export const RENEW_FIELDS={
 begin:['feed_id','source_date','source_sha256','expected_rows'],
 import:['feed_id','rows'],
 commit:['feed_id'],
 renew:['feed_id'],
 revoke:[],
 status:[],
};
// Un ejecutor vivo consulta al servidor cada pocos segundos. Con actividad
// reciente no se le quita la clave: primero hay que detenerlo con `revoke`.
export const LIVE_WINDOW_MS=120000;

export async function authorizeRenew(env,header){
 const secret=env?.VINTAGE_RENEW_SECRET;
 if(typeof secret!=='string'||secret.length<32)throw new PublicationError('renew_not_configured',503);
 const given=String(header??'').replace(/^Bearer /,'');
 if(await sha256(given)!==await sha256(secret))throw new PublicationError('renew_unauthorized',401);
}

export function createVintageRenew({bulk=createVintageBulk(),access=createLocalAccess(),now=Date.now}={}){
 async function renew(env,{feed_id}){
  const state=await localExecutorState(env,now());
  if(state.active&&state.last_at&&now()-state.last_at<LIVE_WINDOW_MS)throw new PublicationError('local_executor_running',409);
  // Conexión olvidada o sin uso reciente: se revoca y se emite una nueva.
  if(state.active)await stopLocalExecutor(env);
  const store=new VintageBulkStore(env.ORDERS_DB,{sellerId:VINTAGE_SELLER_ID});
  await store.initialize();
  const run=await store.run(BULK_RUN);
  if(!run)throw new PublicationError('bulk_not_found',404);
  const hash=await policyHash(vintagePolicy(JSON.parse(run.policy_json)));
  await bulk.command(env,'start',{feed_id,policy_hash:hash});
  return access.grant(env);
 }
 async function command(env,header,action,args={}){
  await authorizeRenew(env,header);
  if(!Object.hasOwn(RENEW_FIELDS,action))throw new PublicationError('invalid_renew_action',400);
  if(action==='status')return bulk.status(env);
  if(['begin','import','commit'].includes(action))return bulk.command(env,action,args);
  // Revocar también pausa el lote: ningún ejecutor sigue publicando.
  if(action==='revoke')return bulk.command(env,'pause',{run_id:BULK_RUN});
  return renew(env,args);
 }
 return {command};
}
