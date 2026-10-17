import { PublicationStore } from '../../worker-sync/publication-store.js';
import { createPublicationService } from '../../worker-sync/publication-engine.js';
import { createPublicationMeli } from '../../worker-sync/publication-meli.js';
import { validPolicy, policyHash, stockIsFresh, sha256, PublicationError } from '../../worker-sync/publication-policy.js';
import { vintageTokens, VINTAGE_SELLER_ID } from './meli-vintage-token.js';
import { initializeSbsStock } from '../../worker-sync/sbs-supplier-stock.js';

export const PILOT_LIMIT=5;
const uuid=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value);
const error=(code,status=409)=>new PublicationError(code,status);
// Background/browser continuation can only lease preflight. A concurrent owner
// approval cannot turn a "validate only" request into a publishing tick.
class VintageStore extends PublicationStore {
 scoped(sql){
  // New supplier snapshots are private to Vintage. Old pilots can still read
  // their immutable shared snapshot without rewriting any Libros record.
  if(/^\s*(INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM)\s+ml_pub_(feeds|stock)\b/i.test(sql))throw error('supplier_snapshots_read_only');
  if(!this.hasSupplierStock)return super.scoped(sql);
  return super.scoped(sql)
   .replace(/\bml_pub_feeds\b/g,"(SELECT id,source_date,state,expected_rows,created_at FROM sbs_supplier_feeds UNION ALL SELECT id,source_date,state,expected_rows,created_at FROM ml_pub_feeds old WHERE NOT EXISTS(SELECT 1 FROM sbs_supplier_feeds fresh WHERE fresh.id=old.id))")
   .replace(/\bml_pub_stock\b/g,"(SELECT rowid,feed_id,isbn,data_json FROM sbs_supplier_stock UNION ALL SELECT rowid,feed_id,isbn,data_json FROM ml_pub_stock old WHERE NOT EXISTS(SELECT 1 FROM sbs_supplier_feeds fresh WHERE fresh.id=old.feed_id))");
 }
 async discoverSupplierStock(){this.hasSupplierStock=Boolean(await this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sbs_supplier_feeds'").first());}
 async feed(id){await this.discoverSupplierStock();return super.feed(id);}
 async initialize(){await initializeSbsStock(this.db);this.hasSupplierStock=true;await super.initialize();await this.stmt('CREATE TABLE IF NOT EXISTS ml_pub_payload_seals (run_id TEXT NOT NULL,isbn TEXT NOT NULL,policy_hash TEXT NOT NULL,payload_hash TEXT NOT NULL,sample_hash TEXT NOT NULL,PRIMARY KEY(run_id,isbn))').run();}
}
class PreflightStore extends VintageStore {
 async lease(id,token,now){return this.stmt("UPDATE ml_pub_runs SET lease_id=?,lease_until=?,updated_at=? WHERE id=? AND state='preflight' AND lease_until<? RETURNING *",token,now+300000,now,id,now).first();}
}
export function createVintagePilot({api=createPublicationMeli({sellerId:VINTAGE_SELLER_ID,tokenProvider:vintageTokens.getAccessToken,tokenInvalidator:vintageTokens.invalidateAccessToken}),now=Date.now}={}) {
 const store=env=>new VintageStore(env.ORDERS_DB,{sellerId:VINTAGE_SELLER_ID});
 const payloadHash=(run,isbn,payload)=>sha256(JSON.stringify({seller_id:VINTAGE_SELLER_ID,run_id:run.id,policy_hash:run.policy_hash,isbn,payload}));
 async function approvedPayloadGuard(env,run,job,payload){
  const s=store(env);
  const sealed=await s.stmt('SELECT p.payload_hash,p.policy_hash,j.payload_json FROM ml_pub_payload_seals p JOIN ml_pub_jobs j ON j.run_id=p.run_id AND j.isbn=p.isbn WHERE p.run_id=? AND p.isbn=?',run.id,job.isbn).first();
  if(!sealed||!payload||!sealed.payload_json||sealed.policy_hash!==run.policy_hash)throw error('approved_payload_missing');
  if(await payloadHash(run,job.isbn,payload)!==sealed.payload_hash||await payloadHash(run,job.isbn,JSON.parse(sealed.payload_json))!==sealed.payload_hash)throw error('approved_payload_changed');
 }
 const service=createPublicationService({sellerId:VINTAGE_SELLER_ID,api,storeFactory:store,now,approvedPayloadGuard});
 const preflightService=createPublicationService({sellerId:VINTAGE_SELLER_ID,api,storeFactory:env=>new PreflightStore(env.ORDERS_DB,{sellerId:VINTAGE_SELLER_ID}),now});
 // This pilot is deliberately manual: its run id never enters the Libros queue.
 const scoped=env=>({...env,USER_ID:VINTAGE_SELLER_ID,ML_PUBLISH_QUEUE_ENABLED:'false'});
 async function sources(env) {
  const db=env.ORDERS_DB;
  const supplierStore=store(env);await supplierStore.discoverSupplierStock();
  // Feed readiness belongs to ingestion. Vintage only reads published snapshots.
  const feeds=(await supplierStore.stmt("SELECT id,source_date,expected_rows FROM ml_pub_feeds WHERE state='ready' ORDER BY source_date DESC LIMIT 10").all()).results;
  const rows=(await db.prepare('SELECT id,policy_json,created_at FROM ml_pub_runs ORDER BY created_at DESC LIMIT 10').all()).results;
  return {feeds:feeds.filter(f=>stockIsFresh(f.source_date,now())),policies:rows.map(r=>({id:r.id,policy:validPolicy(JSON.parse(r.policy_json))}))};
 }
 async function current(env) {
  try{return await store(env).stmt('SELECT * FROM ml_pub_runs ORDER BY created_at LIMIT 1').first();}
  catch(e){if(/no such table/i.test(String(e?.message)))return null;throw e;}
 }
 async function snapshot(env) {
  const run=await current(env);
  if(!run)return {seller_id:VINTAGE_SELLER_ID,limit:PILOT_LIMIT,run:null};
  const s=store(env);await s.discoverSupplierStock();
  const policy=validPolicy(JSON.parse(run.policy_json)),index=JSON.parse(run.index_json);
  const progress={disabled:String(env.ML_PUBLISHER_MODE)==='disabled',phase:index.done?'books':'existing_listings',indexed:Number(index.seen)||0,index_complete:index.done===true,index_status:index.status==='paused'?'paused':'active',busy:Number(run.lease_until)>now(),lease_until:Number(run.lease_until)||0,backoff_until:Number(run.backoff_until)||0,updated_at:Number(run.updated_at)||0};
  const jobs=(await s.stmt("SELECT j.isbn,j.state,j.item_id,j.payload_json,s.data_json FROM ml_pub_jobs j LEFT JOIN ml_pub_stock s ON s.feed_id=? AND s.isbn=j.isbn WHERE j.run_id=? AND j.state IN ('validated','published','uncertain','creating') ORDER BY j.isbn LIMIT 5",run.feed_id,run.id).all()).results;
  const issues=(await s.stmt("SELECT isbn,state,error_code FROM ml_pub_jobs WHERE run_id=? AND state IN ('review','retry','uncertain') ORDER BY isbn LIMIT 10",run.id).all()).results;
  const sample=[];
  for(const job of jobs) {
   const row=job.data_json?JSON.parse(job.data_json):null,payload=job.payload_json?JSON.parse(job.payload_json):{};
   sample.push({isbn:job.isbn,title:row?.title??payload.title??payload.family_name??'',price:payload.price??null,state:job.state,item_id:job.item_id??null,payload});
  }
  const manifest=sample.filter(j=>j.state==='validated').map(j=>({isbn:j.isbn,payload:j.payload}));
  const sampleHash=await sha256(JSON.stringify({seller_id:VINTAGE_SELLER_ID,run_id:run.id,policy_hash:run.policy_hash,manifest}));
  const feed=await s.feed(run.feed_id);
  return {seller_id:VINTAGE_SELLER_ID,limit:PILOT_LIMIT,run:{id:run.id,state:run.state},progress,policy,policy_hash:run.policy_hash,feed,summary:await s.summary(run.id),sample,sample_hash:sampleHash,can_approve:run.state==='ready'&&manifest.length===PILOT_LIMIT&&stockIsFresh(feed?.source_date,now()),issues:issues.map(j=>({isbn:j.isbn,error:j.error_code,state:j.state}))};
 }
 async function prepare(env,{source_run_id,feed_id}) {
  if(!uuid(source_run_id)||!uuid(feed_id))throw error('invalid_source',400);
  const s=store(env);await s.initialize();
  const existing=await current(env);if(existing)return snapshot(env);
  // Read the commercial policy and shared stock; never write the source run.
  const source=await env.ORDERS_DB.prepare('SELECT policy_json FROM ml_pub_runs WHERE id=?').bind(source_run_id).first();
  if(!source)throw error('source_run_not_found',404);
  const feed=await s.feed(feed_id);
  if(!feed||feed.state!=='ready'||!stockIsFresh(feed.source_date,now()))throw error('feed_not_ready_or_stale');
  const identity=await api.account(env);
  if(String(identity.id)!==VINTAGE_SELLER_ID||identity.site_id!=='MLU')throw error('seller_mismatch',403);
  const policy=validPolicy(JSON.parse(source.policy_json));
  // A single deterministic pilot prevents double clicks/concurrent requests from
  // creating additional batches. Five validated books, then explicit approval.
  const runId='23413782-4900-4000-8000-000000000005';
  try{await s.createRun({id:runId,feedId:feed_id,policy,policyHash:await policyHash(policy),now:now(),dailyCap:PILOT_LIMIT,preflightLimit:PILOT_LIMIT,targetPublished:PILOT_LIMIT});}
  catch(e){if(!(await s.run(runId)))throw e;}
  await preflightService.tick(scoped(env),runId);
  return snapshot(env);
 }
 async function approve(env,{run_id,policy_hash,sample_hash}) {
  const before=await snapshot(env);
  if(!before.run||before.run.id!==run_id||!before.can_approve||policy_hash!==before.policy_hash||sample_hash!==before.sample_hash)throw error('sample_changed_or_not_ready');
  const s=store(env),isbns=before.sample.map(j=>j.isbn);
  await s.initialize();
  // Seal each exact reviewed payload while the run is still ready. Missing or
  // modified jobs cannot inherit approval, even if the same ISBN is retained.
  const seals=[];
  for(const job of before.sample)seals.push(s.stmt("INSERT INTO ml_pub_payload_seals(run_id,isbn,policy_hash,payload_hash,sample_hash) SELECT j.run_id,j.isbn,r.policy_hash,?,? FROM ml_pub_jobs j JOIN ml_pub_runs r ON r.id=j.run_id WHERE j.run_id=? AND j.isbn=? AND j.state='validated' AND j.payload_json=? AND r.state='ready' AND r.policy_hash=? AND r.lease_until<? ON CONFLICT(run_id,isbn) DO UPDATE SET policy_hash=excluded.policy_hash,payload_hash=excluded.payload_hash,sample_hash=excluded.sample_hash RETURNING isbn",await payloadHash({id:run_id,policy_hash},job.isbn,job.payload),sample_hash,run_id,job.isbn,JSON.stringify(job.payload),policy_hash,now()));
  const sealed=await env.ORDERS_DB.batch(seals);
  if(sealed.some(r=>r.results?.length!==1))throw error('sample_changed_or_not_ready');
  // Freeze the exact five reviewed ISBNs. Other candidates can never replace a
  // rejected/uncertain one after approval, even if fewer than five are created.
  const guard="EXISTS(SELECT 1 FROM ml_pub_runs WHERE id=? AND state='ready' AND policy_hash=? AND lease_until<?)";
  await s.stmt("UPDATE ml_pub_jobs SET state='skipped_pilot_limit',error_code=NULL WHERE run_id=? AND state IN ('pending','retry','validated') AND isbn NOT IN (SELECT value FROM json_each(?)) AND "+guard,run_id,JSON.stringify(isbns),run_id,policy_hash,now()).run();
  await service.command(scoped(env),'approve',{run_id,policy_hash});
  await service.tick(scoped(env),run_id);
  return snapshot(env);
 }
 async function advance(env,{run_id},publishing=false) {
  const run=await current(env);
  if(!run||run.id!==run_id)throw error('pilot_not_found',404);
  if(run.daily_cap!==PILOT_LIMIT||run.preflight_limit!==PILOT_LIMIT||(await store(env).target(run.id))?.target_published!==PILOT_LIMIT)throw error('pilot_limit_mismatch');
  if(!publishing&&run.state!=='preflight')return snapshot(env);
  await (publishing?service:preflightService).tick(scoped(env),run.id);
  return snapshot(env);
 }
 return {sources,snapshot,prepare,approve,advance:(env,args)=>advance(env,args),publishApproved:(env,args)=>advance(env,args,true)};
}
export const vintagePilot=createVintagePilot();
