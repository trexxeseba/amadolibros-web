import { PublicationError, normalizedTitle } from './publication-policy.js';

export const PUBLICATION_SCHEMA = [
 `CREATE TABLE IF NOT EXISTS ml_pub_feeds (id TEXT PRIMARY KEY,source_date TEXT NOT NULL,state TEXT NOT NULL,expected_rows INTEGER NOT NULL,created_at INTEGER NOT NULL)`,
 `CREATE TABLE IF NOT EXISTS ml_pub_stock (feed_id TEXT NOT NULL,isbn TEXT NOT NULL,data_json TEXT NOT NULL,PRIMARY KEY(feed_id,isbn))`,
 `CREATE TABLE IF NOT EXISTS ml_pub_runs (id TEXT PRIMARY KEY,feed_id TEXT NOT NULL,policy_json TEXT NOT NULL,policy_hash TEXT NOT NULL,state TEXT NOT NULL,approved_hash TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,lease_id TEXT,lease_until INTEGER NOT NULL DEFAULT 0,backoff_until INTEGER NOT NULL DEFAULT 0,index_json TEXT NOT NULL,daily_cap INTEGER NOT NULL,preflight_limit INTEGER NOT NULL)`,
 `CREATE TABLE IF NOT EXISTS ml_pub_jobs (run_id TEXT NOT NULL,isbn TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,payload_json TEXT,item_id TEXT,error_code TEXT,PRIMARY KEY(run_id,isbn))`,
 `CREATE INDEX IF NOT EXISTS ml_pub_jobs_due ON ml_pub_jobs(run_id,state,next_at)`,
 `CREATE TABLE IF NOT EXISTS ml_pub_index (run_id TEXT NOT NULL,item_id TEXT NOT NULL,isbn TEXT,title_key TEXT NOT NULL,status TEXT NOT NULL,PRIMARY KEY(run_id,item_id))`,
 `CREATE INDEX IF NOT EXISTS ml_pub_index_isbn ON ml_pub_index(run_id,isbn)`,
 `CREATE INDEX IF NOT EXISTS ml_pub_index_title ON ml_pub_index(run_id,title_key)`,
 `CREATE TABLE IF NOT EXISTS ml_pub_receipts (seller_id TEXT NOT NULL,isbn TEXT NOT NULL,state TEXT NOT NULL,item_id TEXT,run_id TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(seller_id,isbn))`,
 `CREATE INDEX IF NOT EXISTS ml_pub_receipts_day ON ml_pub_receipts(state,created_at)`,
 `CREATE TABLE IF NOT EXISTS ml_pub_nonces (id TEXT PRIMARY KEY,expires_at INTEGER NOT NULL)`,
 `CREATE TABLE IF NOT EXISTS ml_pub_run_targets (run_id TEXT PRIMARY KEY,target_published INTEGER NOT NULL,created_at INTEGER NOT NULL)`,
];

