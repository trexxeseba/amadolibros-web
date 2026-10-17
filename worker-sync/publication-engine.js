import {APP_ID,SELLER_ID,PublicationError,canonicalIsbn,hasSupplierStock,normalizeSupplierRow,validPolicy,policyHash,quoteMercadoLibre,stockIsFresh,safeCode,sha256} from './publication-policy.js';
import {PublicationStore} from './publication-store.js';
import {createPublicationMeli,MercadoLibreError,payloadPolicyMismatch} from './publication-meli.js';
import {enqueuePublicationWork} from './publication-queue.js';
const initialized=new WeakSet();
const idOk=id=>typeof id==='string'&&/^[a-f0-9-]{36}$/.test(id);
const IDENTITY_SKIP=new Set(['catalog_required_needs_review','ambiguous_product_metadata','product_identity_mismatch','catalog_product_id_mismatch','catalog_product_inactive','catalog_product_children_unresolved','book_identifier_required','missing_verified_book_metadata','ambiguous_supplier_book_metadata','supplier_book_identity_mismatch','book_binding_mismatch']);
const CATEGORY_SKIP=new Set(['missing_book_category','ambiguous_book_category','category_not_leaf_or_not_allowed']);
const STOCK_SKIP=new Set(['supplier_stock_conflict']);
const ML_REQUIREMENT_SKIP=new Set(['ml_http_400','shipping_not_validated','isbn_attribute_missing','missing_verified_cover','incomplete_supplier_book_metadata']);
export function candidateSkipState(error){
 const code=safeCode(error);
 if(IDENTITY_SKIP.has(code))return 'skipped_identity';
 if(CATEGORY_SKIP.has(code))return 'skipped_category';
 if(STOCK_SKIP.has(code))return 'skipped_stock_uncertain';
 if(ML_REQUIREMENT_SKIP.has(code))return 'skipped_ml_requirement';
 return null;
}
// Admin-only actions (SYNC_SECRET): never reachable through the signed Operations envelope.
export const ADMIN_ONLY_ACTIONS=['clone_preflight_catalog','shipping_diagnostic','shipping_probe','create_run_from_source','audit_availability_terms','queue_kick','pause_run_publications'];
export const CLONE_PREFLIGHT_SOURCE_CODE='catalog_required_needs_review';
const CLONE_PREFLIGHT_TICKS=6;
// A clone over an alternative fresh feed is a small, targeted preflight.
export const CLONE_PREFLIGHT_FRESH_FEED_LIMIT=5;
// Deterministic run id: repeating the same request finds the same clone instead of creating another.
// An alternative feed is part of the identity, so it never collides with a clone over the source feed.
export async function clonePreflightRunId(sourceRunId,policyHashValue,limit,feedId=null){const h=await sha256(`clone_preflight_catalog:${sourceRunId}:${policyHashValue}:${limit}${feedId?`:${feedId}`:''}`);return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;}
export async function createRunFromSourceId(sourceRunId,policyHashValue,feedId,dailyCap,preflightLimit,targetPublished=null){const h=await sha256(`create_run_from_source:${sourceRunId}:${policyHashValue}:${feedId}:${dailyCap}:${preflightLimit}:${targetPublished??'none'}`);return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;}
export function clonePreflightJob(job){
 const p=job.payload&&typeof job.payload==='object'?job.payload:{};
 return {isbn:job.isbn,state:job.state,error_code:job.error_code??null,title:p.title??p.family_name??null,price:typeof p.price==='number'?p.price:null,catalog_listing:typeof p.catalog_listing==='boolean'?p.catalog_listing:null,catalog_product_id:p.catalog_product_id??null,validation:p.diagnostic??null};
}
const runFingerprint=run=>run?JSON.stringify({feed_id:run.feed_id,policy_json:run.policy_json,policy_hash:run.policy_hash,approved_hash:run.approved_hash??null,daily_cap:run.daily_cap,preflight_limit:run.preflight_limit}):null;

