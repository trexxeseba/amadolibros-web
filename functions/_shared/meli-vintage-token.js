import { MeliAuthError } from '../../worker-sync/meli-auth.js';

export const VINTAGE_SELLER_ID = '2341378249';
const APP_ID = '4741021817925208';
const LOCK_SCHEMA = 'CREATE TABLE IF NOT EXISTS ml_oauth_seller_locks (app_id TEXT NOT NULL,seller_id TEXT NOT NULL,owner TEXT NOT NULL,until_ms INTEGER NOT NULL,PRIMARY KEY(app_id,seller_id))';

// No bootstrap or fallback to Libros. A refresh rotates only this app/seller row.
// The durable lock plus compare-and-swap prevents concurrent rotation.
export function createVintageTokenProvider({fetcher=(...args)=>fetch(...args),now=Date.now}={}) {
 const fail=(code,retryable=false)=>new MeliAuthError(code,{status:retryable?503:401,retryable});
 const stmt=(db,sql,...args)=>db.prepare(sql).bind(...args);
 const read=db=>stmt(db,'SELECT * FROM ml_oauth_sellers WHERE app_id=? AND seller_id=?',APP_ID,VINTAGE_SELLER_ID).first();
 const usable=row=>typeof row?.access_token==='string'&&row.access_token&&Number(row.access_expires_at)>now()+300000;
 async function json(path,options) {
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  try {
   const res=await fetcher('https://api.mercadolibre.com'+path,{...options,redirect:'manual',signal:controller.signal});
   if(!res.ok)throw fail(res.status===429||res.status>=500?'vintage_auth_upstream':'vintage_auth_rejected',res.status===429||res.status>=500);
   try{return await res.json();}catch{throw fail('vintage_auth_invalid_json',true);}
  }catch(error){if(error instanceof MeliAuthError)throw error;throw fail('vintage_auth_transport',true);}
  finally{clearTimeout(timer);}
 }
 async function getAccessToken(env) {
  const db=env?.ORDERS_DB,secret=env?.MELI_VINTAGE_CLIENT_SECRET?.trim();
  if(!db?.prepare||!secret||(env.APP_ID&&String(env.APP_ID)!==APP_ID))throw fail('vintage_auth_not_configured');
  let row=await read(db);
  if(!row)throw fail('vintage_authorization_missing');
  if(usable(row))return row.access_token;
  await db.prepare(LOCK_SCHEMA).run();
  const owner=crypto.randomUUID();
  const lock=await stmt(db,'INSERT INTO ml_oauth_seller_locks(app_id,seller_id,owner,until_ms) VALUES(?,?,?,?) ON CONFLICT(app_id,seller_id) DO UPDATE SET owner=excluded.owner,until_ms=excluded.until_ms WHERE until_ms<=? RETURNING owner',APP_ID,VINTAGE_SELLER_ID,owner,now()+60000,now()).first();
  if(!lock)throw fail('vintage_auth_busy',true);
  try {
   row=await read(db);
   if(usable(row))return row.access_token;
   if(!row?.refresh_token)throw fail('vintage_authorization_missing');
   const data=await json('/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},body:new URLSearchParams({grant_type:'refresh_token',client_id:APP_ID,client_secret:secret,refresh_token:row.refresh_token})});
   if(String(data.user_id)!==VINTAGE_SELLER_ID||typeof data.access_token!=='string'||!data.access_token||typeof data.refresh_token!=='string'||!data.refresh_token||!(Number(data.expires_in)>0))throw fail('vintage_auth_identity_mismatch');
   const user=await json('/users/me',{method:'GET',headers:{Authorization:'Bearer '+data.access_token,Accept:'application/json'}});
   if(String(user.id)!==VINTAGE_SELLER_ID||user.site_id!=='MLU')throw fail('vintage_auth_identity_mismatch');
   const saved=await stmt(db,'UPDATE ml_oauth_sellers SET access_token=?,access_expires_at=?,refresh_token=? WHERE app_id=? AND seller_id=? AND refresh_token=? AND EXISTS(SELECT 1 FROM ml_oauth_seller_locks WHERE app_id=? AND seller_id=? AND owner=? AND until_ms>?) RETURNING seller_id',data.access_token,now()+Number(data.expires_in)*1000,data.refresh_token,APP_ID,VINTAGE_SELLER_ID,row.refresh_token,APP_ID,VINTAGE_SELLER_ID,owner,now()).first();
   if(!saved)throw fail('vintage_auth_rotation_conflict',true);
   return data.access_token;
  }finally{await stmt(db,'DELETE FROM ml_oauth_seller_locks WHERE app_id=? AND seller_id=? AND owner=?',APP_ID,VINTAGE_SELLER_ID,owner).run();}
 }
 async function invalidateAccessToken(env,token) {
  await stmt(env.ORDERS_DB,'UPDATE ml_oauth_sellers SET access_expires_at=0 WHERE app_id=? AND seller_id=? AND access_token=?',APP_ID,VINTAGE_SELLER_ID,token).run();
 }
 return {getAccessToken,invalidateAccessToken};
}
export const vintageTokens=createVintageTokenProvider();