export class PublicationStore {
 constructor(db) { if(!db)throw new PublicationError('database_not_configured',503);this.db=db; }
 stmt(sql,...args){return this.db.prepare(sql).bind(...args);}
 async initialize(){await this.db.batch(PUBLICATION_SCHEMA.map(sql=>this.db.prepare(sql)));}
 async feed(id){return this.stmt('SELECT * FROM ml_pub_feeds WHERE id=?',id).first();}
 async beginFeed(id,date,expected,now){await this.stmt("INSERT INTO ml_pub_feeds(id,source_date,state,expected_rows,created_at) VALUES(?,?,'importing',?,?)",id,date,expected,now).run();}
 async importRows(id,rows){
  const feed=await this.feed(id);if(feed?.state!=='importing')throw new PublicationError('feed_not_importing',409);
  // One JSON parameter avoids D1's bound-parameter limit for a batch of books.
  const result=await this.stmt(`INSERT INTO ml_pub_stock(feed_id,isbn,data_json) SELECT ?,json_extract(value,'$.isbn'),value FROM json_each(?) WHERE EXISTS(SELECT 1 FROM ml_pub_feeds WHERE id=? AND state='importing') ON CONFLICT(feed_id,isbn) DO UPDATE SET data_json=excluded.data_json`,id,JSON.stringify(rows),id).run();
  if(result.meta.changes!==rows.length)throw new PublicationError('feed_not_importing',409);
 }
 async commitFeed(id){
  const result=await this.stmt(`UPDATE ml_pub_feeds SET state='ready' WHERE id=? AND state='importing' AND expected_rows=(SELECT COUNT(*) FROM ml_pub_stock WHERE feed_id=?) RETURNING *`,id,id).first();
  if(!result)throw new PublicationError('feed_count_mismatch',409);return result;
 }
 async createRun(run){
  const statements=[
   this.stmt(`INSERT INTO ml_pub_runs(id,feed_id,policy_json,policy_hash,state,created_at,updated_at,index_json,daily_cap,preflight_limit) VALUES(?,?,?,?,'preflight',?,?,?,?,?)`,run.id,run.feedId,JSON.stringify(run.policy),run.policyHash,run.now,run.now,JSON.stringify({status:'active',scroll:null,pending:[],done:false,seen:0}),run.dailyCap,run.preflightLimit),
   this.stmt(`INSERT INTO ml_pub_jobs(run_id,isbn,state) SELECT ?,isbn,'pending' FROM ml_pub_stock WHERE feed_id=?`,run.id,run.feedId),
  ];
  if(Number.isInteger(run.targetPublished))statements.push(this.stmt('INSERT INTO ml_pub_run_targets(run_id,target_published,created_at) VALUES(?,?,?)',run.id,run.targetPublished,run.now));
  await this.db.batch(statements);
 }
 // Catalog preflight clone: a new run over the same snapshot that holds only the
 // ISBNs the source run left in catalog_required_needs_review. The source run,
 // its policy and its jobs are never written; the ML index is copied as-is.
 async catalogReviewCandidates(id,limit){return (await this.stmt("SELECT isbn FROM ml_pub_jobs WHERE run_id=? AND state='review' AND error_code='catalog_required_needs_review' ORDER BY isbn LIMIT ?",id,limit).all()).results.map(r=>r.isbn);}
 async cloneRun(run,isbns){
  await this.db.batch([
   this.stmt(`INSERT INTO ml_pub_runs(id,feed_id,policy_json,policy_hash,state,created_at,updated_at,index_json,daily_cap,preflight_limit) VALUES(?,?,?,?,'preflight',?,?,?,?,?)`,run.id,run.feedId,JSON.stringify(run.policy),run.policyHash,run.now,run.now,run.indexJson,run.dailyCap,run.preflightLimit),
   this.stmt(`INSERT INTO ml_pub_jobs(run_id,isbn,state) SELECT ?,value,'pending' FROM json_each(?)`,run.id,JSON.stringify(isbns)),
   this.stmt(`INSERT INTO ml_pub_index(run_id,item_id,isbn,title_key,status) SELECT ?,item_id,isbn,title_key,status FROM ml_pub_index WHERE run_id=?`,run.id,run.sourceId),
  ]);
 }
 async jobs(id){return (await this.stmt('SELECT isbn,state,error_code,item_id,attempts,payload_json FROM ml_pub_jobs WHERE run_id=? ORDER BY isbn',id).all()).results.map(x=>({...x,payload:x.payload_json?JSON.parse(x.payload_json):null,payload_json:undefined}));}
 async run(id){return this.stmt('SELECT * FROM ml_pub_runs WHERE id=?',id).first();}
 async activeRun(){return this.stmt("SELECT * FROM ml_pub_runs WHERE state IN ('preflight','publishing') ORDER BY created_at LIMIT 1").first();}
 async lease(id,token,now){return this.stmt(`UPDATE ml_pub_runs SET lease_id=?,lease_until=?,updated_at=? WHERE id=? AND state IN ('preflight','publishing','complete_with_review') AND lease_until<? RETURNING *`,token,now+300_000,now,id,now).first();}
 // A finished run that still holds uncertain creates keeps being reconciled by the cron.
 async reconcilableRun(now){return this.stmt("SELECT r.* FROM ml_pub_runs r WHERE r.state='complete_with_review' AND EXISTS(SELECT 1 FROM ml_pub_jobs j WHERE j.run_id=r.id AND j.state='uncertain' AND j.next_at<=?) ORDER BY r.created_at LIMIT 1",now).first();}
 async finishReview(id,token,now){await this.stmt("UPDATE ml_pub_runs SET state='complete',updated_at=? WHERE id=? AND state='complete_with_review' AND lease_id=? AND lease_until>? AND NOT EXISTS(SELECT 1 FROM ml_pub_jobs WHERE run_id=? AND state IN ('pending','validated','retry','creating','uncertain','review'))",now,id,token,now,id).run();}
 async release(id,token){await this.stmt('UPDATE ml_pub_runs SET lease_until=0,lease_id=NULL WHERE id=? AND lease_id=?',id,token).run();}
 async ownsLease(id,token,now){return Boolean(await this.stmt('SELECT id FROM ml_pub_runs WHERE id=? AND lease_id=? AND lease_until>?',id,token,now).first());}
 async backoff(id,until,token){await this.stmt('UPDATE ml_pub_runs SET backoff_until=MAX(backoff_until,?) WHERE id=? AND lease_id=?',until,id,token).run();}
 async setRunState(id,state,leaseToken=null,now=Date.now()){await this.stmt("UPDATE ml_pub_runs SET state=?,updated_at=? WHERE id=? AND (? IS NULL OR (lease_id=? AND lease_until>? AND state IN ('preflight','publishing')))",state,now,id,leaseToken,leaseToken,now).run();}
 async attachFeed(id,feedId){
  const now=Date.now(),current=await this.run(id);if(!current||current.lease_until>now)throw new PublicationError('run_busy',409);
  const index=JSON.stringify({status:'active',scroll:null,pending:[],done:false,seen:0});
  const guard="EXISTS(SELECT 1 FROM ml_pub_runs WHERE id=? AND feed_id=? AND lease_until<?)";
  const results=await this.db.batch([
   this.stmt("UPDATE ml_pub_runs SET feed_id=?,index_json=?,state=CASE WHEN state IN ('paused','auth_error') THEN state WHEN approved_hash=policy_hash THEN 'publishing' ELSE 'preflight' END,updated_at=? WHERE id=? AND lease_until<? RETURNING id",feedId,index,now,id,now),
   this.stmt(`UPDATE ml_pub_jobs SET state='pending',payload_json=NULL,next_at=0 WHERE run_id=? AND state IN ('validated','retry','skipped_stock') AND ${guard}`,id,id,feedId,now),
   this.stmt(`DELETE FROM ml_pub_index WHERE run_id=? AND ${guard}`,id,id,feedId,now),
  ]);
  if(!results[0].results?.length)throw new PublicationError('run_busy',409);
 }
 async approve(id,hash){const run=await this.stmt("UPDATE ml_pub_runs SET approved_hash=?,state='publishing',updated_at=? WHERE id=? AND policy_hash=? AND state IN ('ready','paused','stock_stale') AND lease_until<? RETURNING *",hash,Date.now(),id,hash,Date.now()).first();if(!run)throw new PublicationError('run_not_ready_or_policy_changed',409);return run;}
 async saveIndex(id,index,items=[],leaseToken=null,now=Date.now()){
  const statements=[];
  const guard="(? IS NULL OR EXISTS(SELECT 1 FROM ml_pub_runs WHERE id=? AND lease_id=? AND lease_until>?))";
  if(items.length)statements.push(this.stmt(`INSERT INTO ml_pub_index(run_id,item_id,isbn,title_key,status) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.isbn'),json_extract(value,'$.titleKey'),json_extract(value,'$.status') FROM json_each(?) WHERE ${guard} ON CONFLICT(run_id,item_id) DO UPDATE SET isbn=excluded.isbn,title_key=excluded.title_key,status=excluded.status`,id,JSON.stringify(items),leaseToken,id,leaseToken,now));
  statements.push(this.stmt(`UPDATE ml_pub_runs SET index_json=json_set(?,'$.seen',(SELECT COUNT(*) FROM ml_pub_index WHERE run_id=?)),updated_at=? WHERE id=? AND ${guard} RETURNING index_json`,JSON.stringify(index),id,now,id,leaseToken,id,leaseToken,now));
  const results=await this.db.batch(statements);if(!results.at(-1).results?.length)throw new PublicationError('lease_lost',409);return JSON.parse(results.at(-1).results[0].index_json);
 }
 async existing(id,isbn,title){return this.stmt('SELECT item_id,isbn FROM ml_pub_index WHERE run_id=? AND (isbn=? OR (title_key<>\'\' AND title_key=?)) ORDER BY CASE WHEN isbn=? THEN 0 ELSE 1 END LIMIT 1',id,isbn,normalizedTitle(title),isbn).first();}
 async nextJob(id,now,publishing=true){return this.stmt("SELECT j.* FROM ml_pub_jobs j JOIN ml_pub_runs r ON r.id=j.run_id LEFT JOIN ml_pub_stock s ON s.feed_id=r.feed_id AND s.isbn=j.isbn WHERE j.run_id=? AND j.state IN ('pending','validated','retry') AND (?=1 OR j.state<>'validated') AND j.next_at<=? ORDER BY CASE j.state WHEN 'validated' THEN 0 ELSE 1 END,s.rowid,j.isbn LIMIT 1",id,publishing?1:0,now).first();}
 async stock(feedId,isbn){const r=await this.stmt('SELECT data_json FROM ml_pub_stock WHERE feed_id=? AND isbn=?',feedId,isbn).first();return r?JSON.parse(r.data_json):null;}
 async job(id,isbn,state,{payload,itemId,errorCode,nextAt=0,attempt=false,leaseToken=null,now=Date.now()}={}){const r=await this.stmt('UPDATE ml_pub_jobs SET state=?,payload_json=COALESCE(?,payload_json),item_id=COALESCE(?,item_id),error_code=?,next_at=?,attempts=attempts+? WHERE run_id=? AND isbn=? AND (? IS NULL OR EXISTS(SELECT 1 FROM ml_pub_runs WHERE id=? AND lease_id=? AND lease_until>?)) RETURNING isbn',state,payload?JSON.stringify(payload):null,itemId??null,errorCode??null,nextAt,attempt?1:0,id,isbn,leaseToken,id,leaseToken,now).first();if(!r)throw new PublicationError('lease_lost',409);}
 async receipt(seller,isbn){return this.stmt('SELECT * FROM ml_pub_receipts WHERE seller_id=? AND isbn=?',seller,isbn).first();}
 async reserve(seller,isbn,runId,now,cap,leaseToken=null){const day=new Date(now-3*3600000).toISOString().slice(0,10),start=Date.parse(day+'T03:00:00Z');return this.stmt("INSERT OR IGNORE INTO ml_pub_receipts(seller_id,isbn,state,run_id,created_at,updated_at) SELECT ?,?,'creating',?,?,? WHERE (SELECT COUNT(*) FROM ml_pub_receipts WHERE seller_id=? AND created_at>=?)<? AND (? IS NULL OR EXISTS(SELECT 1 FROM ml_pub_runs WHERE id=? AND lease_id=? AND lease_until>? AND state='publishing')) RETURNING *",seller,isbn,runId,now,now,seller,start,cap,leaseToken,runId,leaseToken,now).first();}
 async receiptState(seller,isbn,state,itemId=null){await this.stmt('UPDATE ml_pub_receipts SET state=?,item_id=COALESCE(?,item_id),updated_at=? WHERE seller_id=? AND isbn=?',state,itemId,Date.now(),seller,isbn).run();}
 async dayCreated(now){const date=new Date(now-3*3600000).toISOString().slice(0,10),start=Date.parse(date+'T03:00:00Z');return (await this.stmt('SELECT COUNT(*) n FROM ml_pub_receipts WHERE created_at>=?',start).first()).n;}
 async unfinished(id,publishing=true){return (await this.stmt("SELECT COUNT(*) n FROM ml_pub_jobs WHERE run_id=? AND state IN ('pending','validated','retry') AND (?=1 OR state<>'validated')",id,publishing?1:0).first()).n;}
 async interrupted(id,now=Date.now()){await this.stmt("UPDATE ml_pub_jobs SET state='uncertain',error_code='interrupted_create' WHERE run_id=? AND state='creating'",id).run();return (await this.stmt("SELECT * FROM ml_pub_jobs WHERE run_id=? AND state='uncertain' AND next_at<=? ORDER BY next_at,isbn LIMIT 5",id,now).all()).results;}
 async counts(id){return (await this.stmt('SELECT state,COUNT(*) n FROM ml_pub_jobs WHERE run_id=? GROUP BY state',id).all()).results;}
 async publishedItems(id,offset=0,limit=100){
  return (await this.stmt("SELECT isbn,item_id FROM ml_pub_jobs WHERE run_id=? AND state='published' AND item_id IS NOT NULL ORDER BY isbn LIMIT ? OFFSET ?",id,limit,offset).all()).results;
 }
 async publishedCount(id){return (await this.stmt("SELECT COUNT(*) n FROM ml_pub_jobs WHERE run_id=? AND state='published' AND item_id IS NOT NULL",id).first()).n;}
 async target(id){try{return await this.stmt('SELECT target_published FROM ml_pub_run_targets WHERE run_id=?',id).first();}catch(error){if(/no such table/i.test(String(error?.message)))return null;throw error;}}
 async skipRemainingAtTarget(id,leaseToken,now){await this.stmt("UPDATE ml_pub_jobs SET state='skipped_target_reached',error_code=NULL,next_at=0 WHERE run_id=? AND state IN ('pending','validated','retry') AND EXISTS(SELECT 1 FROM ml_pub_runs WHERE id=? AND lease_id=? AND lease_until>?)",id,id,leaseToken,now).run();}
 async retryLegacyIdentityReviews(id,token,now){await this.stmt("UPDATE ml_pub_jobs SET state='pending',error_code=NULL,next_at=0 WHERE run_id=? AND state='review' AND error_code IN ('product_isbn_or_domain_mismatch','missing_product_metadata') AND EXISTS(SELECT 1 FROM ml_pub_runs WHERE id=? AND lease_id=? AND lease_until>?)",id,id,token,now).run();}
 async nonce(id,expires,now){await this.stmt('DELETE FROM ml_pub_nonces WHERE expires_at<?',now).run();try{await this.stmt('INSERT INTO ml_pub_nonces(id,expires_at) VALUES(?,?)',id,expires).run();}catch{throw new PublicationError('request_already_used',409);}}
 async preview(id){return (await this.stmt("SELECT isbn,state,payload_json,error_code FROM ml_pub_jobs WHERE run_id=? AND state IN ('validated','review','uncertain') ORDER BY CASE state WHEN 'validated' THEN 0 WHEN 'review' THEN 1 ELSE 2 END,isbn LIMIT 10",id).all()).results.map(x=>({...x,payload:x.payload_json?JSON.parse(x.payload_json):null,payload_json:undefined}));}
 async summary(id){const r=id?await this.run(id):(await this.activeRun()??await this.stmt('SELECT * FROM ml_pub_runs ORDER BY created_at DESC LIMIT 1').first());if(!r)return {state:'no_active_run'};const reviewReasons=(await this.stmt("SELECT error_code,COUNT(*) n FROM ml_pub_jobs WHERE run_id=? AND state='review' GROUP BY error_code ORDER BY n DESC,error_code LIMIT 20",r.id).all()).results,target=await this.target(r.id),published=await this.publishedCount(r.id);return {id:r.id,state:r.state,index:JSON.parse(r.index_json),policy_hash:r.policy_hash,approved:r.approved_hash===r.policy_hash,counts:await this.counts(r.id),review_reasons:reviewReasons,feed_id:r.feed_id,daily_cap:r.daily_cap,target_published:target?.target_published??null,target_remaining:target?Math.max(0,target.target_published-published):null};}
}
