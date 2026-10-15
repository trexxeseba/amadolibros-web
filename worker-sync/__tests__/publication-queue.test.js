import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sqliteD1} from './helpers/sqlite-d1.js';
import {PublicationStore} from '../publication-store.js';
import {createPublicationService} from '../publication-engine.js';
import {canonicalIsbn,hasSupplierStock,quoteMercadoLibre,policyHash,sha256,PublicationError} from '../publication-policy.js';
import {MercadoLibreError,createPublicationMeli} from '../publication-meli.js';
import {verifyPublicationRequest} from '../publication-routes.js';
import {OPERATIONS_ISSUER} from '../operations-read.js';

const policy={supplierDiscount:.2,arsPerUyu:40,usdPerUyu:40,freightUsdKg:10,laborUyu:0,margin:.2,mlFee:.15,deliveryUyu:200,minimumContributionUyu:100,minimumSaleUyu:1000,roundUyu:10,availabilityDays:10,additionalPricePct:0,listingTypeId:'gold_special'};
const books=[{isbn:'9789502323060',title:'Libro de prueba uno',listArs:10000,weightKg:.2,stock:'+2'},{isbn:'9786075272795',title:'Libro de prueba dos',listArs:20000,weightKg:.3,stock:'1'}];
async function fixture(t,{rows=books,cap=10000,apiOverrides={}}={}){
 const dir=await mkdtemp(join(tmpdir(),'amado-queue-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const db=sqliteD1(join(dir,'queue.sqlite')),store=new PublicationStore(db),now=Date.now(),feedId=crypto.randomUUID(),runId=crypto.randomUUID();
 const env={ORDERS_DB:db,USER_ID:'440298103',APP_ID:'4741021817925208',ML_PUBLISHER_MODE:'enabled'};
 await store.initialize();await store.beginFeed(feedId,new Date(now).toISOString(),rows.length,now);await store.importRows(feedId,rows);await store.commitFeed(feedId);
 await store.createRun({id:runId,feedId,policy,policyHash:await policyHash(policy),now,dailyCap:cap,preflightLimit:10});
 await store.saveIndex(runId,{status:'paused',scroll:null,pending:[],done:true,seen:0,completedAt:new Date(now).toISOString()});
 const calls={create:0,prepare:0,sku:0};
 const api={async skuItems(){calls.sku++;return [];},async prepare(env,row,p,price){calls.prepare++;return {price,currency_id:'UYU',condition:'new',catalog_listing:false,seller_custom_field:`AMADO-AR-${row.isbn}`};},async create(){calls.create++;return {id:`MLU90000000${calls.create}`,seller_id:440298103};},...apiOverrides};
 const clock={value:now},service=createPublicationService({api,storeFactory:()=>store,now:()=>clock.value});
 return {store,service,env,runId,feedId,now,calls,clock,api};
}

test('ISBN, stock and minimum pricing preserve supplier meaning',()=>{
 assert.equal(canonicalIsbn('978-950-23-2306-0'),'9789502323060');
 assert.throws(()=>canonicalIsbn('9789502323061'),/invalid_isbn/);
 assert.equal(hasSupplierStock('+2'),true);for(const value of ['0','',null,'agotado',-1])assert.equal(hasSupplierStock(value),false);
 const q=quoteMercadoLibre(books[0],policy);assert.ok(q.price>=policy.minimumSaleUyu);assert.ok(q.contribution>=policy.minimumContributionUyu);
 assert.equal(quoteMercadoLibre(books[0],{...policy,minimumSaleUyu:3000}).price,3000);
});
test('SQL imports are idempotent and feed completion requires the declared unique count',async t=>{
 const f=await fixture(t);await f.store.importRows(f.feedId,books).then(()=>assert.fail('ready feeds must be immutable'),e=>assert.equal(e.code,'feed_not_importing'));
 const id=crypto.randomUUID();await f.store.beginFeed(id,new Date(f.now).toISOString(),2,f.now);await f.store.importRows(id,[books[0]]);await f.store.importRows(id,[books[0]]);await assert.rejects(()=>f.store.commitFeed(id),/feed_count_mismatch/);
});
test('the database lease admits only one concurrent tick and the daily reservation is atomic',async t=>{
 const f=await fixture(t);const leases=await Promise.all([f.store.lease(f.runId,'a',f.now),f.store.lease(f.runId,'b',f.now)]);assert.equal(leases.filter(Boolean).length,1);
 assert.ok(await f.store.reserve('440298103',books[0].isbn,f.runId,f.now,1));assert.equal(await f.store.reserve('440298103',books[1].isbn,f.runId,f.now,1),null);
});
test('an expired owner cannot overwrite job state or index progress of the next lease',async t=>{
 const f=await fixture(t);assert.ok(await f.store.lease(f.runId,'old',f.now));assert.ok(await f.store.lease(f.runId,'new',f.now+301000));
 await assert.rejects(()=>f.store.job(f.runId,books[0].isbn,'review',{leaseToken:'old',now:f.now+301000}),/lease_lost/);
 await assert.rejects(()=>f.store.saveIndex(f.runId,{done:true},[],'old',f.now+301000),/lease_lost/);
});
test('preflight validates candidates and never calls item creation',async t=>{
 const f=await fixture(t);const result=await f.service.tick(f.env,f.runId);assert.equal(result.state,'ready');assert.equal(f.calls.create,0);assert.equal(f.calls.prepare,2);assert.equal(result.counts.find(x=>x.state==='validated').n,2);
 await assert.rejects(()=>f.service.command(f.env,'approve',{run_id:f.runId,policy_hash:'0'.repeat(64)}),/policy_hash_mismatch/);
});
test('approved runs create once, persist receipts, finish and do not repeat on another tick',async t=>{
 const f=await fixture(t);await f.service.tick(f.env,f.runId);await f.service.command(f.env,'approve',{run_id:f.runId,policy_hash:await policyHash(policy)});
 const result=await f.service.tick(f.env,f.runId);assert.equal(result.state,'complete');assert.equal(f.calls.create,2);await f.service.tick(f.env,f.runId);assert.equal(f.calls.create,2);
});
test('stock zero, stale feeds and existing paused ISBNs prevent item creation',async t=>{
 const f=await fixture(t,{rows:[{...books[0],stock:'0'},books[1]]});
 await f.store.saveIndex(f.runId,JSON.parse((await f.store.run(f.runId)).index_json),[{id:'MLU900000009',isbn:books[1].isbn,titleKey:'',status:'paused'}]);
 const result=await f.service.tick(f.env,f.runId);assert.equal(f.calls.create,0);assert.equal(f.calls.prepare,0);assert.ok(result.counts.some(x=>x.state==='skipped_stock'));assert.ok(result.counts.some(x=>x.state==='skipped_duplicate'));
 f.clock.value+=25*3600000;assert.equal((await f.service.tick(f.env,f.runId)).state,'ready');
});
test('a fresh active run pauses if its supplier snapshot expires',async t=>{
 const f=await fixture(t);f.clock.value+=25*3600000;assert.equal((await f.service.tick(f.env,f.runId)).state,'stock_stale');assert.equal(f.calls.create,0);
});
test('an ambiguous create is quarantined and never blindly retried',async t=>{
 const f=await fixture(t,{rows:[books[0]]});await f.service.tick(f.env,f.runId);await f.service.command(f.env,'approve',{run_id:f.runId,policy_hash:await policyHash(policy)});
 f.api.create=async()=>{f.calls.create++;throw new MercadoLibreError('create_outcome_unknown',503);};
 const result=await f.service.tick(f.env,f.runId);assert.equal(result.state,'complete_with_review');assert.equal((await f.store.receipt('440298103',books[0].isbn)).state,'uncertain');await f.service.tick(f.env,f.runId);assert.equal(f.calls.create,1);
});
test('rate limits defer work without declaring the queue complete',async t=>{
 const f=await fixture(t,{rows:[books[0]]});f.api.prepare=async()=>{throw new MercadoLibreError('ml_http_429',429,120);};
 assert.equal((await f.service.tick(f.env,f.runId)).state,'preflight');const job=await f.store.nextJob(f.runId,f.now+121000,false);assert.equal(job.state,'retry');assert.ok(job.next_at>=f.now+120000);assert.equal(f.calls.create,0);assert.equal((await f.service.tick(f.env,f.runId)).state,'backoff');
});
test('nonce reuse is rejected in persistent storage',async t=>{
 const f=await fixture(t);const id=crypto.randomUUID();await f.store.nonce(id,f.now+60000,f.now);await assert.rejects(()=>f.store.nonce(id,f.now+60000,f.now),/request_already_used/);
 const nonce={id:crypto.randomUUID(),expires:f.now+60000};await f.service.command(f.env,'tick',{run_id:f.runId},nonce);await assert.rejects(()=>f.service.command(f.env,'tick',{run_id:f.runId},nonce),/request_already_used/);
});
test('a replacement supplier snapshot never reuses stock of an absent ISBN',async t=>{
 const f=await fixture(t);await f.service.tick(f.env,f.runId);await f.service.command(f.env,'approve',{run_id:f.runId,policy_hash:await policyHash(policy)});
 const feedId=crypto.randomUUID();await f.store.beginFeed(feedId,new Date(f.now).toISOString(),1,f.now);await f.store.importRows(feedId,[{...books[0],stock:'0'}]);await f.store.commitFeed(feedId);await f.store.attachFeed(f.runId,feedId);
 await f.store.saveIndex(f.runId,{status:'paused',scroll:null,pending:[],done:true,seen:0});
 const result=await f.service.tick(f.env,f.runId);assert.equal(f.calls.create,0);assert.equal(result.counts.find(x=>x.state==='skipped_stock').n,2);
});
test('refreshing stock preserves the original batch and the preview prioritizes validated candidates',async t=>{
 const f=await fixture(t),third={...books[0],isbn:'9780140328721',title:'Libro fuera del lote'},feedId=crypto.randomUUID();
 await f.store.beginFeed(feedId,new Date(f.now).toISOString(),3,f.now);await f.store.importRows(feedId,[...books,third]);await f.store.commitFeed(feedId);await f.store.attachFeed(f.runId,feedId);
 assert.equal((await f.store.counts(f.runId)).reduce((n,x)=>n+x.n,0),2);assert.equal((await f.store.stock(feedId,third.isbn)).isbn,third.isbn);
 await f.store.job(f.runId,books[0].isbn,'review',{errorCode:'test_review'});await f.store.job(f.runId,books[1].isbn,'validated',{payload:{price:1200}});
 assert.equal((await f.store.preview(f.runId))[0].state,'validated');
});
test('signed publication envelopes bind the complete body and reject changed content',async()=>{
 const keys=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']),publicKey=await crypto.subtle.exportKey('jwk',keys.publicKey),now=Date.now();
 const raw=JSON.stringify({action:'status',args:{}}),payload={v:1,iss:OPERATIONS_ISSUER,aud:'amado-mercadolibre-publication',method:'POST',path:'/operations/publication',seller_id:'440298103',iat:Math.floor(now/1000),exp:Math.floor(now/1000)+45,jti:crypto.randomUUID(),body_sha256:await sha256(raw)};
 const encoded=Buffer.from(JSON.stringify(payload)).toString('base64url'),sig=Buffer.from(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},keys.privateKey,new TextEncoder().encode(encoded))).toString('base64url');
 const request=new Request('https://worker.test/operations/publication',{method:'POST',headers:{Authorization:`Amado-Signature ${encoded}.${sig}`},body:raw});
 assert.equal((await verifyPublicationRequest(request,raw,{now:()=>now,publicKey})).id,payload.jti);await assert.rejects(()=>verifyPublicationRequest(request,raw+' ',{now:()=>now,publicKey}),/unauthorized/);
});
test('transport follows no redirect and returns no credential or raw exception text',async()=>{
 const api=createPublicationMeli({tokenProvider:async()=>'private-token-test',fetcher:async(url,options)=>{assert.equal(options.redirect,'manual');throw Error('private-token-test');}});
 await assert.rejects(()=>api.account({}),error=>{assert.ok(error instanceof PublicationError);assert.doesNotMatch(error.message,/private-token/);return true;});
});
test('new bulk responses are matched by ID and an incomplete batch cannot finish the index',async()=>{
 const fetcher=async url=>{
  const p=new URL(url).pathname;
  if(p.includes('/items/search'))return Response.json({results:['MLU900000001','MLU900000002'],scroll_id:'cursor'});
  assert.equal(p,'/items/bulk');return Response.json([{status_code:200,body:{id:'MLU900000002',seller_id:440298103,status:'paused',title:'Dos',attributes:[{id:'GTIN',value_name:books[1].isbn}]}},{status_code:200,body:{id:'MLU900000001',seller_id:440298103,status:'paused',title:'Uno',attributes:[{id:'ISBN',value_name:books[0].isbn}]}}]);
 };
 const api=createPublicationMeli({fetcher,tokenProvider:async()=>'token'});
 const result=await api.indexSlice({}, {status:'paused',scroll:null,pending:[],done:false,seen:0});assert.equal(result.items[0].isbn,books[1].isbn);assert.equal(result.index.seen,2);assert.equal(result.index.done,false);
});
test('an expired scroll after a cooldown restarts the status without claiming an incomplete index is done',async()=>{
 let restarted=false;
 const api=createPublicationMeli({tokenProvider:async()=>'token',fetcher:async url=>{
  const parsed=new URL(url);
  if(parsed.pathname.endsWith('/items/search')){if(parsed.searchParams.has('scroll_id'))return Response.json({error:'expired'},{status:400});restarted=true;return Response.json({results:['MLU900000001'],scroll_id:'new-cursor'});}
  return Response.json([{code:200,body:{id:'MLU900000001',seller_id:440298103,status:'paused',title:'Libro',attributes:[]}}]);
 }});
 const r=await api.indexSlice({}, {status:'paused',scroll:'expired',pending:[],done:false,seen:0});assert.equal(restarted,true);assert.equal(r.index.done,false);assert.equal(r.index.scroll,'new-cursor');
});
test('UPP preparation uses family_name, keeps catalog_listing false and accepts validator HTTP 204',async()=>{
 const seen=[];
 const fetcher=async (url,options)=>{
  const p=new URL(url).pathname;seen.push({path:p,method:options.method,body:options.body});
  if(p==='/users/me')return Response.json({id:440298103,site_id:'MLU',tags:['user_product_seller']});
  if(p==='/products/search')return Response.json({paging:{total:1},results:[{id:'MLU123456',settings:{listing_strategy:'catalog_optional'}}]});
  if(p==='/products/MLU123456')return Response.json({domain_id:'MLU-BOOKS',category_id:'MLU12345',attributes:[{id:'GTIN',value_name:books[0].isbn}],pictures:[{id:'123456-MLU999999'}]});
  if(p==='/categories/MLU12345')return Response.json({settings:{listing_allowed:true,max_title_length:60},children_categories:[]});
  if(p==='/categories/MLU12345/attributes')return Response.json([{id:'GTIN',tags:{}},{id:'SELLER_SKU',tags:{}}]);
  if(p==='/sites/MLU/listing_prices')return Response.json({currency_id:'UYU',listing_type_id:'gold_special',sale_fee_amount:100,listing_fee_amount:0});
  if(p==='/items/validate')return new Response(null,{status:204});
  throw Error('Unexpected endpoint '+p);
 };
 const api=createPublicationMeli({fetcher,tokenProvider:async()=>'token'}),payload=await api.prepare({},books[0],policy,1000);
 assert.equal(payload.catalog_listing,false);assert.equal(payload.family_name,books[0].title);assert.equal(payload.title,undefined);assert.equal(payload.available_quantity,1);assert.ok(!seen.some(x=>x.path==='/items'));assert.equal(seen.filter(x=>x.method==='POST').length,1);
});
