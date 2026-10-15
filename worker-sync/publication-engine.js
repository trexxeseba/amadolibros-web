import {APP_ID,SELLER_ID,PublicationError,canonicalIsbn,hasSupplierStock,normalizeSupplierRow,validPolicy,policyHash,quoteMercadoLibre,stockIsFresh,safeCode} from './publication-policy.js';
import {PublicationStore} from './publication-store.js';
import {createPublicationMeli,MercadoLibreError} from './publication-meli.js';
const initialized=new WeakSet();
const idOk=id=>typeof id==='string'&&/^[a-f0-9-]{36}$/.test(id);

export function createPublicationService({api=createPublicationMeli(),storeFactory=env=>new PublicationStore(env.ORDERS_DB),now=Date.now}={}){
 function store(env){if(String(env.USER_ID)!==SELLER_ID||String(env.APP_ID)!==APP_ID)throw new PublicationError('seller_configuration_mismatch',503);return storeFactory(env);}
 async function initialize(env,s){if(!initialized.has(env.ORDERS_DB)){await s.initialize();if(env.ORDERS_DB&&typeof env.ORDERS_DB==='object')initialized.add(env.ORDERS_DB);}}
 async function tick(env,runId){
  if(String(env.ML_PUBLISHER_MODE)==='disabled')return {state:'disabled'};
  const s=store(env);let run;
  try{run=runId?await s.run(runId):await s.activeRun();}catch(error){if(/no such table/i.test(String(error?.message)))return {state:'not_initialized'};throw error;}
  if(!run)return {state:'no_active_run'};
  if(!['preflight','publishing'].includes(run.state))return s.summary(run.id);
  if(run.backoff_until>now())return {id:run.id,state:'backoff',resume_at:new Date(run.backoff_until).toISOString()};
  const lease=crypto.randomUUID();run=await s.lease(run.id,lease,now());if(!run)return {state:'busy'};
  const deadline=now()+20000;let processed=0;
  const mark=(isbn,state,options={})=>s.job(run.id,isbn,state,{...options,leaseToken:lease,now:now()});
  const state=value=>s.setRunState(run.id,value,lease,now());
  try{
   const feed=await s.feed(run.feed_id);
   if(feed?.state!=='ready'||!stockIsFresh(feed.source_date,now())){await state('stock_stale');return {state:'stock_stale'};}
   let index=JSON.parse(run.index_json);
   while(!index.done&&now()<deadline&&processed<20){const slice=await api.indexSlice(env,index);index=await s.saveIndex(run.id,slice.index,slice.items,lease,now());processed++;}
   if(!index.done)return s.summary(run.id);
   const policy=validPolicy(JSON.parse(run.policy_json));
   const publishing=run.state==='publishing'&&run.approved_hash===run.policy_hash;
   if(run.state==='publishing'&&!publishing)return {state:'publishing_not_enabled'};
   if(publishing&&await s.dayCreated(now())>=run.daily_cap)return {state:'daily_cap_reached'};
   for(const job of await s.interrupted(run.id)){
    const receipt=await s.receipt(SELLER_ID,job.isbn);
    if(receipt?.state==='published'){await mark(job.isbn,'published',{itemId:receipt.item_id});continue;}
    const found=await api.skuItems(env,job.isbn);
    if(found.length===1){await s.receiptState(SELLER_ID,job.isbn,'published',found[0]);await mark(job.isbn,'published',{itemId:found[0]});}
   }
   const counts=await s.counts(run.id);let validated=counts.find(x=>x.state==='validated')?.n??0;
   if(!publishing&&validated>=run.preflight_limit){await state('ready');return s.summary(run.id);}
   processed=0;
   while(now()<deadline&&processed<10){
    const job=await s.nextJob(run.id,now(),publishing);if(!job){if(!await s.unfinished(run.id,publishing)){const terminal=await s.counts(run.id),needsReview=terminal.some(x=>['review','uncertain'].includes(x.state)&&x.n>0);await state(publishing?(needsReview?'complete_with_review':'complete'):'ready');}break;}
    processed++;
    try{
     const freshRun=await s.run(run.id),freshFeed=await s.feed(freshRun.feed_id);
     if(freshFeed?.state!=='ready'||!stockIsFresh(freshFeed.source_date,now())){await state('stock_stale');break;}
     const row=await s.stock(freshRun.feed_id,job.isbn);
     if(!row||!hasSupplierStock(row.stock)){await mark(job.isbn,'skipped_stock');continue;}
     normalizeSupplierRow(row);
     const receipt=await s.receipt(SELLER_ID,row.isbn);
     if(receipt){await mark(row.isbn,receipt.state==='published'?'published':'uncertain',{itemId:receipt.item_id,errorCode:receipt.state==='published'?null:'existing_create_receipt'});continue;}
     const duplicate=await s.existing(run.id,row.isbn,row.title);
     if(duplicate){await mark(row.isbn,duplicate.isbn===row.isbn?'skipped_duplicate':'review',{itemId:duplicate.item_id,errorCode:duplicate.isbn===row.isbn?null:'possible_title_duplicate'});continue;}
     const bySku=await api.skuItems(env,row.isbn);
     if(bySku.length){await mark(row.isbn,'skipped_duplicate',{itemId:bySku[0]});continue;}
     const quote=quoteMercadoLibre(row,policy);
     let payload=job.payload_json?JSON.parse(job.payload_json):null;
     if(!payload||payload.price!==quote.price)payload=await api.prepare(env,row,policy,quote.price);
     if(!publishing){await mark(row.isbn,'validated',{payload});validated++;if(validated>=run.preflight_limit){await state('ready');break;}continue;}
     // Check the source snapshot, run state and lease again after preparation.
     const guardRun=await s.run(run.id),guardRow=await s.stock(guardRun.feed_id,row.isbn),guardFeed=await s.feed(guardRun.feed_id);
     if(guardRun.state!=='publishing'||guardRun.approved_hash!==run.policy_hash||!await s.ownsLease(run.id,lease,now()))break;
     if(!guardRow||!hasSupplierStock(guardRow.stock)||!stockIsFresh(guardFeed?.source_date,now())){await mark(row.isbn,'skipped_stock');continue;}
     if(quoteMercadoLibre(guardRow,policy).price!==payload.price){await mark(row.isbn,'pending',{payload:null});continue;}
     const reserved=await s.reserve(SELLER_ID,row.isbn,run.id,now(),run.daily_cap,lease);
     if(!reserved){const existing=await s.receipt(SELLER_ID,row.isbn);if(existing)await mark(row.isbn,existing.state==='published'?'published':'uncertain',{itemId:existing.item_id,errorCode:'receipt_already_reserved'});else return {state:'daily_cap_reached'};continue;}
     await mark(row.isbn,'creating',{payload,attempt:true});
     let result;
     try{result=await api.create(env,payload,policy);}
     catch(error){await s.receiptState(SELLER_ID,row.isbn,'uncertain');await mark(row.isbn,'uncertain',{errorCode:safeCode(error)});if(error.status===429){await s.backoff(run.id,now()+Math.max(60000,error.retryAfter*1000||0),lease);break;}continue;}
     await s.receiptState(SELLER_ID,row.isbn,'published',result.id);
     await mark(row.isbn,'published',{itemId:result.id});
    }catch(error){
     const retry=error instanceof MercadoLibreError&&(error.status===429||error.status>=500)&&job.attempts<5;
     const nextAt=retry?now()+Math.max(error.retryAfter*1000,Math.min(3600000,30000*2**job.attempts)):0;
     await mark(job.isbn,retry?'retry':'review',{errorCode:safeCode(error),nextAt,attempt:true});
     if(error.status===401||error.status===403){await state('auth_error');break;}
     if(error.status===429){await s.backoff(run.id,nextAt,lease);break;}
    }
   }
   return s.summary(run.id);
  }catch(error){if(error.status===429){const until=now()+Math.max(60000,error.retryAfter*1000||0);await s.backoff(run.id,until,lease);return {id:run.id,state:'backoff',resume_at:new Date(until).toISOString()};}throw error;}
  finally{await s.release(run.id,lease);}
 }
 async function command(env,action,args={},nonce=null){
  if(!['begin_feed','import_feed','commit_feed','create_run','attach_feed','status','tick','pause','approve','preview'].includes(action))throw new PublicationError('unknown_action');
  const s=store(env);
  if(action==='status'){try{return await s.summary(args.run_id);}catch(error){if(/no such table/i.test(String(error?.message)))return {state:'not_initialized'};throw error;}}
  if(action==='preview'){if(!idOk(args.run_id))throw new PublicationError('invalid_run_id');const jobs=await s.preview(args.run_id),sample=jobs.find(j=>j.error_code==='product_isbn_or_domain_mismatch'&&/^(978|979)/.test(j.isbn));return {run_id:args.run_id,jobs,...(sample?{diagnostic:await api.inspectProduct(env,sample.isbn)}:{})};}
  if(action==='tick'){if(nonce){await initialize(env,s);await s.nonce(nonce.id,nonce.expires,now());}return tick(env,args.run_id);}
  await initialize(env,s);if(nonce)await s.nonce(nonce.id,nonce.expires,now());
  if(action==='begin_feed'){
   if(!idOk(args.feed_id)||!stockIsFresh(args.source_date,now())||!Number.isInteger(args.expected_rows)||args.expected_rows<1||args.expected_rows>200000)throw new PublicationError('invalid_feed');
   const existing=await s.feed(args.feed_id);if(existing){if(existing.source_date!==args.source_date||existing.expected_rows!==args.expected_rows)throw new PublicationError('feed_id_conflict',409);return {feed_id:existing.id,state:existing.state};}
   await s.beginFeed(args.feed_id,args.source_date,args.expected_rows,now());return {feed_id:args.feed_id,state:'importing'};
  }
  if(action==='import_feed'){
   if(!idOk(args.feed_id)||!Array.isArray(args.rows)||args.rows.length<1||args.rows.length>1000)throw new PublicationError('invalid_feed_chunk');
   const rows=args.rows.map(normalizeSupplierRow);if(new Set(rows.map(r=>r.isbn)).size!==rows.length)throw new PublicationError('duplicate_isbn_in_chunk');
   await s.importRows(args.feed_id,rows);return {feed_id:args.feed_id,accepted:rows.length};
  }
  if(action==='commit_feed'){if(!idOk(args.feed_id))throw new PublicationError('invalid_feed_id');const existing=await s.feed(args.feed_id);if(existing?.state==='ready')return {feed_id:existing.id,state:'ready'};const f=await s.commitFeed(args.feed_id);return {feed_id:f.id,state:f.state};}
  if(action==='create_run'){
   const policy=validPolicy(args.policy),feed=await s.feed(args.feed_id);
   if(!idOk(args.run_id)||feed?.state!=='ready'||!stockIsFresh(feed.source_date,now()))throw new PublicationError('invalid_run_or_stale_feed');
   const dailyCap=args.daily_cap??10000,preflightLimit=args.preflight_limit??10;
   if(!Number.isInteger(dailyCap)||dailyCap<1||dailyCap>10000||!Number.isInteger(preflightLimit)||preflightLimit<1||preflightLimit>20)throw new PublicationError('invalid_run_limits');
   const hash=await policyHash(policy),existing=await s.run(args.run_id);if(existing){if(existing.feed_id!==args.feed_id||existing.policy_hash!==hash)throw new PublicationError('run_id_conflict',409);return s.summary(args.run_id);}
   await s.createRun({id:args.run_id,feedId:args.feed_id,policy,policyHash:hash,now:now(),dailyCap,preflightLimit});return s.summary(args.run_id);
  }
  if(!idOk(args.run_id))throw new PublicationError('invalid_run_id');
  if(action==='attach_feed'){const f=await s.feed(args.feed_id);if(f?.state!=='ready'||!stockIsFresh(f.source_date,now()))throw new PublicationError('invalid_feed');await s.attachFeed(args.run_id,args.feed_id);return s.summary(args.run_id);}
  if(action==='pause'){await s.setRunState(args.run_id,'paused');return s.summary(args.run_id);}
  if(action==='approve'){
   if(String(env.ML_PUBLISHER_MODE)==='disabled')throw new PublicationError('publishing_disabled',409);
   const run=await s.run(args.run_id),feed=run?await s.feed(run.feed_id):null;
   if(!run||args.policy_hash!==run.policy_hash)throw new PublicationError('policy_hash_mismatch',409);
   if(!stockIsFresh(feed?.source_date,now()))throw new PublicationError('stale_feed',409);
   if(!(await s.counts(run.id)).some(x=>x.state==='validated'&&x.n>0))throw new PublicationError('no_validated_books',409);
   await s.approve(args.run_id,args.policy_hash);return s.summary(args.run_id);
  }
 }
 return {command,tick};
}

export const publicationService=createPublicationService();
