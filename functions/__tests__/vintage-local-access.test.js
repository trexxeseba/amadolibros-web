import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../../scripts/vintage-local/db.mjs';
import {createLocalAccess} from '../_shared/vintage-local-access.js';
import {localExecutorState} from '../_shared/vintage-executor-state.js';
import {createLocalAccessRoute} from '../operations/vintage-local.js';
import {VintageBulkStore,createVintageBulk,BULK_RUN,PILOT_RUN} from '../_shared/meli-vintage-bulk.js';
import {PublicationStore} from '../../worker-sync/publication-store.js';
import {createSbsStock} from '../../worker-sync/sbs-supplier-stock.js';
import {policyHash} from '../../worker-sync/publication-policy.js';
import {checkConfiguration,checkCreated,makeBroker} from '../../scripts/vintage-local/engine.mjs';
const policy={supplierDiscount:.25,arsPerUyu:40,usdPerUyu:42,freightUsdKg:15,laborUyu:0,margin:.23,mlFee:.17,deliveryUyu:270,minimumContributionUyu:200,minimumSaleUyu:1600,roundUyu:10,availabilityDays:18,additionalPricePct:0,listingTypeId:'gold_special',catalogListing:'required_only'};
async function fixture(t){
 const db=openDatabase(':memory:');t.after(()=>db.close());const env={ORDERS_DB:db,APP_ENV:'production'},clock={value:Date.now()},s=new VintageBulkStore(db,{sellerId:'2341378249'});await new PublicationStore(db).initialize();await s.initialize();
 const feed=crypto.randomUUID(),hash=await policyHash(policy),supplier=createSbsStock({now:()=>clock.value});
 const rows=[{isbn:'9789502323060',title:'Test',listArs:40000,weightKg:.5,stock:'2'}];
 await supplier(env,'begin',{feed_id:feed,source_date:new Date(clock.value).toISOString(),source_sha256:'e'.repeat(64),expected_rows:1});await supplier(env,'import',{feed_id:feed,rows});await supplier(env,'commit',{feed_id:feed});
 await s.createRun({id:BULK_RUN,feedId:feed,policy,policyHash:hash,now:clock.value});
 await s.stmt("INSERT INTO ml_pub_runs(id,feed_id,policy_json,policy_hash,state,approved_hash,created_at,updated_at,index_json,daily_cap,preflight_limit) VALUES(?,?,?,?,'complete',?,?,?,'{}',5,5)",PILOT_RUN,feed,JSON.stringify(policy),hash,hash,clock.value,clock.value).run();
 for(let i=0;i<5;i++)await s.stmt('INSERT INTO ml_pub_verifications VALUES(?,?,?,?)',PILOT_RUN,String(i),clock.value,JSON.stringify({ok:true})).run();
 await db.prepare("INSERT INTO ml_pub_runs(id,feed_id,policy_json,policy_hash,state,created_at,updated_at,index_json,daily_cap,preflight_limit) VALUES('books',?,?,?,'complete',?,?,'{}',1000,5)").bind(feed,JSON.stringify({...policy,minimumSaleUyu:1200}),hash,clock.value,clock.value).run();
 const access=createLocalAccess({now:()=>clock.value,tokens:{async getAccessToken(){return 'test-vintage-access';},async invalidateAccessToken(){}}});
 const books=async()=>JSON.stringify((await db.prepare('SELECT * FROM ml_pub_runs').all()).results);
 return {db,env,s,clock,hash,access,books};
}
test('local authorization pauses only Vintage, exports no refresh/app secret, excludes web execution and revokes with pause',async t=>{
 const f=await fixture(t),before=await f.books(),c=await f.access.grant(f.env);
 assert.equal(c.seller_id,'2341378249');assert.equal((await f.s.run(BULK_RUN)).state,'paused');assert.ok(!JSON.stringify(c).includes('refresh_token'));assert.ok(!JSON.stringify(c).includes('client_secret'));
 assert.equal((await localExecutorState(f.env,f.clock.value)).active,true);
 const bulk=createVintageBulk({now:()=>f.clock.value});await assert.rejects(()=>bulk.command(f.env,'tick',{run_id:BULK_RUN}),/local_executor_active/);
 assert.equal((await f.access.command(f.env,c.key,'token')).access_token,'test-vintage-access');
 await bulk.command(f.env,'pause',{run_id:BULK_RUN});await assert.rejects(()=>f.access.command(f.env,c.key,'token'),/revoked/);assert.equal(await f.books(),before);
});
test('concurrent local reservations have one winner; reports cannot overwrite a published ISBN; Books stays intact',async t=>{
 const f=await fixture(t),before=await f.books(),c=await f.access.grant(f.env),isbn='9789502323060';
 const results=await Promise.all([f.access.command(f.env,c.key,'reserve',{isbn,policy_hash:f.hash}),f.access.command(f.env,c.key,'reserve',{isbn,policy_hash:f.hash})]);assert.equal(results.filter(x=>x.reserved).length,1);
 await f.access.command(f.env,c.key,'report',{isbn,state:'published',item_id:'MLU123'});
 await assert.rejects(()=>f.access.command(f.env,c.key,'report',{isbn,state:'published',item_id:'MLU456'}),/immutable/);
 assert.equal((await f.s.receipt('2341378249',isbn)).item_id,'MLU123');assert.equal(await f.books(),before);
 f.clock.value=c.expires_at+1;await assert.rejects(()=>f.access.command(f.env,c.key,'token'),/expired/);
});
test('access endpoint rejects oversized, arbitrary seller/URL arguments and never exposes credentials through GET',async()=>{
 let calls=0;const route=createLocalAccessRoute({access:{async command(){calls++;return {};}}}),env={APP_ENV:'production'},url='https://www.amadolibros.com/operations/vintage-local';
 assert.equal((await route({env,request:new Request(url)})).status,400);
 for(const args of [{seller_id:'440298103'},{url:'https://evil.invalid'}])assert.equal((await route({env,request:new Request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'token',args})})})).status,400);
 assert.equal((await route({env,request:new Request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:'x'.repeat(3000)})})).status,413);assert.equal(calls,0);
});
test('local configuration and item readback forbid Books, a different endpoint, low prices, wrong ISBN or availability',()=>{
 const c={version:1,seller_id:'2341378249',app_id:'4741021817925208',run_id:BULK_RUN,endpoint:'https://www.amadolibros.com/operations/vintage-local',key:'a'.repeat(64),expires_at:Date.now()+60000,policy};assert.equal(checkConfiguration(c).minimumSaleUyu,1600);
 for(const bad of [{seller_id:'440298103'},{endpoint:'https://evil.invalid'}])assert.throws(()=>checkConfiguration({...c,...bad}),/invalid/);
 const item={seller_id:'2341378249',price:2110,currency_id:'UYU',available_quantity:1,status:'active',seller_custom_field:'AMADO-AR-9789502323060',sale_terms:[{id:'MANUFACTURING_TIME',value_name:'18 días'}]};checkCreated(item,'9789502323060',2110);
 for(const bad of [{seller_id:'440298103'},{price:1200},{sale_terms:[]},{seller_custom_field:'wrong'}])assert.throws(()=>checkCreated({...item,...bad},'9789502323060',2110),/check_failed/);
});
test('local broker sends credentials only to its fixed endpoint and redacts unexpected upstream errors',async()=>{
 const c={key:'a'.repeat(64)},seen=[],broker=makeBroker(c,{fetcher:async(url,options)=>{seen.push({url,options});return Response.json({error:'Bearer secret-goes-here'},{status:403});}});
 await assert.rejects(()=>broker('status'),/local_broker_rejected/);assert.equal(seen[0].url,'https://www.amadolibros.com/operations/vintage-local');assert.equal(seen[0].options.redirect,'manual');
});


