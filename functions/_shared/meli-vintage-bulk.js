import {VintageStore} from './meli-vintage-pilot.js';
import {vintageTokens,VINTAGE_SELLER_ID} from './meli-vintage-token.js';
import {createPublicationService} from '../../worker-sync/publication-engine.js';
import {createPublicationMeli,MercadoLibreError} from '../../worker-sync/publication-meli.js';
import {PublicationError,policyHash,stockIsFresh,canonicalIsbn,normalizedTitle} from '../../worker-sync/publication-policy.js';
import {createSbsStock} from '../../worker-sync/sbs-supplier-stock.js';
import {vintagePolicy,requireVintagePrice,VINTAGE_MINIMUM_UYU} from '../../worker-sync/vintage-pricing.js';
import {localExecutorState,stopLocalExecutor} from './vintage-executor-state.js';

export const BULK_RUN='23413782-4900-4000-8000-000000010000';
export const PILOT_RUN='23413782-4900-4000-8000-000000000005';
const fail=(code,status=409)=>{throw new PublicationError(code,status);};
const uuid=x=>typeof x==='string'&&/^[a-f0-9-]{36}$/.test(x);
const SCHEMA=[
 "CREATE TABLE IF NOT EXISTS ml_vintage_bulk_rate (id INTEGER PRIMARY KEY CHECK(id=1),next_at INTEGER NOT NULL DEFAULT 0,cooldown INTEGER NOT NULL DEFAULT 0,strikes INTEGER NOT NULL DEFAULT 0)",
 "CREATE TABLE IF NOT EXISTS ml_vintage_bulk_identifiers (run_id TEXT NOT NULL,isbn TEXT NOT NULL,item_id TEXT NOT NULL,PRIMARY KEY(run_id,isbn,item_id))",
 "CREATE TABLE IF NOT EXISTS ml_vintage_bulk_cache (url TEXT PRIMARY KEY,expires_at INTEGER NOT NULL,response_json TEXT NOT NULL)",
 "CREATE TABLE IF NOT EXISTS ml_vintage_bulk_policy_amendments (run_id TEXT NOT NULL,old_hash TEXT NOT NULL,new_hash TEXT NOT NULL,old_policy_json TEXT NOT NULL,new_policy_json TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(run_id,new_hash))",
 "CREATE TABLE IF NOT EXISTS ml_vintage_pub_availability_amendments (run_id TEXT NOT NULL,isbn TEXT NOT NULL,item_id TEXT NOT NULL,before_json TEXT NOT NULL,after_json TEXT,state TEXT NOT NULL,checked_at INTEGER NOT NULL,PRIMARY KEY(run_id,isbn))",
];
const initialized=new WeakSet();
export class VintageBulkStore extends VintageStore {
 async initialize(){if(initialized.has(this.db)){this.hasSupplierStock=true;return;}await super.initialize();await this.db.batch(SCHEMA.map(sql=>this.db.prepare(sql)));await this.db.prepare('INSERT OR IGNORE INTO ml_vintage_bulk_rate(id) VALUES(1)').run();initialized.add(this.db);}
 async createRun(r){
  // Pilot candidates excluded by its five-book cap remain eligible. Only an
  // actual seller receipt or the live inventory excludes an ISBN here.
  await this.db.batch([
   this.stmt("INSERT INTO ml_pub_runs(id,feed_id,policy_json,policy_hash,state,approved_hash,created_at,updated_at,index_json,daily_cap,preflight_limit) VALUES(?,?,?,?,'publishing',?,?,?,?,1000,1)",r.id,r.feedId,JSON.stringify(r.policy),r.policyHash,r.policyHash,r.now,r.now,JSON.stringify({status:'all',scroll:null,pending:[],done:false,seen:0})),
   this.stmt("INSERT INTO ml_pub_jobs(run_id,isbn,state,error_code,item_id) SELECT ?,s.isbn,CASE WHEN r.isbn IS NULL THEN 'pending' ELSE 'skipped_duplicate' END,CASE WHEN r.isbn IS NULL THEN NULL ELSE 'existing_receipt' END,r.item_id FROM ml_pub_stock s LEFT JOIN ml_pub_receipts r ON r.seller_id=? AND r.isbn=s.isbn WHERE s.feed_id=?",r.id,VINTAGE_SELLER_ID,r.feedId),
   this.stmt('INSERT INTO ml_pub_run_targets(run_id,target_published,created_at) VALUES(?,?,?)',r.id,9995,r.now),
  ]);
 }
 async existing(id,isbn,title){return await this.db.prepare('SELECT item_id,isbn FROM ml_vintage_bulk_identifiers WHERE run_id=? AND isbn=? LIMIT 1').bind(id,isbn).first()??await super.existing(id,isbn,title);}
}

