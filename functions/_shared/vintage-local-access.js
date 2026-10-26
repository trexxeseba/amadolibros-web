import {VintageBulkStore,BULK_RUN,PILOT_RUN,VINTAGE_DAILY_CAP} from './meli-vintage-bulk.js';
import {vintageTokens,VINTAGE_SELLER_ID} from './meli-vintage-token.js';
import {PublicationError,canonicalIsbn,sha256,stockIsFresh,policyHash} from '../../worker-sync/publication-policy.js';
import {vintagePolicy} from '../../worker-sync/vintage-pricing.js';
const fail=(code,status=409)=>{throw new PublicationError(code,status);};
const SCHEMA="CREATE TABLE IF NOT EXISTS ml_vintage_local_access (id INTEGER PRIMARY KEY CHECK(id=1),key_hash TEXT NOT NULL,expires_at INTEGER NOT NULL,enabled INTEGER NOT NULL,last_at INTEGER NOT NULL DEFAULT 0)";
export function createLocalAccess({now=Date.now,tokens=vintageTokens}={}){
 const store=env=>new VintageBulkStore(env.ORDERS_DB,{sellerId:VINTAGE_SELLER_ID});
 async function grant(env){
  const s=store(env);await s.initialize();await env.ORDERS_DB.prepare(SCHEMA).run();
  const run=await s.run(BULK_RUN),pilot=await s.run(PILOT_RUN);
  if(!run||run.approved_hash!==run.policy_hash||pilot?.state!=='complete')fail('approved_campaign_required');
  const verified=(await s.stmt('SELECT result_json FROM ml_pub_verifications WHERE run_id=?',PILOT_RUN).all()).results;
  if(verified.length!==5||verified.some(v=>JSON.parse(v.result_json).ok!==true))fail('pilot_not_verified');
  const feed=await s.feed(run.feed_id),policy=vintagePolicy(JSON.parse(run.policy_json));
  if(!stockIsFresh(feed?.source_date,now()))fail('supplier_stock_stale');
  if(await policyHash(policy)!==run.policy_hash)fail('apply_minimum_1600_first');
  // Pause first; an existing in-flight lease must finish before local handoff.
  await s.stmt("UPDATE ml_pub_runs SET state='paused',updated_at=? WHERE id=?",now(),BULK_RUN).run();
  if((await s.run(BULK_RUN)).lease_until>now())fail('run_busy');
  const key=[...crypto.getRandomValues(new Uint8Array(32))].map(x=>x.toString(16).padStart(2,'0')).join('');
  const expires=Date.parse(feed.source_date)+86400000;
  await env.ORDERS_DB.prepare('INSERT INTO ml_vintage_local_access VALUES(1,?,?,1,0) ON CONFLICT(id) DO UPDATE SET key_hash=excluded.key_hash,expires_at=excluded.expires_at,enabled=1,last_at=0').bind(await sha256(key),expires).run();
  const source=await env.ORDERS_DB.prepare('SELECT source_sha256 FROM sbs_supplier_feeds WHERE id=?').bind(feed.id).first();
  const receipts=(await s.stmt('SELECT seller_id,isbn,state,item_id,run_id,created_at,updated_at FROM ml_pub_receipts WHERE seller_id=?',VINTAGE_SELLER_ID).all()).results;
  const inventory=(await s.stmt('SELECT item_id,isbn,title_key,status FROM ml_pub_index WHERE run_id=?',BULK_RUN).all()).results;
  const identifiers=(await env.ORDERS_DB.prepare('SELECT isbn,item_id FROM ml_vintage_bulk_identifiers WHERE run_id=?').bind(BULK_RUN).all()).results;
  // Cambios de política aprobados en el servidor (hash anterior -> nuevo): la PC sólo acepta
  // una política distinta de la suya si llega por esta cadena.
  const amendments=(await env.ORDERS_DB.prepare('SELECT old_hash,new_hash,created_at FROM ml_vintage_bulk_policy_amendments WHERE run_id=? ORDER BY created_at').bind(BULK_RUN).all()).results;
  return {version:1,endpoint:'https://www.amadolibros.com/operations/vintage-local',key,expires_at:expires,seller_id:VINTAGE_SELLER_ID,app_id:'4741021817925208',run_id:BULK_RUN,policy,policy_hash:run.policy_hash,feed_id:feed.id,source_date:feed.source_date,source_sha256:source?.source_sha256,receipts,inventory,identifiers,amendments,inventory_checkpoint:JSON.parse(run.index_json)};
 }
 async function command(env,key,action,args={}){
  if(typeof key!=='string'||!/^[a-f0-9]{64}$/.test(key))fail('invalid_local_access',401);
  const table=await env.ORDERS_DB.prepare("SELECT name FROM sqlite_master WHERE name='ml_vintage_local_access'").first();
  const access=table?await env.ORDERS_DB.prepare('SELECT * FROM ml_vintage_local_access WHERE id=1').first():null;
  if(!access||!access.enabled||access.expires_at<=now()||await sha256(key)!==access.key_hash)fail('local_access_expired_or_revoked',401);
  const s=store(env),run=await s.run(BULK_RUN);
  if(!run||run.state!=='paused'||run.approved_hash!==run.policy_hash)fail('local_campaign_not_exclusive');
  await env.ORDERS_DB.prepare('UPDATE ml_vintage_local_access SET last_at=? WHERE id=1').bind(now()).run();
  if(action==='token')return {access_token:await tokens.getAccessToken(env),expires_at:Math.min(access.expires_at,now()+300000),seller_id:VINTAGE_SELLER_ID};
  if(action==='invalidate'){
   if(typeof args.access_token!=='string'||args.access_token.length>512)fail('invalid_token',400);
   await tokens.invalidateAccessToken(env,args.access_token);return {invalidated:true};
  }
  if(action==='reserve'){
   const isbn=canonicalIsbn(args.isbn),feed=await s.feed(run.feed_id),row=await s.stock(run.feed_id,isbn);
   if(args.policy_hash!==run.policy_hash)fail('policy_changed');
   if(!stockIsFresh(feed?.source_date,now())||!row||!/^\+?\d+$/.test(String(row.stock))||Number(row.stock)<=0)fail('supplier_stock_stale_or_missing');
   const job=await s.stmt('SELECT state FROM ml_pub_jobs WHERE run_id=? AND isbn=?',BULK_RUN,isbn).first();
   if(!job)fail('isbn_outside_campaign');
   const reserved=await s.reserve(VINTAGE_SELLER_ID,isbn,BULK_RUN,now(),VINTAGE_DAILY_CAP);
   return {reserved:Boolean(reserved),receipt:reserved??await s.receipt(VINTAGE_SELLER_ID,isbn)};
  }
  if(action==='report'){
   const isbn=canonicalIsbn(args.isbn),receipt=await s.receipt(VINTAGE_SELLER_ID,isbn);
   if(receipt?.run_id!==BULK_RUN||!['published','uncertain'].includes(args.state)||args.state==='published'&&!/^MLU\d+$/.test(args.item_id??''))fail('invalid_local_receipt');
   if(receipt.state==='published'&&(args.state!=='published'||args.item_id!==receipt.item_id))fail('published_receipt_immutable');
   await env.ORDERS_DB.batch([
    s.stmt('UPDATE ml_pub_receipts SET state=?,item_id=COALESCE(?,item_id),updated_at=? WHERE seller_id=? AND isbn=? AND run_id=?',args.state,args.item_id??null,now(),VINTAGE_SELLER_ID,isbn,BULK_RUN),
    s.stmt('UPDATE ml_pub_jobs SET state=?,item_id=COALESCE(?,item_id),error_code=? WHERE run_id=? AND isbn=?',args.state,args.item_id??null,args.state==='uncertain'?'local_create_uncertain':null,BULK_RUN,isbn),
   ]);return {recorded:true};
  }
  if(action==='status')return {seller_id:VINTAGE_SELLER_ID,published_total:5+await s.publishedCount(BULK_RUN),daily_created:await s.dayCreated(now()),daily_cap:VINTAGE_DAILY_CAP,expires_at:access.expires_at};
  fail('invalid_local_action',400);
 }
 return {grant,command};
}