test('local engine validates without POST and resumes a saved publication database without replaying created ISBNs',async t=>{
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'amado-vintage-local-test-'));
 t.after(async()=>{if(path.dirname(temp)!==os.tmpdir()||!path.basename(temp).startsWith('amado-vintage-local-test-'))throw Error('unsafe_test_cleanup');await fs.rm(temp,{recursive:true,force:true});});
 const {run}=await import('../../scripts/vintage-local/engine.mjs'),source=new Date().toISOString(),hash=await policyHash(policy),connection=path.join(temp,'connection.json');
 await fs.writeFile(connection,JSON.stringify({version:1,seller_id:'2341378249',app_id:'4741021817925208',run_id:BULK_RUN,endpoint:'https://www.amadolibros.com/operations/vintage-local',key:'a'.repeat(64),expires_at:Date.now()+86400000,policy,policy_hash:hash,feed_id:crypto.randomUUID(),source_date:source,source_sha256:'e'.repeat(64),receipts:[]}));
 const rows=['9786075272795','9788410235861','9789502323060','9789502418513','9789878136912'].map(isbn=>({isbn,title:'Test '+isbn,listArs:40000,weightKg:.5,stock:'2'})),items=new Map(),reserved=new Map();let posts=0;
 const broker=async(action,args)=>{
  if(action==='status')return {daily_created:5+reserved.size,published_total:5+[...reserved.values()].filter(x=>x.state==='published').length};
  if(action==='reserve'){if(reserved.has(args.isbn))return {reserved:false,receipt:reserved.get(args.isbn)};reserved.set(args.isbn,{isbn:args.isbn,state:'creating',run_id:BULK_RUN,created_at:Date.now(),updated_at:Date.now()});return {reserved:true};}
  if(action==='report'){Object.assign(reserved.get(args.isbn),args);return {recorded:true};}throw Error('unexpected broker action');
 };
 const api={async account(){return {id:'2341378249',site_id:'MLU'};},async call(e,url){if(url.startsWith('/users/'))return {results:[]};const item=items.get(url.slice('/items/'.length));assert.ok(item);return {...item};},async skuItems(e,isbn){return [...items.values()].filter(x=>x.seller_custom_field==='AMADO-AR-'+isbn).map(x=>x.id);},async prepare(e,row,p,price){return {title:row.title,price,currency_id:'UYU',condition:'new',catalog_listing:false,seller_custom_field:'AMADO-AR-'+row.isbn};},async create(e,p){posts++;const item={...p,id:'MLU'+posts,seller_id:'2341378249',available_quantity:1,status:'active',sale_terms:[{id:'MANUFACTURING_TIME',value_name:'18 días'}]};items.set(item.id,item);return item;}};
 const options={excel:'unused',connection,directory:temp,target:8,onStatus:()=>{},readWorkbook:async()=>({rows,source_date:source,source_sha256:'e'.repeat(64)}),apiFactory:()=>api,brokerFactory:()=>broker,waitFor:async()=>{}};
 let result=await run({...options,validateOnly:3});assert.equal(result.state,'ready');assert.equal(posts,0);assert.equal(reserved.size,0);
 assert.equal(JSON.parse(await fs.readFile(path.join(temp,'items.preview.json'),'utf8')).filter(x=>x.state==='validated').length,3);
 result=await run({...options,limitNew:1});assert.equal(result.published_total,6);assert.equal(posts,1);
 result=await run(options);assert.equal(result.published_total,8);assert.equal(posts,3);assert.equal(new Set([...items.values()].map(x=>x.seller_custom_field)).size,3);
 const unsafeApi={...api,async call(e,url){const value=await api.call(e,url);return url.startsWith('/items/')?{...value,status:'under_review'}:value;}};
 await run({...options,directory:path.join(temp,'readback-failure'),target:1000,limitNew:3,apiFactory:()=>unsafeApi});
 assert.equal(posts,4,'a failed readback must stop before creating another item');
 assert.equal(JSON.parse(await fs.readFile(path.join(temp,'readback-failure','status.json'),'utf8')).state,'stopped_item_readback_failed');
});