// A persistent seller-wide request clock prevents bursts across tabs/isolates.
// It is an application budget (30 requests/minute), not a claimed ML limit.
export function createVintageBulkFetch({fetcher=(...args)=>fetch(...args),now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),random=Math.random}={}){
 let tail=Promise.resolve();
 return (env,url,options)=>{
  const task=tail.then(async()=>{
   const db=env.ORDERS_DB,rate=await db.prepare('SELECT * FROM ml_vintage_bulk_rate WHERE id=1').first();
   if(rate.cooldown>now())throw new MercadoLibreError('vintage_rate_cooldown',429,Math.ceil((rate.cooldown-now())/1000));
   const parsed=new URL(url),cacheable=(options.method??'GET')==='GET'&&parsed.origin==='https://api.mercadolibre.com'&&(/^\/categories\/MLU\d+(?:\/attributes)?$/.test(parsed.pathname)||/^\/catalog_domains\/MLU-[A-Z_]+\/categories$/.test(parsed.pathname));
   if(cacheable){const cached=await db.prepare('SELECT response_json FROM ml_vintage_bulk_cache WHERE url=? AND expires_at>?').bind(url,now()).first();if(cached)return new Response(cached.response_json,{headers:{'Content-Type':'application/json'}});}
   const slot=await db.prepare('UPDATE ml_vintage_bulk_rate SET next_at=MAX(next_at,?)+2000 WHERE id=1 AND cooldown<=? RETURNING next_at').bind(now(),now()).first();
   if(!slot)throw new MercadoLibreError('vintage_rate_cooldown',429,120);
   const wait=slot.next_at-2000-now();
   if(wait>30000)throw new MercadoLibreError('vintage_rate_budget',429,Math.ceil(wait/1000));
   if(wait>0)await sleep(wait);
   const again=await db.prepare('SELECT cooldown FROM ml_vintage_bulk_rate WHERE id=1').first();
   if(again.cooldown>now())throw new MercadoLibreError('vintage_rate_cooldown',429,Math.ceil((again.cooldown-now())/1000));
   const response=await fetcher(url,options);
   if(response.ok&&rate.strikes>0)await db.prepare('UPDATE ml_vintage_bulk_rate SET strikes=0 WHERE id=1 AND cooldown<=?').bind(now()).run();
   if(cacheable&&response.ok){try{const text=await response.clone().text();if(text.length<=524288){JSON.parse(text);await db.prepare('INSERT INTO ml_vintage_bulk_cache(url,expires_at,response_json) VALUES(?,?,?) ON CONFLICT(url) DO UPDATE SET expires_at=excluded.expires_at,response_json=excluded.response_json').bind(url,now()+1800000,text).run();}}catch{}}
   if(response.status===429){
    const header=response.headers.get('retry-after'),seconds=Number(header),serverWait=Number.isFinite(seconds)?seconds*1000:Math.max(0,Date.parse(header)-now())||0;
    const until=now()+Math.max(serverWait,Math.min(3600000,120000*2**Math.min(rate.strikes,5)))+Math.floor(random()*15000);
    await db.prepare('UPDATE ml_vintage_bulk_rate SET cooldown=MAX(cooldown,?),strikes=MIN(strikes+1,6) WHERE id=1').bind(until).run();
   }
   return response;
  });
  tail=task.catch(()=>{});return task;
 };
}
function identifiers(item){
 const candidates=[...(item.attributes??[]).filter(a=>['ISBN','GTIN','EAN','SELLER_SKU'].includes(a.id)).flatMap(a=>[a.value_name,...(a.values??[]).map(v=>v.name)]),item.seller_custom_field,...(item.variations??[]).flatMap(v=>[v.seller_custom_field,...(v.attributes??[]).filter(a=>['ISBN','GTIN','EAN','SELLER_SKU'].includes(a.id)).map(a=>a.value_name)])];
 const out=new Set();for(const value of candidates){if(!value)continue;try{out.add(canonicalIsbn(String(value).replace(/^AMADO-AR-/,'')));}catch{}}
 return [...out];
}
export function createVintageBulk({api:providedApi,now=Date.now,fetcher,sleep,random}={}){
 const limited=createVintageBulkFetch({now,fetcher,sleep,random});let activeEnv;
 const api=providedApi??createPublicationMeli({sellerId:VINTAGE_SELLER_ID,tokenProvider:vintageTokens.getAccessToken,tokenInvalidator:vintageTokens.invalidateAccessToken,now,timeouts:{request:60000,create:60000},fetcher:(url,options)=>limited(activeEnv,url,options)});
 const bulkApi={...api,
  prepare:(...args)=>api.prepare(...args),
  create:(env,payload,policy)=>{requireVintagePrice(payload);return api.create(env,payload,policy);},
  async indexSlice(env,index){
   if(providedApi)return api.indexSlice(env,index);
   const next=structuredClone(index);
   if(!next.pending.length){
    const q=new URLSearchParams({search_type:'scan',limit:'100'});if(next.scroll)q.set('scroll_id',next.scroll);
    let page;try{page=await api.call(env,`/users/${VINTAGE_SELLER_ID}/items/search?${q}`);}catch(e){if(next.scroll&&[400,404,410].includes(e.status)){q.delete('scroll_id');next.scroll=null;page=await api.call(env,`/users/${VINTAGE_SELLER_ID}/items/search?${q}`);}else throw e;}
    if(page.seller_id!==undefined&&String(page.seller_id)!==VINTAGE_SELLER_ID)fail('index_seller_mismatch',502);
    if(page.results===null||Array.isArray(page.results)&&!page.results.length)return {index:{...next,done:true,completedAt:new Date(now()).toISOString()},items:[]};
    if(!Array.isArray(page.results)||page.results.some(id=>!/^MLU\d+$/.test(id)))fail('index_page_invalid',502);
    next.pending=page.results;next.scroll=page.scroll_id??null;
   }
   // One multiget per tick, no parallel inventory bursts. Scan all statuses.
   const ids=next.pending.slice(0,20),raw=await api.call(env,'/items/bulk?ids='+ids.join(','));
   if(!Array.isArray(raw)||raw.length!==ids.length)fail('index_details_incomplete',502);
   const remaining=new Set(ids),items=[],writes=[];
   for(const entry of raw){const b=entry.body;if((entry.status_code??entry.code)!==200||!b||String(b.seller_id)!==VINTAGE_SELLER_ID||!remaining.delete(b.id))fail('index_details_invalid',502);
    const isbns=identifiers(b);items.push({id:b.id,isbn:isbns[0]??null,titleKey:normalizedTitle(b.title??b.family_name),status:b.status});
    for(const isbn of isbns)writes.push(env.ORDERS_DB.prepare('INSERT OR IGNORE INTO ml_vintage_bulk_identifiers(run_id,isbn,item_id) VALUES(?,?,?)').bind(BULK_RUN,isbn,b.id));
   }
   if(remaining.size)fail('index_details_incomplete',502);if(writes.length)await env.ORDERS_DB.batch(writes);
   next.pending=next.pending.slice(ids.length);next.seen+=ids.length;return {index:next,items};
  },
  async skuItems(env,isbn){
   if(providedApi)return api.skuItems(env,isbn);
   const result=new Set(await api.skuItems(env,isbn));
   const q=new URLSearchParams({seller_sku:'AMADO-AR-'+isbn,limit:'100'}),data=await api.call(env,`/users/${VINTAGE_SELLER_ID}/items/search?${q}`);
   if(!Array.isArray(data.results)||data.results.some(id=>!/^MLU\d+$/.test(id)))fail('sku_lookup_invalid',502);
   data.results.forEach(id=>result.add(id));return [...result];
  },
 };
 const store=env=>new VintageBulkStore(env.ORDERS_DB,{sellerId:VINTAGE_SELLER_ID});
 const scoped=env=>({...env,USER_ID:VINTAGE_SELLER_ID,ML_PUBLISH_QUEUE_ENABLED:'false'});
 const service=createPublicationService({sellerId:VINTAGE_SELLER_ID,api:bulkApi,storeFactory:store,now,maxJobsPerTick:1,maxIndexSlicesPerTick:1});
 const supplier=createSbsStock({now});
 async function repairAvailability(env,s){
  const run=await s.run(BULK_RUN),pilot=await s.run(PILOT_RUN),lock=crypto.randomUUID();
  if(run?.state!=='paused'||pilot?.state!=='complete')fail('pause_before_availability_change');
  const leased=await s.stmt("UPDATE ml_pub_runs SET lease_id=?,lease_until=? WHERE id=? AND state='paused' AND lease_until<? RETURNING id",lock,now()+300000,BULK_RUN,now()).first();
  if(!leased)fail('run_busy');
  try{
   const days=JSON.parse(pilot.policy_json).availabilityDays;
   if(days!==18)fail('availability_policy_changed');
   const job=await s.stmt("SELECT j.isbn,j.item_id FROM ml_pub_jobs j LEFT JOIN ml_pub_availability_amendments a ON a.run_id=j.run_id AND a.isbn=j.isbn AND a.item_id=j.item_id WHERE j.run_id=? AND j.state='published' AND (a.state IS NULL OR a.state!='confirmed') ORDER BY j.isbn LIMIT 1",PILOT_RUN).first();
   if(!job)return {...await status(env),availability_complete:true};
   if(!/^MLU\d+$/.test(job.item_id))fail('invalid_item_id');
   const me=await api.call(env,'/users/me');if(String(me.id)!==VINTAGE_SELLER_ID||me.site_id!=='MLU')fail('seller_mismatch',403);
   const path='/items/'+job.item_id,term=item=>(item.sale_terms??[]).find(x=>x.id==='MANUFACTURING_TIME'),value=item=>Number(term(item)?.value_struct?.number??parseInt(term(item)?.value_name,10));
   const check=item=>{if(item.id!==job.item_id||String(item.seller_id)!==VINTAGE_SELLER_ID||!identifiers(item).includes(job.isbn))fail('availability_item_identity_mismatch',403);requireVintagePrice(item);};
   const before=await api.call(env,path);check(before);
   const safeTerm=item=>({value_name:term(item)?.value_name??null,value_struct:term(item)?.value_struct??null});
   await s.stmt("INSERT INTO ml_pub_availability_amendments VALUES(?,?,?,?,NULL,'checking',?) ON CONFLICT(run_id,isbn) DO UPDATE SET state='checking',checked_at=excluded.checked_at",PILOT_RUN,job.isbn,job.item_id,JSON.stringify(safeTerm(before)),now()).run();
   let after=before;
   if(value(before)!==days){
    await s.stmt('DELETE FROM ml_pub_verifications WHERE run_id=? AND isbn=?',PILOT_RUN,job.isbn).run();
    try{await api.call(env,path,{method:'PUT',body:{sale_terms:[{id:'MANUFACTURING_TIME',value_name:days+' días'}]}});}
    catch(e){return {...await status(env),availability_complete:false,availability_error:{item_id:job.item_id,code:e instanceof PublicationError?e.code:'availability_request_failed',status:e.status??503,before:safeTerm(before)}};}
    after=await api.call(env,path);check(after);
    if(value(after)!==days||after.price!==before.price)return {...await status(env),availability_complete:false,availability_error:{item_id:job.item_id,code:'availability_update_not_confirmed',before:safeTerm(before),after:safeTerm(after)}};
   }
   await s.stmt("UPDATE ml_pub_availability_amendments SET after_json=?,state='confirmed',checked_at=? WHERE run_id=? AND isbn=? AND item_id=?",JSON.stringify(safeTerm(after)),now(),PILOT_RUN,job.isbn,job.item_id).run();
   const count=await s.stmt("SELECT COUNT(*) n FROM ml_pub_availability_amendments WHERE run_id=? AND state='confirmed'",PILOT_RUN).first();
   return {...await status(env),availability_complete:count.n===5,availability_checked:{item_id:job.item_id,days,remaining:5-count.n}};
  }finally{await s.release(BULK_RUN,lock);}
 }
 async function applyMinimum(env,s){
  const run=await s.run(BULK_RUN),lock=crypto.randomUUID();
  if(run&&run.state!=='paused')fail('pause_before_price_change');
  const lockRun=run?BULK_RUN:PILOT_RUN;
  const leased=await s.stmt("UPDATE ml_pub_runs SET lease_id=?,lease_until=? WHERE id=? AND lease_until<? AND state IN ('paused','complete') RETURNING id",lock,now()+300000,lockRun,now()).first();
  if(!leased)fail('run_busy');
  try{
   if(run){
    const policy=vintagePolicy(JSON.parse(run.policy_json)),hash=await policyHash(policy);
    if(hash!==run.policy_hash)await env.ORDERS_DB.batch([
     env.ORDERS_DB.prepare('INSERT OR IGNORE INTO ml_vintage_bulk_policy_amendments VALUES(?,?,?,?,?,?)').bind(run.id,run.policy_hash,hash,run.policy_json,JSON.stringify(policy),now()),
     s.stmt('UPDATE ml_pub_runs SET policy_json=?,policy_hash=?,approved_hash=?,updated_at=? WHERE id=? AND lease_id=?',JSON.stringify(policy),hash,hash,now(),run.id,lock),
     s.stmt("UPDATE ml_pub_jobs SET state='pending',payload_json=NULL,next_at=0,error_code=NULL WHERE run_id=? AND item_id IS NULL AND state IN ('pending','validated','retry') AND (payload_json IS NOT NULL OR state IN ('validated','retry'))",run.id),
    ]);
   }
   // One known campaign item per request. Keep the original sealed payload intact.
   const job=await s.stmt("SELECT j.run_id,j.isbn,j.item_id,j.payload_json FROM ml_pub_jobs j LEFT JOIN ml_pub_price_amendments a ON a.run_id=j.run_id AND a.isbn=j.isbn AND a.item_id=j.item_id WHERE j.run_id IN (?,?) AND j.state='published' AND (a.state IS NULL OR a.state!='confirmed' OR a.price<1600) ORDER BY j.run_id,j.isbn LIMIT 1",PILOT_RUN,BULK_RUN).first();
   if(!job)return {...await status(env),minimum_complete:true};
   if(!/^MLU\d+$/.test(job.item_id))fail('invalid_item_id');
   const identity=await api.call(env,'/users/me');
   if(String(identity.id)!==VINTAGE_SELLER_ID||identity.site_id!=='MLU')fail('seller_mismatch',403);
   const path='/items/'+job.item_id,check=item=>{
    if(item.id!==job.item_id||String(item.seller_id)!==VINTAGE_SELLER_ID||item.currency_id!=='UYU'||!identifiers(item).includes(job.isbn))fail('price_item_identity_mismatch',403);
    if(!Number.isFinite(item.price)||item.price<=0)fail('invalid_item_price');
   };
   let item=await api.call(env,path);check(item);
   const original=item.price,target=Math.max(VINTAGE_MINIMUM_UYU,item.price);
   await s.stmt("INSERT INTO ml_pub_price_amendments VALUES(?,?,?,?,?,'checking',?) ON CONFLICT(run_id,isbn) DO UPDATE SET price=excluded.price,state='checking',checked_at=excluded.checked_at",job.run_id,job.isbn,job.item_id,original,target,now()).run();
   if(item.price<VINTAGE_MINIMUM_UYU){
    await s.stmt('DELETE FROM ml_pub_verifications WHERE run_id=? AND isbn=?',job.run_id,job.isbn).run();
    // If the response is lost, the next attempt reads first; never lower a price.
    await api.call(env,path,{method:'PUT',body:{price:target}});
    item=await api.call(env,path);check(item);
    if(item.price<target)fail('price_update_not_confirmed');
   }
   await s.stmt("UPDATE ml_pub_price_amendments SET price=?,state='confirmed',checked_at=? WHERE run_id=? AND isbn=? AND item_id=?",item.price,now(),job.run_id,job.isbn,job.item_id).run();
   const remaining=await s.stmt("SELECT COUNT(*) n FROM ml_pub_jobs j LEFT JOIN ml_pub_price_amendments a ON a.run_id=j.run_id AND a.isbn=j.isbn AND a.item_id=j.item_id WHERE j.run_id IN (?,?) AND j.state='published' AND (a.state IS NULL OR a.state!='confirmed' OR a.price<1600)",PILOT_RUN,BULK_RUN).first();
   return {...await status(env),minimum_complete:remaining.n===0,minimum_checked:{item_id:item.id,price:item.price,remaining:remaining.n}};
  }finally{await s.release(lockRun,lock);}
 }
 async function status(env){
  const s=store(env),exists=await env.ORDERS_DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ml_vintage_pub_runs'").first(),run=exists?await s.run(BULK_RUN):null,local_executor=await localExecutorState(env,now());
  if(!run){const pilot=exists?await s.run(PILOT_RUN):null;return {seller_id:VINTAGE_SELLER_ID,minimum_sale_uyu:VINTAGE_MINIMUM_UYU,target_total:10000,pilot_published:5,run:null,policy_hash:pilot?await policyHash(vintagePolicy(JSON.parse(pilot.policy_json))):null};}
  await s.discoverSupplierStock();const summary=await s.summary(run.id),feed=await s.feed(run.feed_id);
  const rate=await env.ORDERS_DB.prepare('SELECT cooldown FROM ml_vintage_bulk_rate WHERE id=1').first();
  const daily=await s.dayCreated(now()),date=new Date(now()-3*3600000).toISOString().slice(0,10),nextDay=Date.parse(date+'T03:00:00Z')+86400000;
  return {seller_id:VINTAGE_SELLER_ID,minimum_sale_uyu:VINTAGE_MINIMUM_UYU,target_total:10000,pilot_published:5,run:{id:run.id,state:run.state},local_executor,published_total:5+await s.publishedCount(run.id),summary,source_date:feed?.source_date,stock_fresh:stockIsFresh(feed?.source_date,now()),busy:run.lease_until>now(),resume_at:Math.max(run.backoff_until||0,rate?.cooldown||0,daily>=1000?nextDay:0),daily_created:daily,issues:(await s.stmt("SELECT isbn,state,error_code FROM ml_pub_jobs WHERE run_id=? AND state IN ('review','uncertain') LIMIT 10",run.id).all()).results,recent:await s.publishedItems(run.id,Math.max(0,(await s.publishedCount(run.id))-10),10)};
 }
 async function command(env,action,args={}){
  activeEnv=env;const s=store(env);
  if(action==='status')return status(env);
  if(['begin','import','commit'].includes(action))return supplier(env,action,args);
  await s.initialize();
  if(action!=='pause'&&(await localExecutorState(env,now())).active)fail('local_executor_active_pause_it_first');
  if(action==='apply_minimum'){if(args.run_id!==BULK_RUN)fail('bulk_not_found',404);return applyMinimum(env,s);}
  if(action==='apply_margin_35'){
   if(args.run_id!==BULK_RUN)fail('bulk_not_found',404);
   const run=await s.run(BULK_RUN),lock=crypto.randomUUID();
   if(!run||run.state!=='paused')fail('pause_before_price_change');
   const leased=await s.stmt("UPDATE ml_pub_runs SET lease_id=?,lease_until=? WHERE id=? AND state='paused' AND lease_until<? RETURNING id",lock,now()+300000,BULK_RUN,now()).first();
   if(!leased)fail('run_busy');
   try{
    const unresolved=await s.stmt("SELECT COUNT(*) n FROM ml_pub_receipts WHERE run_id=? AND state!='published'",BULK_RUN).first();
    if(unresolved.n)fail('reconcile_existing_receipts_before_margin_change');
    const policy=vintagePolicy({...JSON.parse(run.policy_json),margin:.35}),hash=await policyHash(policy);
    await env.ORDERS_DB.batch([
     env.ORDERS_DB.prepare('INSERT OR IGNORE INTO ml_vintage_bulk_policy_amendments VALUES(?,?,?,?,?,?)').bind(run.id,run.policy_hash,hash,run.policy_json,JSON.stringify(policy),now()),
     s.stmt('UPDATE ml_pub_runs SET policy_json=?,policy_hash=?,approved_hash=?,updated_at=? WHERE id=? AND lease_id=?',JSON.stringify(policy),hash,hash,now(),run.id,lock),
     s.stmt("UPDATE ml_pub_jobs SET state='pending',payload_json=NULL,next_at=0,error_code=NULL WHERE run_id=? AND item_id IS NULL AND state IN ('pending','validated','retry') AND NOT EXISTS(SELECT 1 FROM ml_vintage_pub_receipts r WHERE r.seller_id=? AND r.isbn=ml_vintage_pub_jobs.isbn)",run.id,VINTAGE_SELLER_ID),
    ]);
   }finally{await s.stmt('UPDATE ml_pub_runs SET lease_id=NULL,lease_until=0 WHERE id=? AND lease_id=?',BULK_RUN,lock).run();}
   return {...await status(env),margin:.35,policy_hash:(await s.run(BULK_RUN)).policy_hash};
  }
  if(action==='repair_availability'){if(args.run_id!==BULK_RUN)fail('bulk_not_found',404);return repairAvailability(env,s);}
  if(action==='start'){
   if(!uuid(args.feed_id))fail('invalid_feed_id',400);
   const pilot=await s.run(PILOT_RUN),pilotTarget=await s.target(PILOT_RUN);
   if(pilot?.state!=='complete'||pilotTarget?.target_published!==5||await s.publishedCount(PILOT_RUN)!==5)fail('pilot_not_complete');
   const verified=await s.stmt('SELECT result_json FROM ml_pub_verifications WHERE run_id=?',PILOT_RUN).all();
   if(verified.results.length!==5||verified.results.some(v=>JSON.parse(v.result_json).ok!==true))fail('pilot_not_verified');
   const currentRun=await s.run(BULK_RUN);
   const policy=vintagePolicy(JSON.parse(currentRun?.policy_json??pilot.policy_json)),hash=await policyHash(policy),feed=await s.feed(args.feed_id);
   if(!feed||feed.state!=='ready'||!stockIsFresh(feed.source_date,now())||feed.expected_rows<10000)fail('bulk_feed_not_ready');
   if(args.policy_hash!==hash)fail('policy_changed');
   let run=await s.run(BULK_RUN);
   if(!run){try{await s.createRun({id:BULK_RUN,feedId:feed.id,policy,policyHash:hash,now:now()});}catch(e){if(!await s.run(BULK_RUN))throw e;}run=await s.run(BULK_RUN);}
   if(run.policy_hash!==hash)fail('policy_changed');
   if(run.feed_id!==feed.id){
    if(run.lease_until>now())fail('run_busy');
    await s.attachFeed(run.id,feed.id);
    await s.stmt("INSERT OR IGNORE INTO ml_pub_jobs(run_id,isbn,state) SELECT ?,s.isbn,'pending' FROM ml_pub_stock s WHERE s.feed_id=? AND NOT EXISTS(SELECT 1 FROM ml_pub_receipts r WHERE r.seller_id=? AND r.isbn=s.isbn)",run.id,feed.id,VINTAGE_SELLER_ID).run();
   }
   if(['paused','stock_stale','auth_error'].includes(run.state))await s.stmt("UPDATE ml_pub_runs SET state='publishing',updated_at=? WHERE id=? AND lease_until<? AND approved_hash=policy_hash",now(),run.id,now()).run();
   return status(env);
  }
  if(args.run_id!==BULK_RUN)fail('bulk_not_found',404);
  if(action==='pause'){await stopLocalExecutor(env);await s.stmt("UPDATE ml_pub_runs SET state='paused',updated_at=? WHERE id=?",now(),BULK_RUN).run();return status(env);}
  if(action!=='tick')fail('invalid_bulk_action',400);
  const run=await s.run(BULK_RUN);if(run&&JSON.parse(run.policy_json).minimumSaleUyu<VINTAGE_MINIMUM_UYU)fail('apply_minimum_1600_first');
  await service.tick(scoped(env),BULK_RUN);return status(env);
 }
 return {command,status};
}
