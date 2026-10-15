// Sincronización crítica de stock para las publicaciones creadas por la cola
// (SKU AMADO-AR-ISBN, recibos `published`). Fuente: el snapshot más reciente del
// proveedor en D1 (ml_pub_feeds/ml_pub_stock), el mismo que usa la publicación.
//
//  - Un ISBN ausente o sin stock se pausa recién cuando la ausencia persiste
//    durante el período de gracia entre snapshots. Un snapshot vencido, ausente
//    o sospechosamente incompleto nunca pausa nada.
//  - Un ISBN que vuelve con stock se reactiva (modo pause_and_reactivate) sólo si
//    la pausa fue de esta sincronización o por agotamiento (cantidad 0).
//  - Nunca se cierra una publicación. Sólo status paused/active y cantidad 1.
//  - Idempotente: se lee el estado real en /items/bulk antes de cada PUT y se
//    registra lo aplicado. Un lock en D1 evita corridas superpuestas.
import {SELLER_ID,PublicationError,hasSupplierStock,stockIsFresh,safeCode} from './publication-policy.js';
import {createPublicationMeli,MercadoLibreError} from './publication-meli.js';

export const STOCK_SYNC_SCHEMA=[
 `CREATE TABLE IF NOT EXISTS ml_pub_stock_sync (seller_id TEXT NOT NULL,isbn TEXT NOT NULL,item_id TEXT NOT NULL,desired_status TEXT,applied_status TEXT,missing_since INTEGER NOT NULL DEFAULT 0,in_stock_at INTEGER NOT NULL DEFAULT 0,feed_id TEXT,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,last_error TEXT,updated_at INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(seller_id,isbn))`,
 `CREATE TABLE IF NOT EXISTS ml_pub_locks (name TEXT PRIMARY KEY,token TEXT,until INTEGER NOT NULL DEFAULT 0)`,
];
export const STOCK_SYNC_MODES=['disabled','report','pause_only','pause_and_reactivate'];
const LOCK_MS=240000,MIN_ROWS_FOR_GUARD=20,TRANSIENT_BACKOFF_MS=300000,LONG_BACKOFF_MS=86400000;
const ITEM_FIELDS='id,seller_id,status,available_quantity,seller_custom_field';