async function engineHarness(t,{create}){
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'amado-vintage-local-test-'));
 t.after(async()=>{if(path.dirname(temp)!==os.tmpdir()||!path.basename(temp).startsWith('amado-vintage-local-test-'))throw Error('unsafe_test_cleanup');await fs.rm(temp,{recursive:true,force:true});});
 const {run}=await import('../../scripts/vintage-local/engine.mjs'),source=new Date().toISOString(),hash=await policyHash(policy),connection=path.join(temp,'connection.json');
 await fs.writeFile(connection,JSON.stringify({version:1,seller_id:'2341378249',app_id:'4741021817925208',run_id:BULK_RUN,endpoint:'https://www.amadolibros.com/operations/vintage-local',key:'a'.repeat(64),expires_at:Date.now()+86400000,policy,policy_hash:hash,feed_id:crypto.randomUUID(),source_date:source,source_sha256:'e'.repeat(64),receipts:[]}));
 const rows=['9786075272795','9788410235861','9789502323060','9789502418513','9789878136912'].map(isbn=>({isbn,title:'Test '+isbn,listArs:40000,weightKg:.5,stock:'2'})),reserved=new Map();
 const broker=async(action,args)=>{
  if(action==='status')return {daily_created:5+reserved.size,daily_cap:3000,published_total:5};
  if(action==='reserve'){if(reserved.has(args.isbn))return {reserved:false,receipt:reserved.get(args.isbn)};reserved.set(args.isbn,{isbn:args.isbn,state:'creating',run_id:BULK_RUN,created_at:Date.now(),updated_at:Date.now()});return {reserved:true};}
  if(action==='report'){Object.assign(reserved.get(args.isbn),args);return {recorded:true};}throw Error('unexpected broker action');
 };
 const apiFactory=opts=>({async account(){return {id:'2341378249',site_id:'MLU'};},async call(){return {results:[]};},async skuItems(){return [];},async prepare(e,row,p,price){return {title:row.title,price,currency_id:'UYU',condition:'new',catalog_listing:false,seller_custom_field:'AMADO-AR-'+row.isbn};},create:(e,p)=>create(opts,p)});
 return {run,temp,path,fs,options:{excel:'unused',connection,directory:temp,onStatus:()=>{},readWorkbook:async()=>({rows,source_date:source,source_sha256:'e'.repeat(64)}),apiFactory,brokerFactory:()=>broker,waitFor:async()=>{}}};
}

