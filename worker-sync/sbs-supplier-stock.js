// Supplier ingestion only. No Mercado Libre client, publication queue or shared
// ml_pub_feeds/ml_pub_stock writes belong in this module.
import {PublicationError, normalizeSupplierRow, stockIsFresh} from './publication-policy.js';

export const SBS_SCHEMA = [
 `CREATE TABLE IF NOT EXISTS sbs_supplier_feeds (id TEXT PRIMARY KEY,source_date TEXT NOT NULL,source_sha256 TEXT NOT NULL UNIQUE,state TEXT NOT NULL CHECK(state IN ('importing','ready')),expected_rows INTEGER NOT NULL,created_at INTEGER NOT NULL,checked_at INTEGER NOT NULL)`,
 `CREATE TABLE IF NOT EXISTS sbs_supplier_stock (feed_id TEXT NOT NULL,isbn TEXT NOT NULL,data_json TEXT NOT NULL,PRIMARY KEY(feed_id,isbn))`,
 `CREATE TABLE IF NOT EXISTS sbs_supplier_events (id INTEGER PRIMARY KEY AUTOINCREMENT,checked_at INTEGER NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL,source_date TEXT,error_code TEXT,feed_id TEXT)`,
];
export async function readSbsDiagnostics(db){
 if(!await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sbs_supplier_events'").first())return {automatic:null,manual:null};
 const latest=kind=>db.prepare('SELECT checked_at,kind,state,source_date,error_code,feed_id FROM sbs_supplier_events WHERE kind=? ORDER BY id DESC LIMIT 1').bind(kind).first();
 return {automatic:await latest('automatic'),manual:await latest('manual')};
}
export async function recordSbsAttempt(db,{kind,state,source_date=null,error_code=null,feed_id=null},at=Date.now()){
 if(!['automatic','manual'].includes(kind)||!['success','failed'].includes(state)||source_date!==null&&!Number.isFinite(Date.parse(source_date))||error_code!==null&&!/^[a-z_]{1,80}$/.test(error_code)||feed_id!==null&&!/^[a-f0-9-]{36}$/.test(feed_id))throw new PublicationError('invalid_supplier_event');
 await initializeSbsStock(db);
 await db.prepare('INSERT INTO sbs_supplier_events(checked_at,kind,state,source_date,error_code,feed_id) VALUES(?,?,?,?,?,?)').bind(at,kind,state,source_date,error_code,feed_id).run();
 // Keep only recent diagnostics; never delete stock snapshots referenced by runs.
 await db.prepare('DELETE FROM sbs_supplier_events WHERE id NOT IN (SELECT id FROM sbs_supplier_events ORDER BY id DESC LIMIT 100)').run();
}
export async function initializeSbsStock(db){
 if(!db)throw new PublicationError('database_not_configured',503);
 await db.batch(SBS_SCHEMA.map(sql=>db.prepare(sql)));
}
export function createSbsStock({now=Date.now}={}){
 return async function command(env,action,args={}){
  const db=env.ORDERS_DB;
  if(!['status','begin','import','commit','record_attempt'].includes(action))throw new PublicationError('invalid_supplier_action');
  if(!args||typeof args!=='object'||Array.isArray(args))throw new PublicationError('invalid_supplier_arguments');
  const fields={status:[],begin:['feed_id','source_date','source_sha256','expected_rows'],import:['feed_id','rows'],commit:['feed_id'],record_attempt:['kind','state','source_date','error_code','feed_id']}[action];
  if(Object.keys(args).some(k=>!fields.includes(k)))throw new PublicationError('invalid_supplier_arguments');
  await initializeSbsStock(db);
  const stmt=(sql,...values)=>db.prepare(sql).bind(...values);
  if(action==='record_attempt'){await recordSbsAttempt(db,args,now());return {state:'recorded'};}
  if(action==='status'){
   const latest=await stmt("SELECT id,source_date,source_sha256,expected_rows,checked_at FROM sbs_supplier_feeds WHERE state='ready' ORDER BY source_date DESC,created_at DESC LIMIT 1").first();
   return {state:latest?'ready':'no_stock',fresh:stockIsFresh(latest?.source_date,now()),latest};
  }
  if(typeof args.feed_id!=='string'||!/^[a-f0-9-]{36}$/.test(args.feed_id))throw new PublicationError('invalid_feed_id');
  if(action==='begin'){
   if(!stockIsFresh(args.source_date,now()))throw new PublicationError('supplier_stock_stale_or_future',409);
   if(typeof args.source_sha256!=='string'||!/^[a-f0-9]{64}$/.test(args.source_sha256)||!Number.isInteger(args.expected_rows)||args.expected_rows<1||args.expected_rows>250000)throw new PublicationError('invalid_supplier_manifest');
   const date=new Date(args.source_date).toISOString();
   const latest=await stmt("SELECT source_date FROM sbs_supplier_feeds WHERE state='ready' ORDER BY source_date DESC LIMIT 1").first();
   if(latest&&date<latest.source_date)throw new PublicationError('supplier_stock_older_than_current',409);
   await stmt("INSERT OR IGNORE INTO sbs_supplier_feeds(id,source_date,source_sha256,state,expected_rows,created_at,checked_at) VALUES(?,?,?,'importing',?,?,?)",args.feed_id,date,args.source_sha256,args.expected_rows,now(),now()).run();
   const feed=await stmt('SELECT * FROM sbs_supplier_feeds WHERE id=?',args.feed_id).first();
   if(!feed||feed.source_sha256!==args.source_sha256||feed.source_date!==date||feed.expected_rows!==args.expected_rows)throw new PublicationError('supplier_manifest_changed',409);
   await stmt('UPDATE sbs_supplier_feeds SET checked_at=? WHERE id=?',now(),feed.id).run();
   return {state:feed.state,feed_id:feed.id,rows:feed.expected_rows};
  }
  const feed=await stmt('SELECT * FROM sbs_supplier_feeds WHERE id=?',args.feed_id).first();
  if(!feed)throw new PublicationError('supplier_feed_not_found',404);
  if(!stockIsFresh(feed.source_date,now()))throw new PublicationError('supplier_stock_stale_or_future',409);
  if(action==='import'){
   if(feed.state!=='importing')throw new PublicationError('supplier_feed_immutable',409);
   if(!Array.isArray(args.rows)||args.rows.length<1||args.rows.length>200)throw new PublicationError('invalid_supplier_batch');
   const rows=args.rows.map(normalizeSupplierRow);
   if(new Set(rows.map(r=>r.isbn)).size!==rows.length)throw new PublicationError('duplicate_supplier_isbn');
   await stmt("INSERT INTO sbs_supplier_stock(feed_id,isbn,data_json) SELECT ?,json_extract(value,'$.isbn'),value FROM json_each(?) WHERE EXISTS(SELECT 1 FROM sbs_supplier_feeds WHERE id=? AND state='importing') ON CONFLICT(feed_id,isbn) DO NOTHING",feed.id,JSON.stringify(rows),feed.id).run();
   // Retries may repeat a batch; a different payload cannot replace imported ISBNs.
   const mismatches=await stmt("SELECT COUNT(*) n FROM json_each(?) incoming LEFT JOIN sbs_supplier_stock s ON s.feed_id=? AND s.isbn=json_extract(incoming.value,'$.isbn') WHERE s.data_json IS NULL OR s.data_json<>incoming.value",JSON.stringify(rows),feed.id).first();
   if(mismatches.n)throw new PublicationError('supplier_batch_changed',409);
   return {state:'importing',feed_id:feed.id};
  }
  const count=await stmt('SELECT COUNT(*) n FROM sbs_supplier_stock WHERE feed_id=?',feed.id).first();
  if(count.n!==feed.expected_rows)throw new PublicationError('supplier_feed_count_mismatch',409);
  const committed=await stmt("UPDATE sbs_supplier_feeds SET state='ready',checked_at=? WHERE id=? AND expected_rows=(SELECT COUNT(*) FROM sbs_supplier_stock WHERE feed_id=?) RETURNING id",now(),feed.id,feed.id).first();
  if(!committed)throw new PublicationError('supplier_feed_count_mismatch',409);
  return {state:'ready',feed_id:feed.id,source_date:feed.source_date,rows:count.n};
 };
}
export const sbsStockCommand=createSbsStock();