export function stockSyncSettings(env){
 const mode=String(env.ML_STOCK_SYNC_MODE??'disabled');
 if(!STOCK_SYNC_MODES.includes(mode))throw new PublicationError('invalid_stock_sync_mode',503);
 const number=(key,fallback,min,max)=>{const value=env[key]===undefined||env[key]===''?fallback:Number(env[key]);if(!Number.isFinite(value)||value<min||value>max)throw new PublicationError('invalid_stock_sync_setting',503);return value;};
 return {mode,graceHours:number('ML_STOCK_SYNC_GRACE_HOURS',20,0,240),maxMissingPct:number('ML_STOCK_SYNC_MAX_MISSING_PCT',30,1,100),batch:number('ML_STOCK_SYNC_BATCH',60,1,500)};
}
export function createStockSync({api=createPublicationMeli(),now=Date.now}={}){
 function database(env){
  if(String(env.USER_ID)!==SELLER_ID)throw new PublicationError('seller_configuration_mismatch',503);
  const db=env.ORDERS_DB;if(!db||typeof db.prepare!=='function')throw new PublicationError('database_not_configured',503);
  return {db,stmt:(sql,...args)=>db.prepare(sql).bind(...args)};
 }
 async function sync(env){
  const settings=stockSyncSettings(env);
  if(settings.mode==='disabled')return {state:'disabled'};
  const {db,stmt}=database(env);
  await db.batch(STOCK_SYNC_SCHEMA.map(sql=>db.prepare(sql)));
  const token=crypto.randomUUID(),startedAt=now();
  const locked=await stmt("INSERT INTO ml_pub_locks(name,token,until) VALUES('stock_sync',?,?) ON CONFLICT(name) DO UPDATE SET token=excluded.token,until=excluded.until WHERE ml_pub_locks.until<? RETURNING name",token,startedAt+LOCK_MS,startedAt).first();
  if(!locked)return {state:'busy'};
  try{
   let feed;
   try{feed=await stmt("SELECT * FROM ml_pub_feeds WHERE state='ready' ORDER BY source_date DESC LIMIT 1").first();}
   catch(error){if(/no such table/i.test(String(error?.message)))return {state:'not_initialized'};throw error;}
   if(!feed||!stockIsFresh(feed.source_date,startedAt))return {state:'feed_stale',feed_id:feed?.id??null};
   const feedTime=Date.parse(feed.source_date);
   const rows=(await stmt("SELECT r.isbn,r.item_id,s.data_json FROM ml_pub_receipts r LEFT JOIN ml_pub_stock s ON s.feed_id=? AND s.isbn=r.isbn WHERE r.seller_id=? AND r.state='published' AND r.item_id IS NOT NULL ORDER BY r.isbn",feed.id,SELLER_ID).all()).results;
   if(!rows.length)return {state:'nothing_published',feed_id:feed.id};
   const previous=new Map((await stmt('SELECT * FROM ml_pub_stock_sync WHERE seller_id=?',SELLER_ID).all()).results.map(r=>[r.isbn,r]));
   const inStock=new Set(rows.filter(r=>{if(!r.data_json)return false;try{return hasSupplierStock(JSON.parse(r.data_json).stock);}catch{return false;}}).map(r=>r.isbn));
   const missing=rows.length-inStock.size;
   // Gracia ante snapshot incompleto: una caída masiva no pausa nada hasta revisarla.
   const suspicious=rows.length>=MIN_ROWS_FOR_GUARD&&missing*100>rows.length*settings.maxMissingPct;
   const graceMs=settings.graceHours*3600000,updates=[];
   for(const r of rows){
    const prev=previous.get(r.isbn);
    if(inStock.has(r.isbn)){updates.push({isbn:r.isbn,item_id:r.item_id,desired:'active',missing_since:0,in_stock_at:feedTime});continue;}
    if(suspicious)continue;
    const since=prev?.missing_since||feedTime;
    updates.push({isbn:r.isbn,item_id:r.item_id,desired:feedTime-since>=graceMs?'paused':(prev?.desired_status??null),missing_since:since,in_stock_at:prev?.in_stock_at??0});
   }
   for(let i=0;i<updates.length;i+=400){
    await stmt(`INSERT INTO ml_pub_stock_sync(seller_id,isbn,item_id,desired_status,missing_since,in_stock_at,feed_id,updated_at) SELECT ?,json_extract(value,'$.isbn'),json_extract(value,'$.item_id'),json_extract(value,'$.desired'),json_extract(value,'$.missing_since'),json_extract(value,'$.in_stock_at'),?,? FROM json_each(?) WHERE true ON CONFLICT(seller_id,isbn) DO UPDATE SET item_id=excluded.item_id,desired_status=excluded.desired_status,missing_since=excluded.missing_since,in_stock_at=excluded.in_stock_at,feed_id=excluded.feed_id,updated_at=excluded.updated_at`,SELLER_ID,feed.id,startedAt,JSON.stringify(updates.slice(i,i+400))).run();
   }
   const summary={state:'synced',mode:settings.mode,feed_id:feed.id,published:rows.length,missing,suspicious_feed:suspicious,paused:0,activated:0,unchanged:0,skipped:0,errors:0};
   if(settings.mode==='report')return {...summary,state:'reported'};
   const wanted=settings.mode==='pause_only'?['paused']:['paused','active'];
   const due=(await stmt(`SELECT * FROM ml_pub_stock_sync WHERE seller_id=? AND desired_status IN (${wanted.map(()=>'?').join(',')}) AND (applied_status IS NULL OR applied_status<>desired_status) AND next_at<=? ORDER BY updated_at,isbn LIMIT ?`,SELLER_ID,...wanted,startedAt,settings.batch).all()).results;
   const applied=(row,status)=>stmt('UPDATE ml_pub_stock_sync SET applied_status=?,attempts=0,next_at=0,last_error=NULL,updated_at=? WHERE seller_id=? AND isbn=?',status,now(),SELLER_ID,row.isbn).run();
   const failed=(row,code,backoffMs)=>stmt('UPDATE ml_pub_stock_sync SET attempts=attempts+1,next_at=?,last_error=?,updated_at=? WHERE seller_id=? AND isbn=?',now()+Math.min(LONG_BACKOFF_MS,backoffMs*2**Math.min(8,row.attempts)),code,now(),SELLER_ID,row.isbn).run();
   const deferAll=async(group,error)=>{for(const row of group)await failed(row,safeCode(error),Math.max(TRANSIENT_BACKOFF_MS,(error.retryAfter||0)*1000));summary.errors+=group.length;};
   outer:for(let i=0;i<due.length;i+=20){
    const group=due.slice(i,i+20);
    let entries;
    try{entries=await api.call(env,'/items/bulk?ids='+group.map(r=>r.item_id).join(',')+'&attributes='+ITEM_FIELDS);}
    catch(error){await deferAll(group,error);if(error.status===429){summary.state='backoff';break;}continue;}
    const bodies=new Map();
    if(Array.isArray(entries))for(const entry of entries){if((entry.status_code??entry.code)===200&&entry.body&&typeof entry.body==='object')bodies.set(entry.body.id,entry.body);}
    for(const row of group){
     const item=bodies.get(row.item_id);
     if(!item){await failed(row,'item_unavailable',TRANSIENT_BACKOFF_MS);summary.errors++;continue;}
     // Never touch an item that is not ours by SKU identity.
     if(String(item.seller_id)!==SELLER_ID||item.seller_custom_field!==`AMADO-AR-${row.isbn}`){await failed(row,'item_identity_mismatch',LONG_BACKOFF_MS);summary.skipped++;continue;}
     if(!['active','paused'].includes(item.status)){await failed(row,`item_status_${/^[a-z_]{1,30}$/.test(String(item.status))?item.status:'unknown'}`,LONG_BACKOFF_MS);summary.skipped++;continue;}
     const quantity=Number(item.available_quantity);
     if(item.status===row.desired_status&&(row.desired_status==='paused'||quantity>0)){await applied(row,item.status);summary.unchanged++;continue;}
     // Reactivate only pauses made here or by sell-out; a manual pause stays manual.
     if(row.desired_status==='active'&&row.applied_status!=='paused'&&!(item.status==='paused'&&quantity===0)&&item.status==='paused'){await failed(row,'paused_externally',LONG_BACKOFF_MS);summary.skipped++;continue;}
     const body=row.desired_status==='paused'?{status:'paused'}:{status:'active',available_quantity:1};
     try{await api.call(env,`/items/${row.item_id}`,{method:'PUT',body});}
     catch(error){
      if(error.status===429){await deferAll([row],error);summary.state='backoff';break outer;}
      await failed(row,safeCode(error),error instanceof MercadoLibreError&&error.status>=500?TRANSIENT_BACKOFF_MS:3600000);summary.errors++;continue;
     }
     await applied(row,row.desired_status);summary[row.desired_status==='paused'?'paused':'activated']++;
    }
   }
   return summary;
  }finally{await stmt("UPDATE ml_pub_locks SET until=0,token=NULL WHERE name='stock_sync' AND token=?",token).run().catch(()=>{});}
 }
 async function status(env){
  const settings=stockSyncSettings(env),{db,stmt}=database(env);
  await db.batch(STOCK_SYNC_SCHEMA.map(sql=>db.prepare(sql)));
  const counts=(await stmt('SELECT desired_status,applied_status,COUNT(*) n FROM ml_pub_stock_sync WHERE seller_id=? GROUP BY desired_status,applied_status ORDER BY n DESC',SELLER_ID).all()).results;
  const errors=(await stmt('SELECT last_error,COUNT(*) n FROM ml_pub_stock_sync WHERE seller_id=? AND last_error IS NOT NULL GROUP BY last_error ORDER BY n DESC LIMIT 20',SELLER_ID).all()).results;
  const lock=await stmt("SELECT until FROM ml_pub_locks WHERE name='stock_sync'").first();
  return {mode:settings.mode,grace_hours:settings.graceHours,max_missing_pct:settings.maxMissingPct,counts,errors,running:Boolean(lock&&lock.until>now())};
 }
 return {sync,status};
}
export const publicationStockSync=createStockSync();
