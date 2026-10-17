import { PublicationStore } from '../../worker-sync/publication-store.js';
import { createPublicationService } from '../../worker-sync/publication-engine.js';
import { createPublicationMeli } from '../../worker-sync/publication-meli.js';
import { validPolicy, policyHash, stockIsFresh, sha256, PublicationError } from '../../worker-sync/publication-policy.js';
import { vintageTokens, VINTAGE_SELLER_ID } from './meli-vintage-token.js';

export const PILOT_LIMIT=5;
const uuid=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value);
const error=(code,status=409)=>new PublicationError(code,status);
// Background/browser continuation can only lease preflight. A concurrent owner
// approval cannot turn a "validate only" request into a publishing tick.
class PreflightStore extends PublicationStore {
 async lease(id,token,now){return this.stmt("UPDATE ml_pub_runs SET lease_id=?,lease_until=?,updated_at=? WHERE id=? AND state='preflight' AND lease_until<? RETURNING *",token,now+300000,now,id,now).first();}
}
export function createVintagePilot({api=createPublicationMeli({sellerId:VINTAGE_SELLER_ID,tokenProvider:vintageTokens.getAccessToken,tokenInvalidator:vintageTokens.invalidateAccessToken}),now=Date.now}={}) {
 const store=env=>new PublicationStore(env.ORDERS_DB,{sellerId:VINTAGE_SELLER_ID});
 const service=createPublicationService({sellerId:VINTAGE_SELLER_ID,api,storeFactory:store,now});
 const preflightService=createPublicationService({sellerId:VINTAGE_SELLER_ID,api,storeFactory:env=>new PreflightStore(env.ORDERS_DB,{sellerId:VINTAGE_SELLER_ID}),now});
 // This pilot is deliberately manual: its run id never enters the Libros queue.
 const scoped=env=>({...env,USER_ID:VINTAGE_SELLER_ID,ML_PUBLISH_QUEUE_ENABLED:'false'});
 async function sources(env) {
  const db=env.ORDERS_DB;
  // The stock-loading connector leaves a feed importing. Offer it only once
  // every declared ISBN has arrived; merely viewing this page never commits it.
  const feeds=(await db.prepare("SELECT f.id,f.source_date,f.expected_rows FROM ml_pub_feeds f WHERE f.state='ready' OR (f.state='importing' AND f.expected_rows=(SELECT COUNT(*) FROM ml_pub_stock s WHERE s.feed_id=f.id)) ORDER BY f.source_date DESC LIMIT 10").all()).results;
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
  const s=store(env),policy=validPolicy(JSON.parse(run.policy_json)),index=JSON.parse(run.index_json);
  const progress={disabled:String(env.ML_PUBLISHER_MODE)==='disabled',phase:index.done?'books':'existing_listings',indexed:Number(index.seen)||0,index_complete:index.done===true,index_status:index.status==='paused'?'paused':'active',busy:Number(run.lease_until)>now(),lease_until:Number(run.lease_until)||0,backoff_until:Number(run.backoff_until)||0,updated_at:Number(run.updated_at)||0};
  const jobs=(await s.jobs(run.id)).filter(j=>['validated','published','uncertain','creating','review','retry'].includes(j.state));
  const sample=[];
  for(const job of jobs.filter(j=>['validated','published','uncertain','creating'].includes(j.state)).slice(0,5)) {
   const row=await s.stock(run.feed_id,job.isbn),payload=job.payload??{};
   sample.push({isbn:job.isbn,title:row?.title??payload.title??payload.family_name??'',price:payload.price??null,state:job.state,item_id:job.item_id??null,payload});
  }
  const manifest=sample.filter(j=>j.state==='validated').map(j=>({isbn:j.isbn,payload:j.payload}));
  const sampleHash=await sha256(JSON.stringify({seller_id:VINTAGE_SELLER_ID,run_id:run.id,policy_hash:run.policy_hash,manifest}));
  return {seller_id:VINTAGE_SELLER_ID,limit:PILOT_LIMIT,run:{id:run.id,state:run.state},progress,policy,policy_hash:run.policy_hash,feed:await s.feed(run.feed_id),summary:await s.summary(run.id),sample,sample_hash:sampleHash,can_approve:run.state==='ready'&&manifest.length===PILOT_LIMIT&&stockIsFresh((await s.feed(run.feed_id))?.source_date,now()),issues:jobs.filter(j=>['review','retry','uncertain'].includes(j.state)).slice(0,10).map(j=>({isbn:j.isbn,error:j.error_code,state:j.state}))};
 }
 async function prepare(env,{source_run_id,feed_id}) {
  if(!uuid(source_run_id)||!uuid(feed_id))throw error('invalid_source',400);
  const s=store(env);await s.initialize();
  const existing=await current(env);if(existing)return snapshot(env);
  // Read the commercial policy and shared stock; never write the source run.
  const source=await env.ORDERS_DB.prepare('SELECT policy_json FROM ml_pub_runs WHERE id=?').bind(source_run_id).first();
  if(!source)throw error('source_run_not_found',404);
  let feed=await s.feed(feed_id);
  if(!feed||!['ready','importing'].includes(feed.state)||!stockIsFresh(feed.source_date,now()))throw error('stale_feed');
  const identity=await api.account(env);
  if(String(identity.id)!==VINTAGE_SELLER_ID||identity.site_id!=='MLU')throw error('seller_mismatch',403);
  // Atomic count guard in commitFeed rejects partial uploads. No Libros run is
  // created, resumed or attached; only this new shared snapshot becomes ready.
  if(feed.state==='importing')feed=await s.commitFeed(feed_id);
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
