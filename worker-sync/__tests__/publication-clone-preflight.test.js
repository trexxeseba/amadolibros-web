import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sqliteD1} from './helpers/sqlite-d1.js';
import {PublicationStore} from '../publication-store.js';
import {createPublicationService,clonePreflightRunId,clonePreflightJob,ADMIN_ONLY_ACTIONS} from '../publication-engine.js';
import {policyHash,validPolicy,quoteMercadoLibre,PublicationError} from '../publication-policy.js';
import {MercadoLibreError} from '../publication-meli.js';

const policy={supplierDiscount:.2,arsPerUyu:40,usdPerUyu:40,freightUsdKg:10,laborUyu:0,margin:.2,mlFee:.15,deliveryUyu:200,minimumContributionUyu:100,minimumSaleUyu:1000,roundUyu:10,availabilityDays:10,additionalPricePct:0,listingTypeId:'gold_special'};
const SOURCE_CODE='catalog_required_needs_review';
// Twelve catalog-required books in review plus books blocked for other reasons.
const isbn=n=>{const stem='97895023'+String(n).padStart(4,'0');const check=(10-[...stem].reduce((s,c,i)=>s+Number(c)*(i%2?3:1),0)%10)%10;return stem+check;};
const catalogBooks=Array.from({length:12},(_,i)=>({isbn:isbn(i+1),title:`Libro catálogo ${i+1}`,listArs:10000+i*100,weightKg:.2,stock:'+2'}));
const otherBooks=[
 {isbn:isbn(101),title:'Libro stock conflict',listArs:12000,weightKg:.2,stock:'+1',code:'possible_title_duplicate'},
 {isbn:isbn(102),title:'Libro metadata ambigua',listArs:12000,weightKg:.2,stock:'+1',code:'ambiguous_product_metadata'},
 {isbn:isbn(103),title:'Libro binding mismatch - HB',listArs:12000,weightKg:.2,stock:'+1',code:'book_binding_mismatch'},
 {isbn:isbn(104),title:'Libro sin categoría',listArs:12000,weightKg:.2,stock:'+1',code:'missing_book_category'},
 {isbn:isbn(105),title:'Libro identidad',listArs:12000,weightKg:.2,stock:'+1',code:'product_identity_mismatch'},
];
const validatedBook={isbn:isbn(201),title:'Libro tradicional validado',listArs:9000,weightKg:.2,stock:'+1'};
const rows=[...catalogBooks,...otherBooks.map(({code,...row})=>row),validatedBook];