test('local engine records which endpoint answered 429 without ids or query text',async t=>{
 const {MercadoLibreError}=await import('../../worker-sync/publication-meli.js'),realFetch=globalThis.fetch;t.after(()=>{globalThis.fetch=realFetch;});
 globalThis.fetch=async()=>new Response('{}',{status:429,headers:{'retry-after':'7'}});
 const h=await engineHarness(t,{async create(opts){await opts.fetcher('https://api.mercadolibre.com/items/MLU123456?isbn=9786075272795',{method:'GET'});throw new MercadoLibreError('ml_http_429',429,7);}});
 await h.run({...h.options,target:8,limitNew:1});
 const lines=(await h.fs.readFile(h.path.join(h.temp,'rate-limit-events.jsonl'),'utf8')).trim().split('\n').map(x=>JSON.parse(x));
 assert.equal(lines.length,1);assert.equal(lines[0].endpoint,'/items/MLU#');assert.equal(lines[0].method,'GET');assert.equal(lines[0].retry_after,'7');assert.ok(!JSON.stringify(lines).includes('9786075272795'));
});

test('local engine stops when Mercado Libre refuses creation for the listing quota',async t=>{
 const {MercadoLibreError}=await import('../../worker-sync/publication-meli.js'),realFetch=globalThis.fetch;t.after(()=>{globalThis.fetch=realFetch;});
 globalThis.fetch=async()=>new Response(JSON.stringify({message:'quota',error:'validation_error',status:400,cause:[{code:'item.max_limit_publish'}]}),{status:400,headers:{'Content-Type':'application/json'}});
 let creates=0;
 const h=await engineHarness(t,{async create(opts){creates++;await opts.fetcher('https://api.mercadolibre.com/items',{method:'POST',body:'{}'});throw new MercadoLibreError('ml_http_400',400);}});
 const result=await h.run({...h.options,target:1000});
 assert.equal(result.state,'stopped_listing_quota');assert.equal(creates,1,'no further create after the quota refusal');
 assert.equal(JSON.parse(await h.fs.readFile(h.path.join(h.temp,'status.json'),'utf8')).state,'stopped_listing_quota');
});

async function pictureHarness(t,{pausedReads}){
 const h=await engineHarness(t,{create:null});
 const items=new Map(),waits=[];let posts=0,reads=0;
 const base=h.options.apiFactory({});
 const api={...base,async call(e,url){if(url.startsWith('/users/'))return {results:[]};reads++;const item=items.get(url.slice('/items/'.length));assert.ok(item);return reads<=pausedReads?{...item,status:'paused',sub_status:['picture_download_pending']}:{...item};},async create(e,p){posts++;const item={...p,id:'MLU'+posts,seller_id:'2341378249',available_quantity:1,status:'active',sale_terms:[{id:'MANUFACTURING_TIME',value_name:'18 días'}]};items.set(item.id,item);return item;}};
 return {h,api,waits,get posts(){return posts;},options:{...h.options,apiFactory:()=>api,waitFor:async ms=>{waits.push(ms);}}};
}

test('readback waits for Mercado Libre to finish downloading pictures before accepting the item',async t=>{
 const p=await pictureHarness(t,{pausedReads:2});
 const result=await p.h.run({...p.options,target:8,limitNew:1});
 assert.equal(result.published_total,6);assert.equal(p.posts,1);
 assert.deepEqual(p.waits.filter(x=>x===10000),[10000,10000],'two bounded waits while pictures download');
 assert.notEqual(result.state,'stopped_item_readback_failed');
});

