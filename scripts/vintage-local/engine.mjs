import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {readFullStock} from '../../astro-front/public/assets/meli-vintage-xlsx.mjs';
import {PublicationStore} from '../../worker-sync/publication-store.js';
import {createPublicationService} from '../../worker-sync/publication-engine.js';
import {createPublicationMeli,MercadoLibreError} from '../../worker-sync/publication-meli.js';
import {PublicationError,canonicalIsbn,stockIsFresh,quoteMercadoLibre,sha256,policyHash,normalizedTitle} from '../../worker-sync/publication-policy.js';
import {createSbsStock} from '../../worker-sync/sbs-supplier-stock.js';
import {VintageBulkStore,createVintageBulkFetch,BULK_RUN} from '../../functions/_shared/meli-vintage-bulk.js';
import {vintagePolicy} from '../../worker-sync/vintage-pricing.js';
import {openDatabase} from './db.mjs';
export const SELLER='2341378249';
const ENDPOINT='https://www.amadolibros.com/operations/vintage-local';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export function checkConfiguration(c){
 if(c?.version!==1||c.seller_id!==SELLER||c.app_id!=='4741021817925208'||c.run_id!==BULK_RUN||c.endpoint!==ENDPOINT||!/^[a-f0-9]{64}$/.test(c.key??''))throw new Error('invalid_vintage_connection');
 if(c.expires_at<=Date.now())throw new Error('vintage_connection_expired');
 const p=vintagePolicy(c.policy);if(p.minimumSaleUyu<1600||p.availabilityDays!==18)throw new Error('invalid_vintage_policy');return p;
}
export function makeBroker(c,{fetcher=fetch}={}){
 return async(action,args={})=>{
  const res=await fetcher(ENDPOINT,{method:'POST',headers:{Authorization:'Bearer '+c.key,'Content-Type':'application/json'},body:JSON.stringify({action,args}),redirect:'manual',signal:AbortSignal.timeout(45000)});
  let body;try{body=await res.json();}catch{throw new MercadoLibreError('local_broker_unavailable',503);}
  if(!res.ok)throw new MercadoLibreError(/^[a-z0-9_]{1,100}$/.test(body.error??'')?body.error:'local_broker_rejected',res.status);return body;
 };
}
function identifiers(item){
 const values=[item.seller_custom_field,...(item.attributes??[]).filter(a=>['ISBN','GTIN','EAN','SELLER_SKU'].includes(a.id)).flatMap(a=>[a.value_name,...(a.values??[]).map(x=>x.name)]),...(item.variations??[]).flatMap(v=>[v.seller_custom_field,...(v.attributes??[]).filter(a=>['ISBN','GTIN','SELLER_SKU'].includes(a.id)).map(a=>a.value_name)])];
 const set=new Set();for(const value of values)try{set.add(canonicalIsbn(String(value??'').replace(/^AMADO-AR-/,'')));}catch{}return [...set];
}
export function checkCreated(item,isbn,price){
 const term=(item?.sale_terms??[]).find(x=>x.id==='MANUFACTURING_TIME');
 if(String(item?.seller_id)!==SELLER||!identifiers(item).includes(isbn)||item.price!==price||item.price<1600||item.currency_id!=='UYU'||item.available_quantity!==1||item.status!=='active'||Number(term?.value_struct?.number??parseInt(term?.value_name,10))!==18)throw new MercadoLibreError('created_item_check_failed',409);
}
export async function inspectWorkbook(file){
 const bytes=await fs.readFile(file),input=readFullStock(bytes);
 return {...input,source_sha256:await sha256('vintage-bulk-positive-v1:'+await sha256(bytes))};
}
export async function run({excel,connection,directory,target=1000,validateOnly=0,limitNew=0,onStatus=console.log}){
 if(!Number.isInteger(target)||target<5||target>10000||!Number.isInteger(validateOnly)||validateOnly<0||validateOnly>5)throw new Error('invalid_local_limits');
 const c=JSON.parse(await fs.readFile(connection,'utf8')),policy=checkConfiguration(c);
 if(await policyHash(policy)!==c.policy_hash)throw new Error('connection_policy_changed');
 const input=await inspectWorkbook(excel);
 if(!stockIsFresh(input.source_date)||input.source_sha256!==c.source_sha256||Date.parse(input.source_date)!==Date.parse(c.source_date))throw new Error('workbook_does_not_match_current_approved_stock');
 await fs.mkdir(directory,{recursive:true});
 const db=openDatabase(path.join(directory,validateOnly?'validation.sqlite':'publisher.sqlite')),broker=makeBroker(c),env={ORDERS_DB:db,USER_ID:SELLER,APP_ID:c.app_id,ML_PUBLISHER_MODE:'enabled',ML_PUBLISH_QUEUE_ENABLED:'false'};
 let api,tokenCache=null;
 const limited=createVintageBulkFetch();
 api=createPublicationMeli({sellerId:SELLER,timeouts:{request:60000,create:60000},tokenProvider:async()=>{if(!tokenCache||tokenCache.expires_at<Date.now()+15000)tokenCache=await broker('token');return tokenCache.access_token;},tokenInvalidator:async(e,token)=>{tokenCache=null;await broker('invalidate',{access_token:token});},fetcher:(url,options)=>limited(env,url,options)});
 class LocalStore extends VintageBulkStore{
  async reserve(seller,isbn,runId,now,cap,lease){
   if(validateOnly)throw new Error('validation_cannot_reserve');
   const result=await broker('reserve',{isbn,policy_hash:c.policy_hash});
   if(!result.reserved){const r=result.receipt;if(r)await this.stmt('INSERT OR IGNORE INTO ml_pub_receipts VALUES(?,?,?,?,?,?,?)',SELLER,r.isbn,r.state,r.item_id??null,r.run_id,r.created_at,r.updated_at).run();return null;}
   return super.reserve(seller,isbn,runId,now,cap,lease);
  }
  async receiptState(seller,isbn,state,itemId=null){
   if(state==='published'){
    const row=await this.stock(c.feed_id,isbn);checkCreated(await api.call(env,'/items/'+itemId),isbn,quoteMercadoLibre(row,policy).price);
   }
   await broker('report',{isbn,state,...(itemId?{item_id:itemId}:{})});return super.receiptState(seller,isbn,state,itemId);
  }
 }
 const s=new LocalStore(db,{sellerId:SELLER});
 try{
  await new PublicationStore(db).initialize();await s.initialize();
  const supplier=createSbsStock();
  const feed=await supplier(env,'begin',{feed_id:c.feed_id,source_date:input.source_date,source_sha256:input.source_sha256,expected_rows:input.rows.length});
  if(feed.state!=='ready'){for(let i=0;i<input.rows.length;i+=200)await supplier(env,'import',{feed_id:c.feed_id,rows:input.rows.slice(i,i+200)});await supplier(env,'commit',{feed_id:c.feed_id});}
  for(const r of c.receipts??[]){if(r.seller_id!==SELLER)throw new Error('foreign_seller_receipt');await s.stmt('INSERT OR IGNORE INTO ml_pub_receipts VALUES(?,?,?,?,?,?,?)',SELLER,r.isbn,r.state,r.item_id??null,r.run_id,r.created_at,r.updated_at).run();}
  let existing=await s.run(BULK_RUN);
  if(existing&&existing.policy_hash!==c.policy_hash)throw new Error('local_policy_changed_review_required');
  if(existing&&existing.feed_id!==c.feed_id){
   await s.attachFeed(BULK_RUN,c.feed_id);
   await s.stmt("INSERT OR IGNORE INTO ml_pub_jobs(run_id,isbn,state) SELECT ?,isbn,'pending' FROM ml_pub_stock WHERE feed_id=?",BULK_RUN,c.feed_id).run();
  }
  if(existing&&!validateOnly&&['paused','auth_error','stock_stale'].includes(existing.state))await s.stmt("UPDATE ml_pub_runs SET state='publishing' WHERE id=? AND lease_until<?",BULK_RUN,Date.now()).run();
  if(!existing){
   await s.createRun({id:BULK_RUN,feedId:c.feed_id,policy,policyHash:c.policy_hash,now:Date.now()});
   for(const r of c.receipts??[])if(r.run_id===BULK_RUN)await s.job(BULK_RUN,r.isbn,r.state==='published'?'published':'uncertain',{itemId:r.item_id??undefined});
   if(validateOnly)await s.stmt("UPDATE ml_pub_runs SET state='preflight',approved_hash=NULL,preflight_limit=? WHERE id=?",validateOnly,BULK_RUN).run();
  }
  // Complete inventory scans persist locally; resume does not start again.
  const localApi={...api,async indexSlice(e,index){
   const next=structuredClone(index);
   if(!next.pending.length){
    const q=new URLSearchParams({search_type:'scan',limit:'100'});if(next.scroll)q.set('scroll_id',next.scroll);
    let page;try{page=await api.call(e,`/users/${SELLER}/items/search?${q}`);}catch(error){if(!next.scroll||![400,404,410].includes(error.status))throw error;q.delete('scroll_id');next.scroll=null;page=await api.call(e,`/users/${SELLER}/items/search?${q}`);}
    if(page.seller_id!==undefined&&String(page.seller_id)!==SELLER)throw new Error('inventory_seller_mismatch');
    if(page.results===null||Array.isArray(page.results)&&!page.results.length)return {index:{...next,done:true},items:[]};
    if(!Array.isArray(page.results)||page.results.some(x=>!/^MLU\d+$/.test(x)))throw new Error('inventory_invalid');
    next.pending=page.results;next.scroll=page.scroll_id??null;
   }
   const ids=next.pending.slice(0,100),items=[];
   for(let i=0;i<ids.length;i+=20){
    const group=ids.slice(i,i+20),result=await api.call(e,'/items/bulk?ids='+group.join(',')),remaining=new Set(group);
    if(!Array.isArray(result)||result.length!==group.length)throw new Error('inventory_incomplete');
    for(const r of result){const item=r.body;if((r.status_code??r.code)!==200||String(item?.seller_id)!==SELLER||!remaining.delete(item.id))throw new Error('inventory_item_invalid');
     const isbns=identifiers(item);items.push({id:item.id,isbn:isbns[0]??null,titleKey:normalizedTitle(item.title??item.family_name),status:item.status});
     for(const isbn of isbns)await db.prepare('INSERT OR IGNORE INTO ml_vintage_bulk_identifiers VALUES(?,?,?)').bind(BULK_RUN,isbn,item.id).run();
    }
   }
   return {index:{...next,pending:next.pending.slice(ids.length),seen:next.seen+items.length},items};
  },async skuItems(e,isbn){const ids=new Set(await api.skuItems(e,isbn)),q=new URLSearchParams({seller_sku:'AMADO-AR-'+isbn,limit:'100'}),result=await api.call(e,`/users/${SELLER}/items/search?${q}`);if(!Array.isArray(result.results)||result.results.some(x=>!/^MLU\d+$/.test(x)))throw new Error('sku_lookup_invalid');result.results.forEach(x=>ids.add(x));return [...ids];}};
  const service=createPublicationService({sellerId:SELLER,api:localApi,storeFactory:()=>s,maxJobsPerTick:1,maxIndexSlicesPerTick:1});
  const identity=await api.account(env);if(String(identity.id)!==SELLER)throw new Error('seller_mismatch');
  const start=5+await s.publishedCount(BULK_RUN);let batchStart=start;
  for(;;){
   const remote=await broker('status'),hasUncertain=(await s.counts(BULK_RUN)).some(x=>['creating','uncertain'].includes(x.state)&&x.n>0);if(remote.daily_created>=1000&&!validateOnly&&!hasUncertain){onStatus(JSON.stringify({state:'daily_cap_reached',published_total:remote.published_total}));break;}
   if(!validateOnly&&(remote.published_total>=target||limitNew&&remote.published_total-start>=limitNew))break;
   const result=await service.tick(env,BULK_RUN),summary=await s.summary(BULK_RUN),published=5+await s.publishedCount(BULK_RUN),status={at:new Date().toISOString(),seller_id:SELLER,mode:validateOnly?'validate_only':'publish',published_total:published,run:summary,state:result.state??summary.state};
   await fs.writeFile(path.join(directory,'status.json'),JSON.stringify(status,null,2));onStatus(JSON.stringify(status));
   if(validateOnly&&summary.state==='ready'||['stock_stale','auth_error','complete','complete_with_review'].includes(summary.state))break;
   const activeRun=await s.run(BULK_RUN);
   let wait=Math.max(1000,activeRun.backoff_until-Date.now(),result.state==='busy'?Math.min(15000,Math.max(1000,activeRun.lease_until-Date.now())):0,remote.daily_created>=1000?60000:0);
   if(published-batchStart>=25){batchStart=published;wait=Math.max(wait,60000);}
   if(wait>1000)onStatus(JSON.stringify({state:'waiting',seconds:Math.ceil(wait/1000)}));await pause(wait);
  }
  if(validateOnly)await fs.writeFile(path.join(directory,'items.preview.json'),JSON.stringify(await s.preview(BULK_RUN),null,2));
  return {state:(await s.run(BULK_RUN)).state,published_total:5+await s.publishedCount(BULK_RUN)};
 }finally{db.close();}
}
async function main(){
 const args=process.argv.slice(2),get=name=>args[args.indexOf(name)+1];
 if(args.includes('--inspect')){const x=await inspectWorkbook(get('--excel'));console.log(JSON.stringify({source_date:x.source_date,rows:x.rows.length,rejected:x.rejected,duplicate_isbns:x.duplicate_isbns,source_sha256:x.source_sha256,fresh:stockIsFresh(x.source_date)}));return;}
 const result=await run({excel:get('--excel'),connection:get('--connection'),directory:get('--directory'),target:Number(args.includes('--target')?get('--target'):1000),validateOnly:Number(args.includes('--validate-only')?get('--validate-only'):0),limitNew:Number(args.includes('--limit-new')?get('--limit-new'):0)});console.log(JSON.stringify({finished:true,...result}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(JSON.stringify({error:error.code??error.message??'local_failure',stage:error.stage??null,status:error.status??null}));process.exitCode=1;});