async function fixture(t,{failValidate=new Set(),apiOverrides={}}={}){
 const dir=await mkdtemp(join(tmpdir(),'amado-clone-preflight-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const db=sqliteD1(join(dir,'queue.sqlite')),store=new PublicationStore(db),now=Date.now(),feedId=crypto.randomUUID(),sourceId=crypto.randomUUID();
 const env={ORDERS_DB:db,USER_ID:'440298103',APP_ID:'4741021817925208',ML_PUBLISHER_MODE:'enabled'};
 await store.initialize();await store.beginFeed(feedId,new Date(now).toISOString(),rows.length,now);await store.importRows(feedId,rows);await store.commitFeed(feedId);
 await store.createRun({id:sourceId,feedId,policy,policyHash:await policyHash(policy),now,dailyCap:10000,preflightLimit:10});
 await store.saveIndex(sourceId,{status:'paused',scroll:null,pending:[],done:true,seen:0,completedAt:new Date(now).toISOString()},[{id:'MLU900000777',isbn:isbn(777),titleKey:'otrolibro',status:'active'}]);
 // The source run finished its own preflight: catalog books and other blockers in review, one traditional book validated.
 for(const book of catalogBooks)await store.job(sourceId,book.isbn,'review',{errorCode:SOURCE_CODE});
 for(const book of otherBooks)await store.job(sourceId,book.isbn,'review',{errorCode:book.code});
 await store.job(sourceId,validatedBook.isbn,'validated',{payload:{price:1200,currency_id:'UYU',condition:'new',catalog_listing:false}});
 await db.prepare("UPDATE ml_pub_runs SET state='ready' WHERE id=?").bind(sourceId).run();
 const calls={create:0,prepare:0,sku:0,validate:[]};
 const api={
  async skuItems(){calls.sku++;return [];},
  async prepare(env,row,p,price){
   calls.prepare++;
   if(p.catalogListing!=='required_only')throw new PublicationError(SOURCE_CODE,422);
   if(failValidate.has(row.isbn)){const error=new MercadoLibreError('ml_http_400',400);error.stage='item_validation';error.validationCodes=['item.catalog_listing.invalid'];throw error;}
   calls.validate.push(row.isbn);
   return {title:row.title,price,currency_id:'UYU',condition:'new',catalog_listing:true,catalog_product_id:`MLU1${row.isbn.slice(-5)}`,seller_custom_field:`AMADO-AR-${row.isbn}`};
  },
  async create(){calls.create++;throw Error('POST /items must never run during the catalog preflight');},
  ...apiOverrides,
 };
 const clock={value:now},service=createPublicationService({api,storeFactory:()=>store,now:()=>clock.value});
 const snapshot=async()=>({run:await store.run(sourceId),jobs:(await db.prepare('SELECT isbn,state,error_code,payload_json,item_id,attempts FROM ml_pub_jobs WHERE run_id=? ORDER BY isbn').bind(sourceId).all()).results});
 return {store,service,env,sourceId,feedId,now,calls,clock,db,snapshot};
}

test('the cloned policy equals the source field by field except catalogListing and hashes differently',async t=>{
 const f=await fixture(t);
 const result=await f.service.command(f.env,'clone_preflight_catalog',{source_run_id:f.sourceId});
 const source=validPolicy(JSON.parse((await f.store.run(f.sourceId)).policy_json)),clone=validPolicy(JSON.parse((await f.store.run(result.new_run_id)).policy_json));
 assert.deepEqual(Object.keys(clone).sort(),Object.keys(source).sort());
 for(const key of Object.keys(source))if(key!=='catalogListing')assert.deepEqual(clone[key],source[key],`policy field ${key} changed`);
 assert.equal(source.catalogListing,false);assert.equal(clone.catalogListing,'required_only');
 assert.equal(result.policy_hash,await policyHash({...policy,catalogListing:'required_only'}));
 assert.notEqual(result.policy_hash,result.source_policy_hash);assert.equal(result.source_policy_hash,await policyHash(policy));
 assert.equal(result.catalog_listing,'required_only');
});

test('the clone takes at most ten catalog_required_needs_review ISBNs, validates them and never posts an item',async t=>{
 const f=await fixture(t);
 const result=await f.service.command(f.env,'clone_preflight_catalog',{source_run_id:f.sourceId});
 assert.equal(result.selected_isbns.length,10);
 const expected=catalogBooks.map(b=>b.isbn).sort().slice(0,10);
 assert.deepEqual(result.selected_isbns,expected);
 for(const other of [...otherBooks,validatedBook])assert.ok(!result.selected_isbns.includes(other.isbn),`${other.isbn} must not be selected`);
 assert.equal(result.validated,10);assert.equal(result.review,0);assert.equal(result.published,0);
 assert.equal(f.calls.create,0,'POST /items must never run');
 assert.equal(f.calls.prepare,10);assert.deepEqual(f.calls.validate.sort(),expected);
 assert.equal(result.state,'ready');assert.equal(result.approved,false);assert.equal(result.preflight_limit,10);
 const first=result.preflight[0];
 assert.equal(first.catalog_listing,true);assert.match(first.catalog_product_id,/^MLU\d+$/);assert.equal(first.price,quoteMercadoLibre(catalogBooks.find(b=>b.isbn===first.isbn),policy).price);assert.ok(first.title);
 assert.equal(result.read_only_mercado_libre,true);
});

test('the new run is unapproved with limited caps and its id is deterministic',async t=>{
 const f=await fixture(t);
 const result=await f.service.command(f.env,'clone_preflight_catalog',{source_run_id:f.sourceId,limit:3});
 const run=await f.store.run(result.new_run_id);
 assert.equal(run.approved_hash,null);assert.equal(run.state,'ready');assert.equal(run.daily_cap,3);assert.equal(run.preflight_limit,3);assert.equal(run.feed_id,f.feedId);
 assert.equal(result.new_run_id,await clonePreflightRunId(f.sourceId,result.policy_hash,3));
 assert.match(result.new_run_id,/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
 assert.equal(result.selected_isbns.length,3);
 // The copied ML index protects against duplicates exactly like the source run did.
 const index=(await f.db.prepare('SELECT item_id,isbn FROM ml_pub_index WHERE run_id=?').bind(result.new_run_id).all()).results;
 assert.deepEqual(index,[{item_id:'MLU900000777',isbn:isbn(777)}]);
 // Approving still needs the explicit new hash and a human: the old hash is refused.
 await assert.rejects(()=>f.service.command(f.env,'approve',{run_id:result.new_run_id,policy_hash:result.source_policy_hash}),/policy_hash_mismatch/);
 assert.equal(f.calls.create,0);
});

test('the source run stays intact: policy, hash, approval, state and every job byte for byte',async t=>{
 const f=await fixture(t);
 const before=await f.snapshot();
 const result=await f.service.command(f.env,'clone_preflight_catalog',{source_run_id:f.sourceId});
 const after=await f.snapshot();
 assert.deepEqual(after.run,before.run);
 assert.deepEqual(after.jobs,before.jobs);
 assert.equal(result.source_run_intact,true);
 assert.equal(after.run.policy_hash,await policyHash(policy));assert.equal(after.run.approved_hash,null);assert.equal(after.run.state,'ready');
 assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM ml_pub_runs').first()).n,2);
});

test('repeating the same request returns the same clone without duplicating runs or touching the source',async t=>{
 const f=await fixture(t);
 const first=await f.service.command(f.env,'clone_preflight_catalog',{source_run_id:f.sourceId});
 const before=await f.snapshot();
 const second=await f.service.command(f.env,'clone_preflight_catalog',{source_run_id:f.sourceId});
 assert.equal(second.new_run_id,first.new_run_id);assert.equal(first.created,true);assert.equal(second.created,false);
 assert.deepEqual(second.selected_isbns,first.selected_isbns);assert.equal(second.validated,10);
 assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM ml_pub_runs').first()).n,2);
 assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM ml_pub_jobs WHERE run_id=?').bind(first.new_run_id).first()).n,10);
 assert.deepEqual(await f.snapshot(),before);assert.equal(second.source_run_intact,true);
 assert.equal(f.calls.prepare,10,'already validated books are not prepared again');assert.equal(f.calls.create,0);
 // A different limit is a different clone; both leave the source untouched.
 const third=await f.service.command(f.env,'clone_preflight_catalog',{source_run_id:f.sourceId,limit:2});
 assert.notEqual(third.new_run_id,first.new_run_id);assert.equal(third.selected_isbns.length,2);assert.deepEqual(await f.snapshot(),before);
});

test('/items/validate rejections are skipped with the official codes and nothing is published',async t=>{
 const failing=new Set([catalogBooks[0].isbn,catalogBooks[3].isbn]);
 const f=await fixture(t,{failValidate:failing});
 const result=await f.service.command(f.env,'clone_preflight_catalog',{source_run_id:f.sourceId});
 assert.equal(result.selected_isbns.length,10);
 assert.equal(result.review,0);assert.equal(result.validated,8);assert.equal(result.published,0);assert.equal(f.calls.create,0);
 for(const job of result.preflight.filter(j=>failing.has(j.isbn))){
  assert.equal(job.state,'skipped_ml_requirement');assert.equal(job.error_code,'ml_http_400');
  assert.deepEqual(job.validation,{stage:'item_validation',validation_codes:['item.catalog_listing.invalid']});
  assert.equal(job.catalog_product_id,null);
 }
 assert.equal(result.state,'ready');assert.equal(result.approved,false);assert.equal(result.source_run_intact,true);
 // The source keeps its own review reasons: nothing was retried there.
 assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM ml_pub_jobs WHERE run_id=? AND state='review' AND error_code=?").bind(f.sourceId,SOURCE_CODE).first()).n,catalogBooks.length);
});

test('the action is admin only, validates its inputs and refuses sources without candidates or already on Catálogo',async t=>{
 const f=await fixture(t);
 assert.deepEqual(ADMIN_ONLY_ACTIONS,['clone_preflight_catalog','shipping_diagnostic','shipping_probe','create_run_from_source','audit_availability_terms','queue_kick']);
 await assert.rejects(()=>f.service.command(f.env,'clone_preflight_catalog',{source_run_id:f.sourceId},{id:crypto.randomUUID(),expires:f.now+60000}),/admin_only_action/);
 await assert.rejects(()=>f.service.command(f.env,'clone_preflight_catalog',{source_run_id:'not-a-run'}),/invalid_run_id/);
 await assert.rejects(()=>f.service.command(f.env,'clone_preflight_catalog',{source_run_id:f.sourceId,limit:21}),/invalid_run_limits/);
 await assert.rejects(()=>f.service.command(f.env,'clone_preflight_catalog',{source_run_id:f.sourceId,limit:0}),/invalid_run_limits/);
 await assert.rejects(()=>f.service.command(f.env,'clone_preflight_catalog',{source_run_id:crypto.randomUUID()}),/source_run_not_found/);
 // A source that already runs the Catálogo policy has nothing to clone.
 const catalogSource=crypto.randomUUID();const catalogPolicy={...policy,catalogListing:'required_only'};
 await f.store.createRun({id:catalogSource,feedId:f.feedId,policy:validPolicy(catalogPolicy),policyHash:await policyHash(catalogPolicy),now:f.now,dailyCap:10,preflightLimit:10});
 await assert.rejects(()=>f.service.command(f.env,'clone_preflight_catalog',{source_run_id:catalogSource}),/source_policy_already_catalog/);
 // A source without catalog_required_needs_review jobs creates nothing.
 const emptySource=crypto.randomUUID();
 await f.store.createRun({id:emptySource,feedId:f.feedId,policy,policyHash:await policyHash(policy),now:f.now,dailyCap:10,preflightLimit:10});
 await assert.rejects(()=>f.service.command(f.env,'clone_preflight_catalog',{source_run_id:emptySource}),/no_catalog_review_candidates/);
 assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM ml_pub_runs').first()).n,3);
 assert.equal(f.calls.create,0);
});

test('a stale supplier snapshot blocks the clone instead of validating old stock',async t=>{
 const f=await fixture(t);
 f.clock.value=f.now+25*3600000;
 await assert.rejects(()=>f.service.command(f.env,'clone_preflight_catalog',{source_run_id:f.sourceId}),/invalid_run_or_stale_feed/);
 assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM ml_pub_runs').first()).n,1);
});

test('clonePreflightJob reports only the fields the reviewer needs',()=>{
 assert.deepEqual(clonePreflightJob({isbn:'1',state:'validated',error_code:null,payload:{title:'T',price:1500,catalog_listing:true,catalog_product_id:'MLU1',pictures:[{id:'x'}]}}),
  {isbn:'1',state:'validated',error_code:null,title:'T',price:1500,catalog_listing:true,catalog_product_id:'MLU1',validation:null});
 assert.deepEqual(clonePreflightJob({isbn:'2',state:'review',error_code:'ml_http_400',payload:{diagnostic:{stage:'item_validation',validation_codes:['a']}}}),
  {isbn:'2',state:'review',error_code:'ml_http_400',title:null,price:null,catalog_listing:null,catalog_product_id:null,validation:{stage:'item_validation',validation_codes:['a']}});
 assert.equal(clonePreflightJob({isbn:'3',state:'pending',payload:{family_name:'UPP'}}).title,'UPP');
});