test('a book whose pictures take longer than the wait is deferred without a second create and does not stop the run',async t=>{
 const {DatabaseSync}=await import('node:sqlite');
 const p=await pictureHarness(t,{pausedReads:1000});
 const result=await p.h.run({...p.options,target:1000,limitNew:3});
 assert.notEqual(result.state,'stopped_item_readback_failed');assert.equal(p.posts,3,'each of the three books is created exactly once');
 assert.equal(p.waits.filter(x=>x===10000).length,18,'six bounded waits per book, then it is deferred');
 const db=new DatabaseSync(p.h.path.join(p.h.temp,'publisher.sqlite'),{readOnly:true});
 const states=Object.fromEntries(db.prepare("SELECT state,COUNT(*) n FROM ml_vintage_pub_jobs WHERE state IN ('retry','review','uncertain','published') GROUP BY state").all().map(r=>[r.state,r.n]));db.close();
 assert.equal(states.review,undefined,'a deferred book is not sent to review');assert.equal(states.retry,3);
 assert.equal(JSON.parse(await p.h.fs.readFile(p.h.path.join(p.h.temp,'status.json'),'utf8')).state!=='stopped_item_readback_failed',true);
});

test('--sync-stock runs before publishing, writes its report, and --sync-only never creates anything',async t=>{
 let creates=0;
 const h=await engineHarness(t,{async create(){creates++;throw new Error('must_not_create');}});
 const result=await h.run({...h.options,target:8,syncStock:'report',syncOnly:true});
 assert.equal(result.state,'stock_sync_done');assert.equal(result.stock_sync,'workbook_incomplete','a 5-row workbook is refused by the sync');assert.equal(creates,0);
 const report=JSON.parse(await h.fs.readFile(h.path.join(h.temp,'stock-sync-report.json'),'utf8'));
 assert.equal(report.state,'workbook_incomplete');assert.equal(typeof report.at,'string');
 await assert.rejects(()=>h.run({...h.options,target:8,syncStock:'delete_everything',syncOnly:true}),/invalid_stock_sync_mode/);
});

async function reconcileHarness(t,{pausedReads}){
 const h=await engineHarness(t,{create:null});
 const items=new Map(),waits=[],state={pausedReads};let posts=0,reads=0;
 const base=h.options.apiFactory({});
 const api={...base,
  async call(e,url){if(url.startsWith('/users/'))return {results:[]};reads++;const item=items.get(url.slice('/items/'.length));assert.ok(item);return reads<=state.pausedReads?{...item,status:'paused',sub_status:['picture_download_pending']}:{...item};},
  async skuItems(e,isbn){return [...items.values()].filter(x=>x.seller_custom_field==='AMADO-AR-'+isbn).map(x=>x.id);},
  async create(e,p){posts++;const item={...p,id:'MLU'+posts,seller_id:'2341378249',available_quantity:1,status:'active',sale_terms:[{id:'MANUFACTURING_TIME',value_name:'18 días'}]};items.set(item.id,item);return item;}};
 const jobs=async sql=>{const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(h.path.join(h.temp,'publisher.sqlite'));try{return db.prepare(sql).all();}finally{db.close();}};
 const forceUncertain=async()=>{const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(h.path.join(h.temp,'publisher.sqlite'));db.prepare("UPDATE ml_vintage_pub_jobs SET state='uncertain',next_at=0,error_code='interrupted_create' WHERE state='retry'").run();db.close();};
 return {h,jobs,forceUncertain,waits,get posts(){return posts;},options:{...h.options,apiFactory:()=>api,waitFor:async ms=>{waits.push(ms);}}};
}

test('reconciling a created book whose pictures finish later publishes it and the run keeps going',async t=>{
 const r=await reconcileHarness(t,{pausedReads:14}); // 7 reads defer the create; the next 7 make the first reconcile fail; then it is active
 await r.h.run({...r.options,target:8,limitNew:1});
 assert.equal((await r.jobs("SELECT state FROM ml_vintage_pub_jobs WHERE item_id IS NOT NULL OR state='retry'")).filter(x=>x.state==='retry').length,1,'first run defers the book');
 await r.forceUncertain();
 const result=await r.h.run({...r.options,target:8,limitNew:1});
 assert.notEqual(result.state,'stopped_item_readback_failed');
 assert.equal((await r.jobs("SELECT state FROM ml_vintage_pub_jobs WHERE item_id='MLU1'"))[0].state,'published','reconciled by SKU once active');
 assert.equal(r.posts,2,'the deferred book is never created twice; only one further book is created');
});

test('a reconciled book whose pictures never finish stops the run with the read-back status instead of crashing or hanging',async t=>{
 const r=await reconcileHarness(t,{pausedReads:100000});
 await r.h.run({...r.options,target:8,limitNew:1});
 await r.forceUncertain();
 const result=await r.h.run({...r.options,target:1000});
 assert.equal(result.state,'stopped_item_readback_failed');assert.equal(r.posts,1,'no new create while the earlier book cannot be confirmed');
});