export function createPublicationService({api=createPublicationMeli(),storeFactory=env=>new PublicationStore(env.ORDERS_DB),now=Date.now,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),attachWaitMs=25000}={}){
 function store(env){if(String(env.USER_ID)!==SELLER_ID||String(env.APP_ID)!==APP_ID)throw new PublicationError('seller_configuration_mismatch',503);return storeFactory(env);}
 async function initialize(env,s){if(!initialized.has(env.ORDERS_DB)){await s.initialize();if(env.ORDERS_DB&&typeof env.ORDERS_DB==='object')initialized.add(env.ORDERS_DB);}}
 async function tick(env,runId){
  if(String(env.ML_PUBLISHER_MODE)==='disabled')return {state:'disabled'};
  const s=store(env);let run;
  try{run=runId?await s.run(runId):(await s.activeRun()??await s.reconcilableRun(now()));}catch(error){if(/no such table/i.test(String(error?.message)))return {state:'not_initialized'};throw error;}
  if(!run)return {state:'no_active_run'};
  if(!['preflight','publishing','complete_with_review'].includes(run.state))return s.summary(run.id);
  if(run.backoff_until>now())return {id:run.id,state:'backoff',resume_at:new Date(run.backoff_until).toISOString()};
  const lease=crypto.randomUUID();run=await s.lease(run.id,lease,now());if(!run)return {state:'busy'};
  const deadline=now()+20000;let processed=0;
  const mark=(isbn,state,options={})=>s.job(run.id,isbn,state,{...options,leaseToken:lease,now:now()});
  const state=value=>s.setRunState(run.id,value,lease,now());
  try{
   // Reconcile creates whose outcome was lost before anything else, regardless of
   // the supplier snapshot: by stable SKU, with backoff, and never with a new POST.
   for(const job of await s.interrupted(run.id,now())){
    const receipt=await s.receipt(SELLER_ID,job.isbn);
    if(receipt?.state==='published'){await mark(job.isbn,'published',{itemId:receipt.item_id});continue;}
    const found=await api.skuItems(env,job.isbn);
    if(found.length===1){await s.receiptState(SELLER_ID,job.isbn,'published',found[0]);await mark(job.isbn,'published',{itemId:found[0]});continue;}
    await mark(job.isbn,'uncertain',{errorCode:job.error_code??'interrupted_create',nextAt:now()+Math.min(6*3600000,600000*2**Math.min(job.attempts,6)),attempt:true});
   }
   if(run.state==='complete_with_review'){await s.finishReview(run.id,lease,now());return s.summary(run.id);}
   const feed=await s.feed(run.feed_id);
   if(feed?.state!=='ready'||!stockIsFresh(feed.source_date,now())){await state('stock_stale');return {state:'stock_stale'};}
   let index=JSON.parse(run.index_json);
   while(!index.done&&now()<deadline&&processed<20){const slice=await api.indexSlice(env,index);index=await s.saveIndex(run.id,slice.index,slice.items,lease,now());processed++;}
   if(!index.done)return s.summary(run.id);
   const policy=validPolicy(JSON.parse(run.policy_json));
   await s.retryLegacyIdentityReviews(run.id,lease,now());
   const publishing=run.state==='publishing'&&run.approved_hash===run.policy_hash;
   if(run.state==='publishing'&&!publishing)return {state:'publishing_not_enabled'};
   if(publishing&&await s.dayCreated(now())>=run.daily_cap)return {state:'daily_cap_reached'};
   const target=await s.target(run.id);
   const finishTarget=async()=>{
    if(!publishing||!target)return false;
    if(await s.publishedCount(run.id)<target.target_published)return false;
    await s.skipRemainingAtTarget(run.id,lease,now());
    const terminal=await s.counts(run.id),needsReview=terminal.some(x=>['review','uncertain','creating'].includes(x.state)&&x.n>0);
    await state(needsReview?'complete_with_review':'complete');
    return true;
   };
   if(await finishTarget())return s.summary(run.id);
   const counts=await s.counts(run.id);let validated=counts.find(x=>x.state==='validated')?.n??0;
   if(!publishing&&validated>=run.preflight_limit){await state('ready');return s.summary(run.id);}
   processed=0;
   while(now()<deadline&&processed<10){
    if(await finishTarget())break;
    const job=await s.nextJob(run.id,now(),publishing);if(!job){if(!await s.unfinished(run.id,publishing)){const terminal=await s.counts(run.id),needsReview=terminal.some(x=>['review','uncertain'].includes(x.state)&&x.n>0);await state(publishing?(needsReview?'complete_with_review':'complete'):'ready');}break;}
    processed++;
    try{
     const freshRun=await s.run(run.id),freshFeed=await s.feed(freshRun.feed_id);
     if(freshFeed?.state!=='ready'||!stockIsFresh(freshFeed.source_date,now())){await state('stock_stale');break;}
     const row=await s.stock(freshRun.feed_id,job.isbn);
     if(!row||!hasSupplierStock(row.stock)){await mark(job.isbn,'skipped_stock_uncertain');continue;}
     normalizeSupplierRow(row);
     const receipt=await s.receipt(SELLER_ID,row.isbn);
     if(receipt){const own=receipt.run_id===run.id;if(receipt.state==='published'){await mark(row.isbn,own?'published':'skipped_duplicate',{itemId:receipt.item_id,errorCode:own?null:'existing_published_receipt'});}else await mark(row.isbn,'uncertain',{itemId:receipt.item_id,errorCode:'existing_create_receipt'});continue;}
     const duplicate=await s.existing(run.id,row.isbn,row.title);
     if(duplicate){await mark(row.isbn,'skipped_duplicate',{itemId:duplicate.item_id,errorCode:duplicate.isbn===row.isbn?null:'possible_title_duplicate'});continue;}
     const bySku=await api.skuItems(env,row.isbn);
     if(bySku.length){await mark(row.isbn,'skipped_duplicate',{itemId:bySku[0]});continue;}
     const quote=quoteMercadoLibre(row,policy);
     let payload=job.payload_json?JSON.parse(job.payload_json):null;
     if(!payload||payload.price!==quote.price)payload=await api.prepare(env,row,policy,quote.price);
     if(!publishing){await mark(row.isbn,'validated',{payload});validated++;if(validated>=run.preflight_limit){await state('ready');break;}continue;}
     // Check the source snapshot, run state and lease again after preparation.
     const guardRun=await s.run(run.id),guardRow=await s.stock(guardRun.feed_id,row.isbn),guardFeed=await s.feed(guardRun.feed_id);
     if(guardRun.state!=='publishing'||guardRun.approved_hash!==run.policy_hash||!await s.ownsLease(run.id,lease,now()))break;
     if(!guardRow||!hasSupplierStock(guardRow.stock)||!stockIsFresh(guardFeed?.source_date,now())){await mark(row.isbn,'skipped_stock_uncertain');continue;}
     if(quoteMercadoLibre(guardRow,policy).price!==payload.price){await mark(row.isbn,'pending',{payload:null});continue;}
     // A catalog payload is only created under the approved 'required_only' policy.
     const mismatch=payloadPolicyMismatch(payload,policy);if(mismatch){await mark(row.isbn,'review',{errorCode:mismatch});continue;}
     const reserved=await s.reserve(SELLER_ID,row.isbn,run.id,now(),run.daily_cap,lease);
     if(!reserved){const existing=await s.receipt(SELLER_ID,row.isbn);if(existing){const own=existing.run_id===run.id;if(existing.state==='published')await mark(row.isbn,own?'published':'skipped_duplicate',{itemId:existing.item_id,errorCode:own?null:'existing_published_receipt'});else await mark(row.isbn,'uncertain',{itemId:existing.item_id,errorCode:'receipt_already_reserved'});}else return {state:'daily_cap_reached'};continue;}
     await mark(row.isbn,'creating',{payload,attempt:true});
     let result;
     try{result=await api.create(env,payload,policy);}
     catch(error){await s.receiptState(SELLER_ID,row.isbn,'uncertain');await mark(row.isbn,'uncertain',{errorCode:safeCode(error)});if(error.status===429){await s.backoff(run.id,now()+Math.max(60000,error.retryAfter*1000||0),lease);break;}continue;}
     await s.receiptState(SELLER_ID,row.isbn,'published',result.id);
     await mark(row.isbn,'published',{itemId:result.id});
    }catch(error){
     // Transport, 5xx, 429 and retryable auth failures defer the book; an auth
     // failure never counts as a book attempt nor sends it to review.
     const auth=error instanceof MercadoLibreError&&(error.status===401||error.status===403);
     const retry=error instanceof MercadoLibreError&&(error.status===429||error.status>=500)&&job.attempts<5;
     const nextAt=retry?now()+Math.max(error.retryAfter*1000,Math.min(3600000,30000*2**job.attempts)):0;
     const skipState=!retry&&!auth?candidateSkipState(error):null;
     await mark(job.isbn,retry||auth?'retry':skipState??'review',{errorCode:safeCode(error),nextAt,attempt:!auth,...(error instanceof MercadoLibreError&&error.stage?{payload:{diagnostic:{stage:error.stage,validation_codes:error.validationCodes??[],...(error.validationCauses?.length?{causes:error.validationCauses}:{}),...(error.shippingAttempts?{shipping_attempts:error.shippingAttempts}:{})}}}:{})});
     if(auth){await state('auth_error');break;}
     if(error.status===429){await s.backoff(run.id,nextAt,lease);break;}
    }
   }
   return s.summary(run.id);
  }catch(error){
   if(error.status===429){const until=now()+Math.max(60000,error.retryAfter*1000||0);await s.backoff(run.id,until,lease);return {id:run.id,state:'backoff',resume_at:new Date(until).toISOString()};}
   // Retryable auth failures (lock busy, upstream 5xx) simply wait for the next tick.
   if(error instanceof MercadoLibreError&&(error.status===401||error.status===403)){await state('auth_error');return {id:run.id,state:'auth_error',error:safeCode(error)};}
   throw error;}
  finally{await s.release(run.id,lease);}
 }
 async function command(env,action,args={},nonce=null){
  if(!['begin_feed','import_feed','commit_feed','create_run','attach_feed','status','tick','pause','approve','preview',...ADMIN_ONLY_ACTIONS].includes(action))throw new PublicationError('unknown_action');
  // A signed (non-admin) request carries a nonce; admin requests never do.
  if(ADMIN_ONLY_ACTIONS.includes(action)&&nonce)throw new PublicationError('admin_only_action',403);
  const s=store(env);
  // Read-only: GET lookups of the account's shipping configuration, no D1 writes.
  if(action==='shipping_diagnostic'){
   const itemPrice=args.item_price==null?null:Number(args.item_price),weightKg=args.weight_kg==null?.495:Number(args.weight_kg);
   if(args.item_id!=null&&!/^MLU\d+$/.test(String(args.item_id)))throw new PublicationError('invalid_item_id');
   if((itemPrice!==null&&!(itemPrice>0&&itemPrice<10000000))||!(weightKg>0&&weightKg<=30)||(args.logistic_type!=null&&!/^[a-z_]{2,40}$/.test(String(args.logistic_type))))throw new PublicationError('invalid_diagnostic_args');
   const result=await api.shippingDiagnostic(env,{itemId:args.item_id??null,itemPrice,weightKg,categoryId:args.category_id??'MLU1196',logisticType:args.logistic_type??null});
   // What the prepared payload sends today, including "Disponibilidad de stock"
   // (MANUFACTURING_TIME) from the run's policy, to compare with the account.
   let availabilityDays=null;
   if(args.run_id!=null){if(!idOk(args.run_id))throw new PublicationError('invalid_run_id');const run=await s.run(args.run_id);if(!run)throw new PublicationError('run_not_found',404);availabilityDays=validPolicy(JSON.parse(run.policy_json)).availabilityDays??null;}
   return {...result,current_payload:{shipping:'resolved by /items/validate over shipping_variants',sale_terms:availabilityDays?[{id:'MANUFACTURING_TIME',value_name:`${availabilityDays} días`}]:(args.run_id!=null?[]:null)},read_only_mercado_libre:true};
  }
  if(action==='pause_run_publications'){
   if(!idOk(args.run_id))throw new PublicationError('invalid_run_id');
   const run=await s.run(args.run_id);if(!run)throw new PublicationError('run_not_found',404);
   const offset=args.offset??0,limit=args.limit??50;
   if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>50)throw new PublicationError('invalid_pause_args');
   await api.account(env);
   const rows=await s.publishedItems(run.id,offset,limit);
   if(!rows.length)return {run_id:run.id,offset,scanned:0,paused:0,already_paused:0,next_offset:null};
   const groups=[];for(let i=0;i<rows.length;i+=20)groups.push(rows.slice(i,i+20));
   const verified=(await Promise.all(groups.map(async group=>{
    const raw=await api.call(env,'/items/bulk?ids='+group.map(x=>x.item_id).join(','));
    if(!Array.isArray(raw)||raw.length!==group.length)throw new PublicationError('pause_audit_incomplete',502);
    const expected=new Set(group.map(x=>x.item_id));
    return raw.map(entry=>{
     const body=entry?.body,status=entry?.status_code??entry?.code;
     if(status!==200||!body||String(body.seller_id)!==SELLER_ID||!expected.has(body.id))throw new PublicationError('pause_audit_invalid',502);
     if(!/^AMADO-AR-\d{13}$/.test(String(body.seller_custom_field||'')))throw new PublicationError('pause_scope_mismatch',409);
     return {id:body.id,status:body.status};
    });
   }))).flat();
   let paused=0,already=0;
   for(const item of verified){
    if(item.status==='paused'){already++;continue;}
    if(item.status!=='active')throw new PublicationError('pause_status_mismatch',409);
    await api.call(env,'/items/'+item.id,{method:'PUT',body:{status:'paused'}});
    paused++;
   }
   return {run_id:run.id,offset,scanned:verified.length,paused,already_paused:already,next_offset:rows.length===limit?offset+rows.length:null};
  }
  if(action==='audit_availability_terms'){
   if(!idOk(args.run_id))throw new PublicationError('invalid_run_id');
   const run=await s.run(args.run_id);if(!run)throw new PublicationError('run_not_found',404);
   const policy=validPolicy(JSON.parse(run.policy_json)),expectedDays=args.expected_days??policy.availabilityDays;
   const offset=args.offset??0,limit=args.limit??100;
   if(!Number.isInteger(expectedDays)||expectedDays<1||expectedDays>60||!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>200)throw new PublicationError('invalid_audit_args');
   const rows=await s.publishedItems(run.id,offset,limit),total=await s.publishedCount(run.id);
   const groups=[];for(let i=0;i<rows.length;i+=20)groups.push(rows.slice(i,i+20));
   const checked=(await Promise.all(groups.map(async group=>{
    const ids=group.map(x=>x.item_id);
    const raw=await api.call(env,'/items/bulk?ids='+ids.join(','));
    if(!Array.isArray(raw)||raw.length!==ids.length)throw new PublicationError('availability_audit_incomplete',502);
    const byId=new Map(group.map(x=>[x.item_id,x.isbn]));
    return raw.map(entry=>{
     const body=entry?.body,status=entry?.status_code??entry?.code;
     if(status!==200||!body||String(body.seller_id)!==SELLER_ID||!byId.has(body.id))throw new PublicationError('availability_audit_invalid',502);
     const term=(Array.isArray(body.sale_terms)?body.sale_terms:[]).find(t=>t?.id==='MANUFACTURING_TIME')??null;
     const value=term?.value_name??term?.value_struct?.number??null;
     const parsed=typeof value==='number'?value:Number((String(value??'').match(/\d+/)||[])[0]??NaN);
     const actualDays=Number.isFinite(parsed)?parsed:null;
     return {isbn:byId.get(body.id),item_id:body.id,actual_days:actualDays,has_term:!!term,ok:actualDays===expectedDays};
    });
   }))).flat();
   const mismatches=checked.filter(x=>!x.ok);
   return {run_id:run.id,expected_days:expectedDays,total_published:total,offset,scanned:checked.length,ok:checked.length-mismatches.length,missing:mismatches.filter(x=>!x.has_term).length,wrong:mismatches.filter(x=>x.has_term).length,mismatches:mismatches.slice(0,50),next_offset:offset+checked.length<total?offset+checked.length:null,read_only_mercado_libre:true};
  }
  if(action==='shipping_probe'){
   // The queue's own prepare() on one supplier row of a run: GET lookups and
   // /items/validate only, nothing stored, never POST /items.
   if(!idOk(args.run_id))throw new PublicationError('invalid_run_id');
   const run=await s.run(args.run_id);if(!run)throw new PublicationError('run_not_found',404);
   const feedId=args.feed_id??run.feed_id;if(!idOk(feedId))throw new PublicationError('invalid_feed_id');
   const isbn=canonicalIsbn(args.isbn),row=await s.stock(feedId,isbn);if(!row)throw new PublicationError('isbn_not_in_feed',404);
   normalizeSupplierRow(row);const policy=validPolicy(JSON.parse(run.policy_json));
   const result=await api.shippingProbe(env,row,policy,quoteMercadoLibre(row,policy).price);
   return {run_id:run.id,feed_id:feedId,isbn,policy_hash:run.policy_hash,availability_days:policy.availabilityDays,...result,read_only_mercado_libre:true};
  }
  if(action==='create_run_from_source'){
   // Production-sized run over a fresh supplier feed, reusing the source run's
   // exact commercial policy and overriding only explicitly reviewed fields.
   // It always starts unapproved in preflight; this action never publishes.
   if(!idOk(args.source_run_id)||!idOk(args.feed_id))throw new PublicationError('invalid_run_id');
   const source=await s.run(args.source_run_id);if(!source)throw new PublicationError('source_run_not_found',404);
   const sourceBefore=runFingerprint(source),sourceJobsBefore=JSON.stringify(await s.counts(source.id));
   const availabilityDays=args.availability_days??null;
   if(availabilityDays!==null&&(!Number.isInteger(availabilityDays)||availabilityDays<1||availabilityDays>60))throw new PublicationError('invalid_availability_days');
   const dailyCap=args.daily_cap??1000,preflightLimit=args.preflight_limit??20,targetPublished=args.target_published??null;
   if(!Number.isInteger(dailyCap)||dailyCap<1||dailyCap>10000||!Number.isInteger(preflightLimit)||preflightLimit<1||preflightLimit>20||(targetPublished!==null&&(!Number.isInteger(targetPublished)||targetPublished<1||targetPublished>10000)))throw new PublicationError('invalid_run_limits');
   const policy=validPolicy({...JSON.parse(source.policy_json),catalogListing:'required_only',...(availabilityDays!==null?{availabilityDays}:{})});
   const hash=await policyHash(policy);
   let feed=await s.feed(args.feed_id);
   if(!feed||!['ready','importing'].includes(feed.state)||!stockIsFresh(feed.source_date,now()))throw new PublicationError('invalid_run_or_stale_feed');
   if(feed.state==='importing')feed=await s.commitFeed(feed.id);
   if(targetPublished!==null&&targetPublished>feed.expected_rows)throw new PublicationError('target_exceeds_feed',422);
   const newId=args.new_run_id??await createRunFromSourceId(source.id,hash,feed.id,dailyCap,preflightLimit,targetPublished);
   if(!idOk(newId))throw new PublicationError('invalid_run_id');
   let run=await s.run(newId),created=false;
   if(run){
    const existingTarget=(await s.target(newId))?.target_published??null;
    if(run.feed_id!==feed.id||run.policy_hash!==hash||run.daily_cap!==dailyCap||run.preflight_limit!==preflightLimit||existingTarget!==targetPublished)throw new PublicationError('run_id_conflict',409);
   }else{
    await s.createRun({id:newId,feedId:feed.id,policy,policyHash:hash,now:now(),dailyCap,preflightLimit,targetPublished});created=true;
   }
   const sourceAfter=await s.run(source.id),summary=await s.summary(newId);
   return {...summary,new_run_id:newId,source_run_id:source.id,created,feed_id:feed.id,availability_days:policy.availabilityDays,catalog_listing:policy.catalogListing,target_published:targetPublished,source_policy_hash:source.policy_hash,source_run_intact:runFingerprint(sourceAfter)===sourceBefore&&JSON.stringify(await s.counts(source.id))===sourceJobsBefore};
  }
  if(action==='status'){try{return await s.summary(args.run_id);}catch(error){if(/no such table/i.test(String(error?.message)))return {state:'not_initialized'};throw error;}}
  if(action==='queue_kick'){
   if(!idOk(args.run_id))throw new PublicationError('invalid_run_id');
   const run=await s.run(args.run_id);if(!run)throw new PublicationError('run_not_found',404);
   if(run.state!=='publishing'||run.approved_hash!==run.policy_hash)throw new PublicationError('run_not_publishing',409);
   return {run_id:run.id,...await enqueuePublicationWork(env,run.id)};
  }
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
   const dailyCap=args.daily_cap??10000,preflightLimit=args.preflight_limit??10,targetPublished=args.target_published??null;
   if(!Number.isInteger(dailyCap)||dailyCap<1||dailyCap>10000||!Number.isInteger(preflightLimit)||preflightLimit<1||preflightLimit>20||(targetPublished!==null&&(!Number.isInteger(targetPublished)||targetPublished<1||targetPublished>10000))||(targetPublished!==null&&targetPublished>feed.expected_rows))throw new PublicationError('invalid_run_limits');
   const hash=await policyHash(policy),existing=await s.run(args.run_id);
   if(existing){const existingTarget=(await s.target(args.run_id))?.target_published??null;if(existing.feed_id!==args.feed_id||existing.policy_hash!==hash||existingTarget!==targetPublished)throw new PublicationError('run_id_conflict',409);return s.summary(args.run_id);}
   await s.createRun({id:args.run_id,feedId:args.feed_id,policy,policyHash:hash,now:now(),dailyCap,preflightLimit,targetPublished});return s.summary(args.run_id);
  }
  if(action==='clone_preflight_catalog'){
   // Preflight of Catálogo obligatorio over the ISBNs a source run left in review,
   // with the source policy cloned field by field except catalogListing. The clone
   // starts unapproved and this action only ticks it in preflight: GET lookups and
   // /items/validate, never POST /items. The source run is read, never written.
   // An optional feed_id runs the clone over a fresh supplier snapshot instead of
   // the source feed; the source run keeps its own feed untouched.
   if(!idOk(args.source_run_id))throw new PublicationError('invalid_run_id');
   const freshFeedId=args.feed_id??null;if(freshFeedId!==null&&!idOk(freshFeedId))throw new PublicationError('invalid_feed_id');
   const maxLimit=freshFeedId?CLONE_PREFLIGHT_FRESH_FEED_LIMIT:20;
   const limit=args.limit??Math.min(10,maxLimit);if(!Number.isInteger(limit)||limit<1||limit>maxLimit)throw new PublicationError('invalid_run_limits');
   const source=await s.run(args.source_run_id);if(!source)throw new PublicationError('source_run_not_found',404);
   const sourceBefore=runFingerprint(source),sourceJobsBefore=JSON.stringify(await s.counts(source.id));
   // Optional explicit availability override: part of the cloned policy, so the
   // policy_hash (and the human approval) covers exactly those days.
   const availabilityDays=args.availability_days??null;
   if(availabilityDays!==null&&(!Number.isInteger(availabilityDays)||availabilityDays<1||availabilityDays>60))throw new PublicationError('invalid_availability_days');
   const policy=validPolicy({...JSON.parse(source.policy_json),catalogListing:'required_only',...(availabilityDays!==null?{availabilityDays}:{})});
   const hash=await policyHash(policy);if(hash===source.policy_hash)throw new PublicationError('source_policy_already_catalog',409);
   const feedId=freshFeedId??source.feed_id;
   let feed=await s.feed(feedId);
   if(!feed||!['ready','importing'].includes(feed.state)||(feed.state==='importing'&&!freshFeedId)||!stockIsFresh(feed.source_date,now()))throw new PublicationError('invalid_run_or_stale_feed');
   // A fresh feed still importing is closed only when every expected row is loaded.
   if(feed.state==='importing')feed=await s.commitFeed(feedId);
   const newId=await clonePreflightRunId(source.id,hash,limit,freshFeedId);
   let run=await s.run(newId),created=false;
   if(run){if(run.feed_id!==feedId||run.policy_hash!==hash)throw new PublicationError('run_id_conflict',409);}
   else{
    const isbns=await s.catalogReviewCandidates(source.id,limit);if(!isbns.length)throw new PublicationError('no_catalog_review_candidates',409);
    if(freshFeedId)for(const isbn of isbns){const row=await s.stock(feedId,isbn);if(!row||!hasSupplierStock(row.stock))throw new PublicationError('fresh_feed_missing_stock',409);}
    await s.cloneRun({id:newId,feedId,policy,policyHash:hash,now:now(),dailyCap:limit,preflightLimit:limit,indexJson:source.index_json,sourceId:source.id},isbns);created=true;
   }
   // Bounded preflight ticks; a busy lease or any terminal state ends them.
   let last=null;for(let i=0;i<CLONE_PREFLIGHT_TICKS;i++){last=await tick(env,newId);if(!['preflight'].includes(last.state))break;}
   run=await s.run(newId);const jobs=(await s.jobs(newId)).map(clonePreflightJob);
   const count=state=>jobs.filter(j=>j.state===state).length;
   const sourceAfter=await s.run(source.id);
   return {new_run_id:newId,source_run_id:source.id,created,feed_id:feedId,source_feed_id:source.feed_id,availability_days:policy.availabilityDays,policy_hash:hash,source_policy_hash:source.policy_hash,catalog_listing:policy.catalogListing,state:run.state,approved:run.approved_hash===run.policy_hash,preflight_limit:run.preflight_limit,
    selected_isbns:jobs.map(j=>j.isbn),preflight:jobs,validated:count('validated'),review:count('review'),pending:count('pending')+count('retry'),published:count('published'),last_tick:last?.state??null,
    source_run_intact:runFingerprint(sourceAfter)===sourceBefore&&JSON.stringify(await s.counts(source.id))===sourceJobsBefore,read_only_mercado_libre:true};
  }
  if(!idOk(args.run_id))throw new PublicationError('invalid_run_id');
  if(action==='attach_feed'){
   const f=await s.feed(args.feed_id);if(f?.state!=='ready'||!stockIsFresh(f.source_date,now()))throw new PublicationError('invalid_feed');
   // The tick holds the lease for a bounded time: wait for it instead of losing the daily snapshot.
   const deadline=now()+attachWaitMs;
   for(;;){try{await s.attachFeed(args.run_id,args.feed_id);break;}catch(error){if(error?.code!=='run_busy'||now()>=deadline)throw error;await sleep(1000);}}
   const summary=await s.summary(args.run_id);if(summary.state==='publishing')await enqueuePublicationWork(env,args.run_id);return summary;
  }
  if(action==='pause'){await s.setRunState(args.run_id,'paused');return s.summary(args.run_id);}
  if(action==='approve'){
   if(String(env.ML_PUBLISHER_MODE)==='disabled')throw new PublicationError('publishing_disabled',409);
   const run=await s.run(args.run_id),feed=run?await s.feed(run.feed_id):null;
   if(!run||args.policy_hash!==run.policy_hash)throw new PublicationError('policy_hash_mismatch',409);
   if(!stockIsFresh(feed?.source_date,now()))throw new PublicationError('stale_feed',409);
   if(!(await s.counts(run.id)).some(x=>x.state==='validated'&&x.n>0))throw new PublicationError('no_validated_books',409);
   await s.approve(args.run_id,args.policy_hash);await enqueuePublicationWork(env,args.run_id);return s.summary(args.run_id);
  }
 }
 return {command,tick};
}

export const publicationService=createPublicationService();
