import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sqliteD1} from './helpers/sqlite-d1.js';
import {PublicationStore} from '../publication-store.js';
import {createPublicationService,candidateSkipState} from '../publication-engine.js';
import {canonicalIsbn,hasSupplierStock,quoteMercadoLibre,policyHash,sha256,PublicationError} from '../publication-policy.js';
import {MercadoLibreError,createPublicationMeli} from '../publication-meli.js';
import {supplierBookMetadata} from '../publication-book-metadata.js';
import {verifyPublicationRequest} from '../publication-routes.js';
import {OPERATIONS_ISSUER} from '../operations-read.js';

const policy={supplierDiscount:.2,arsPerUyu:40,usdPerUyu:40,freightUsdKg:10,laborUyu:0,margin:.2,mlFee:.15,deliveryUyu:200,minimumContributionUyu:100,minimumSaleUyu:1000,roundUyu:10,availabilityDays:10,additionalPricePct:0,listingTypeId:'gold_special'};
const books=[{isbn:'9789502323060',title:'Libro de prueba uno',listArs:10000,weightKg:.2,stock:'+2'},{isbn:'9786075272795',title:'Libro de prueba dos',listArs:20000,weightKg:.3,stock:'1'}];
async function fixture(t,{rows=books,cap=10000,target=null,apiOverrides={}}={}){
 const dir=await mkdtemp(join(tmpdir(),'amado-queue-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const db=sqliteD1(join(dir,'queue.sqlite')),store=new PublicationStore(db),now=Date.now(),feedId=crypto.randomUUID(),runId=crypto.randomUUID();
 const env={ORDERS_DB:db,USER_ID:'440298103',APP_ID:'4741021817925208',ML_PUBLISHER_MODE:'enabled'};
 await store.initialize();await store.beginFeed(feedId,new Date(now).toISOString(),rows.length,now);await store.importRows(feedId,rows);await store.commitFeed(feedId);
 await store.createRun({id:runId,feedId,policy,policyHash:await policyHash(policy),now,dailyCap:cap,preflightLimit:10,...(target!==null?{targetPublished:target}:{})});
 await store.saveIndex(runId,{status:'paused',scroll:null,pending:[],done:true,seen:0,completedAt:new Date(now).toISOString()});
 const calls={create:0,prepare:0,sku:0};
 const api={async skuItems(){calls.sku++;return [];},async prepare(env,row,p,price){calls.prepare++;return {price,currency_id:'UYU',condition:'new',catalog_listing:false,seller_custom_field:`AMADO-AR-${row.isbn}`};},async create(){calls.create++;return {id:`MLU90000000${calls.create}`,seller_id:440298103};},...apiOverrides};
 const clock={value:now},service=createPublicationService({api,storeFactory:()=>store,now:()=>clock.value});
 return {store,service,env,runId,feedId,now,calls,clock,api};
}

test('deterministic candidate problems become skip states while policy/system problems stay visible',()=>{
 assert.equal(candidateSkipState(new PublicationError('ambiguous_product_metadata',422)),'skipped_identity');
 assert.equal(candidateSkipState(new PublicationError('missing_book_category',422)),'skipped_category');
 assert.equal(candidateSkipState(new PublicationError('supplier_stock_conflict',422)),'skipped_stock_uncertain');
 assert.equal(candidateSkipState(new MercadoLibreError('ml_http_400',400)),'skipped_ml_requirement');
 assert.equal(candidateSkipState(new PublicationError('payload_policy_mismatch',422)),null);
});
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
 const f=await fixture(t);assert.equal((await f.store.nextJob(f.runId,f.now,false)).isbn,books[0].isbn);const result=await f.service.tick(f.env,f.runId);assert.equal(result.state,'ready');assert.equal(f.calls.create,0);assert.equal(f.calls.prepare,2);assert.equal(result.counts.find(x=>x.state==='validated').n,2);
 await assert.rejects(()=>f.service.command(f.env,'approve',{run_id:f.runId,policy_hash:'0'.repeat(64)}),/policy_hash_mismatch/);
});
test('approved runs create once, persist receipts, finish and do not repeat on another tick',async t=>{
 const f=await fixture(t);await f.service.tick(f.env,f.runId);await f.service.command(f.env,'approve',{run_id:f.runId,policy_hash:await policyHash(policy)});
 const result=await f.service.tick(f.env,f.runId);assert.equal(result.state,'complete');assert.equal(f.calls.create,2);await f.service.tick(f.env,f.runId);assert.equal(f.calls.create,2);
});
test('target_published stops exactly at the requested number and skips the remaining pool',async t=>{
 const f=await fixture(t,{target:1});await f.service.tick(f.env,f.runId);await f.service.command(f.env,'approve',{run_id:f.runId,policy_hash:await policyHash(policy)});
 const result=await f.service.tick(f.env,f.runId);
 assert.equal(f.calls.create,1);assert.equal(result.state,'complete');assert.equal(result.target_published,1);assert.equal(result.target_remaining,0);
 assert.equal(result.counts.find(x=>x.state==='published').n,1);assert.equal(result.counts.find(x=>x.state==='skipped_target_reached').n,1);
});
test('stock zero, stale feeds and existing paused ISBNs prevent item creation',async t=>{
 const f=await fixture(t,{rows:[{...books[0],stock:'0'},books[1]]});
 await f.store.saveIndex(f.runId,JSON.parse((await f.store.run(f.runId)).index_json),[{id:'MLU900000009',isbn:books[1].isbn,titleKey:'',status:'paused'}]);
 const result=await f.service.tick(f.env,f.runId);assert.equal(f.calls.create,0);assert.equal(f.calls.prepare,0);assert.ok(result.counts.some(x=>x.state==='skipped_stock_uncertain'));assert.ok(result.counts.some(x=>x.state==='skipped_duplicate'));
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
 const result=await f.service.tick(f.env,f.runId);assert.equal(f.calls.create,0);assert.equal(result.counts.find(x=>x.state==='skipped_stock_uncertain').n,2);
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
test('validation errors retain only bounded official codes and never upstream messages or credentials',async()=>{
 const api=createPublicationMeli({tokenProvider:async()=>'private-test-token',fetcher:async()=>Response.json({cause:[{code:'item.attribute.missing_conditional_required',message:'private-test-token'},{code:'private-test-token',message:'private'}]},{status:400})});
 await assert.rejects(()=>api.call({},'/items/validate',{method:'POST',body:{}}),error=>{assert.deepEqual(error.validationCodes,['item.attribute.missing_conditional_required']);assert.equal(error.stage,'item_validation');assert.doesNotMatch(JSON.stringify(error),/private-test-token/);return true;});
});
test('product diagnostics distinguish a missing identifier from a wrong domain without returning credentials',async()=>{
 const api=createPublicationMeli({tokenProvider:async()=>'private-test-token',fetcher:async url=>new URL(url).pathname==='/products/search'?Response.json({paging:{total:1},results:[{id:'MLU900000000'}]}):Response.json({id:'MLU900000000',name:'Libro de prueba',domain_id:'MLU-BOOKS',attributes:[{id:'BOOK_TITLE',value_name:'Libro de prueba'}]})});
 const result=await api.inspectProduct({},books[0].isbn);assert.equal(result.reported_isbn,null);assert.equal(result.domain_id,'MLU-BOOKS');assert.deepEqual(result.attribute_ids,['BOOK_TITLE']);assert.doesNotMatch(JSON.stringify(result),/private-test-token/);
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
test('index pages read at most five independent multigets with twenty IDs each',async()=>{
 const ids=Array.from({length:100},(_,i)=>`MLU${900000000+i}`);let active=0,maxActive=0;
 const api=createPublicationMeli({tokenProvider:async()=>'token',fetcher:async url=>{
  const u=new URL(url);if(u.pathname.includes('/items/search'))return Response.json({results:ids,scroll_id:'cursor'});
  const group=u.searchParams.get('ids').split(',');assert.ok(group.length<=20);active++;maxActive=Math.max(maxActive,active);await new Promise(resolve=>setTimeout(resolve,1));active--;
  return Response.json(group.reverse().map(id=>({code:200,body:{id,seller_id:440298103,status:'active',title:id,attributes:[]}})));
 }});
 const result=await api.indexSlice({}, {status:'active',scroll:null,pending:[],done:false,seen:0});
 assert.equal(maxActive,5);assert.equal(result.items.length,100);assert.equal(new Set(result.items.map(x=>x.id)).size,100);assert.deepEqual(result.index.pending,[]);
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
  if(p==='/users/440298103/shipping_preferences')return Response.json({modes:['me2'],logistics:[{mode:'me2',types:[{type:'xd_drop_off',default:true,status:'active'}]}]});
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
test('uses the exact search ISBN when detail omits it while blocking conflicts and binding mismatches',async()=>{
 for(const scenario of ['search_identifier','conflicting_identifier','wrong_binding']){
  const fetcher=async url=>{
   const p=new URL(url).pathname;
   if(p==='/users/440298103/shipping_preferences')return Response.json({modes:['me2'],logistics:[{mode:'me2',types:[{type:'xd_drop_off',default:true,status:'active'}]}]});
   if(p==='/users/me')return Response.json({id:440298103,site_id:'MLU',tags:[]});
   if(p==='/products/search')return Response.json({paging:{total:1},results:[{id:'MLU123456',attributes:[{id:'GTIN',value_name:books[0].isbn}]}]});
   if(p==='/products/MLU123456')return Response.json({domain_id:'MLU-BOOKS',category_id:'MLU12345',attributes:scenario==='conflicting_identifier'?[{id:'GTIN',value_name:books[1].isbn}]:[{id:'BOOK_COVER',value_name:'Blanda'}],pictures:[{id:'123456-MLU999999'}]});
   if(p==='/categories/MLU12345')return Response.json({settings:{listing_allowed:true},children_categories:[]});
   if(p==='/categories/MLU12345/attributes')return Response.json([{id:'GTIN',tags:{}},{id:'BOOK_COVER',tags:{}}]);
   if(p==='/sites/MLU/listing_prices')return Response.json({currency_id:'UYU',listing_type_id:'gold_special',sale_fee_amount:100,listing_fee_amount:0});
   if(p==='/items/validate')return new Response(null,{status:204});
   throw Error('Unexpected endpoint');
  };
  const api=createPublicationMeli({fetcher,tokenProvider:async()=>'token'}),row={...books[0],title:scenario==='wrong_binding'?'Libro - HB':books[0].title};
  if(scenario==='search_identifier')assert.equal((await api.prepare({},row,policy,1000)).attributes.find(a=>a.id==='GTIN').value_name,books[0].isbn);
  else await assert.rejects(()=>api.prepare({},row,policy,1000),scenario==='wrong_binding'?/book_binding_mismatch/:/product_identity_mismatch/);
 }
});
test('only reviews from the corrected identity reader are retried and never uncertain creations',async t=>{
 const f=await fixture(t);await f.store.job(f.runId,books[0].isbn,'review',{errorCode:'product_isbn_or_domain_mismatch'});await f.store.job(f.runId,books[1].isbn,'uncertain',{errorCode:'create_outcome_unknown'});await f.service.tick(f.env,f.runId);
 const counts=await f.store.counts(f.runId);assert.equal(counts.find(x=>x.state==='validated').n,1);assert.equal(counts.find(x=>x.state==='uncertain').n,1);assert.equal(f.calls.create,0);
});

function supplierMetadata(isbn=books[0].isbn){return {ISBN:[isbn],Idioma:['Inglés Internacional'],Tapa:['Rústica'],Autor:['JULES VERNE'],Editorial:['Harper Collins'],'Cantidad de páginas':['352'],'Año de edición':['2017'],items:[{ean:'',isKit:false,images:[{imageUrl:'https://sbslibreria.vteximg.com.br/arquivos/ids/5707257/cover.jpg'}],sellers:[{sellerId:'1',commertialOffer:{Price:999999,AvailableQuantity:2,IsAvailable:true}}]}]};}
test('missing ML metadata can use an exact supplier edition without sending ML credentials or using retail offers',async()=>{
 let validated=false,external=0;
 const api=createPublicationMeli({tokenProvider:async()=>'private-test-token',fetcher:async(url,options)=>{
  const u=new URL(url),p=u.pathname;
  if(u.hostname==='www.sbs.com.ar'){external++;assert.equal(options.headers.Authorization,undefined);assert.equal(options.redirect,'manual');assert.equal(u.searchParams.get('ft'),books[0].isbn);return Response.json([supplierMetadata()]);}
  assert.equal(u.hostname,'api.mercadolibre.com');
  if(p==='/users/440298103/shipping_preferences')return Response.json({modes:['me2'],logistics:[{mode:'me2',types:[{type:'xd_drop_off',default:true,status:'active'}]}]});
  if(p==='/users/me')return Response.json({id:440298103,site_id:'MLU'});
  if(p==='/products/search')return Response.json({paging:{total:0},results:[]});
  if(p==='/sites/MLU/domain_discovery/search')return Response.json([{domain_id:'MLU-BOOKS',category_id:'MLU12345'}]);
  if(p==='/categories/MLU12345')return Response.json({settings:{listing_allowed:true},children_categories:[]});
  if(p==='/categories/MLU12345/attributes')return Response.json(['GTIN','SELLER_SKU','BOOK_TITLE','AUTHOR','BOOK_PUBLISHER','LANGUAGE','BOOK_COVER'].map(id=>({id,tags:{}})));
  if(p==='/sites/MLU/listing_prices')return Response.json({currency_id:'UYU',listing_type_id:'gold_special',sale_fee_amount:100,listing_fee_amount:0});
  if(p==='/items/validate'){validated=true;return new Response(null,{status:204});}
  throw Error('Unexpected endpoint '+p);
 }});
 const payload=await api.prepare({},books[0],policy,1200);
 assert.equal(external,1);assert.equal(validated,true);assert.equal(payload.price,1200);assert.equal(payload.available_quantity,1);assert.equal(payload.catalog_listing,false);
 assert.equal(payload.attributes.find(a=>a.id==='LANGUAGE').value_name,'Inglés');assert.equal(payload.attributes.find(a=>a.id==='BOOK_COVER').value_name,'Blanda');assert.match(payload.pictures[0].source,/sbslibreria/);
});
test('supplier metadata is strict about identity and stock but optional descriptive fields may be omitted',async()=>{
 for(const change of [p=>{p.ISBN=[books[1].isbn];},p=>{p.ISBN='bad';},p=>{p.items[0].ean=books[1].isbn;},p=>{p.items.push(p.items[0]);},p=>{p.items[0].isKit=true;},p=>{p.items[0].sellers[0].commertialOffer.IsAvailable=false;}]){
  const product=supplierMetadata();change(product);
  await assert.rejects(()=>supplierBookMetadata(books[0],{fetcher:async()=>Response.json([product])}),error=>error instanceof PublicationError);
 }
 const sparse=supplierMetadata();sparse.items[0].images[0].imageUrl='https://untrusted.example/cover.jpg';sparse.Idioma=['No determinado'];sparse.Tapa=['No determinada'];sparse.Autor=[];sparse.Editorial=[];
 const metadata=await supplierBookMetadata({...books[0],author:'',publisher:''},{fetcher:async()=>Response.json([sparse])});
 assert.deepEqual(metadata.pictures,[]);
 assert.equal(metadata.attributes.find(a=>a.id==='LANGUAGE'),undefined);
 assert.equal(metadata.attributes.find(a=>a.id==='BOOK_COVER'),undefined);
 assert.equal(metadata.attributes.find(a=>a.id==='AUTHOR'),undefined);
 assert.equal(metadata.attributes.find(a=>a.id==='BOOK_PUBLISHER'),undefined);
 assert.equal(metadata.attributes.find(a=>a.id==='GTIN').value_name,books[0].isbn);
 await assert.rejects(()=>supplierBookMetadata(books[0],{fetcher:async()=>{throw Error('private-test-token');}}),error=>{assert.equal(error.code,'missing_verified_book_metadata');assert.doesNotMatch(JSON.stringify(error),/private-test-token/);return true;});
});
test('required catalog and ambiguous ML matches never fall back to a traditional supplier listing',async()=>{
 for(const scenario of ['catalog_required','ambiguous']){
  const api=createPublicationMeli({tokenProvider:async()=>'token',fetcher:async url=>{
   const u=new URL(url);assert.equal(u.hostname,'api.mercadolibre.com');
   if(u.pathname==='/users/440298103/shipping_preferences')return Response.json({modes:['me2'],logistics:[{mode:'me2',types:[{type:'xd_drop_off',default:true,status:'active'}]}]});
   if(u.pathname==='/users/me')return Response.json({id:440298103,site_id:'MLU'});
   if(u.pathname==='/products/search')return Response.json({paging:{total:scenario==='ambiguous'?2:1},results:[{id:'MLU123456',attributes:[{id:'GTIN',value_name:books[0].isbn}],settings:{listing_strategy:'catalog_required'}}]});
   if(u.pathname==='/products/MLU123456')return Response.json({domain_id:'MLU-BOOKS',attributes:[]});
   throw Error('Unexpected endpoint');
  }});
  await assert.rejects(()=>api.prepare({},books[0],policy,1200),scenario==='ambiguous'?/ambiguous_product_metadata/:/catalog_required_needs_review/);
 }
});
test('legacy missing-metadata reviews retry once while a failed verified fallback stays in review',async t=>{
 const f=await fixture(t);await f.store.job(f.runId,books[0].isbn,'review',{errorCode:'missing_product_metadata'});await f.store.job(f.runId,books[1].isbn,'review',{errorCode:'missing_verified_book_metadata'});
 await f.service.tick(f.env,f.runId);assert.equal(f.calls.prepare,1);assert.equal((await f.store.counts(f.runId)).find(x=>x.state==='validated').n,1);
 assert.deepEqual((await f.store.summary(f.runId)).review_reasons,[{error_code:'missing_verified_book_metadata',n:1}]);
 await f.service.tick(f.env,f.runId);assert.equal(f.calls.prepare,1);
});

// ── Catálogo obligatorio, OAuth tipado, attach_feed y POST incierto ──────────
import {MeliAuthError} from '../meli-auth.js';
import {validPolicy} from '../publication-policy.js';
const catalogPolicy={...policy,catalogListing:'required_only'};
function catalogFetcher({detail={},children={},searchAttributes=[{id:'GTIN',value_name:books[0].isbn}],validate=()=>new Response(null,{status:204})}={}){
 const seen=[];
 const fetcher=async(url,options={})=>{
  const p=new URL(url).pathname;seen.push({path:p,method:options.method??'GET',body:options.body?JSON.parse(options.body):null});
  if(p==='/users/440298103/shipping_preferences')return Response.json({modes:['me2'],logistics:[{mode:'me2',types:[{type:'xd_drop_off',default:true,status:'active'}]}]});
  if(p==='/users/me')return Response.json({id:440298103,site_id:'MLU',tags:[]});
  if(p==='/products/search')return Response.json({paging:{total:1},results:[{id:'MLU123456',attributes:searchAttributes,settings:{listing_strategy:'catalog_required'}}]});
  if(p==='/products/MLU123456')return Response.json({id:'MLU123456',status:'active',domain_id:'MLU-BOOKS',category_id:'MLU12345',settings:{listing_strategy:'catalog_required'},attributes:[{id:'GTIN',value_name:books[0].isbn},{id:'BOOK_COVER',value_name:'Blanda'}],pictures:[{id:'123456-MLU999999'}],...detail});
  if(p.startsWith('/products/'))return Response.json(children[p.slice('/products/'.length)]??{});
  if(p==='/categories/MLU12345')return Response.json({settings:{listing_allowed:true,max_title_length:60},children_categories:[]});
  if(p==='/categories/MLU12345/attributes')return Response.json([{id:'GTIN',tags:{}},{id:'SELLER_SKU',tags:{}},{id:'BOOK_COVER',tags:{}}]);
  if(p==='/sites/MLU/listing_prices')return Response.json({currency_id:'UYU',listing_type_id:'gold_special',sale_fee_amount:100,listing_fee_amount:0});
  if(p==='/items/validate')return validate(JSON.parse(options.body));
  throw Error('Unexpected endpoint '+p);
 };
 return {fetcher,seen};
}
test('catalogListing is part of the policy hash and only accepts the explicit required_only value',async()=>{
 assert.equal(await policyHash(policy),await policyHash({...policy,catalogListing:false}));
 assert.notEqual(await policyHash(policy),await policyHash(catalogPolicy));
 assert.equal(validPolicy(catalogPolicy).catalogListing,'required_only');assert.equal(validPolicy(policy).catalogListing,false);
 for(const value of [true,'always','optional',1])assert.throws(()=>validPolicy({...policy,catalogListing:value}),/invalid_policy/);
});
test('catalog_required with the required_only policy prepares a validated catalog payload bound to the exact product',async()=>{
 const {fetcher,seen}=catalogFetcher();
 const api=createPublicationMeli({fetcher,tokenProvider:async()=>'token'}),payload=await api.prepare({},books[0],catalogPolicy,1200);
 assert.equal(payload.catalog_listing,true);assert.equal(payload.catalog_product_id,'MLU123456');assert.equal(payload.title,books[0].title);assert.ok(payload.pictures.length);
 assert.equal(payload.attributes.find(a=>a.id==='GTIN').value_name,books[0].isbn);assert.equal(payload.seller_custom_field,`AMADO-AR-${books[0].isbn}`);
 const validated=seen.find(x=>x.path==='/items/validate');assert.equal(validated.body.catalog_product_id,'MLU123456');assert.equal(validated.body.catalog_listing,true);
 assert.ok(!seen.some(x=>x.path==='/items'));
 // Sin la política explícita el mismo producto sigue siendo revisión, nunca una alta tradicional.
 await assert.rejects(()=>createPublicationMeli({fetcher,tokenProvider:async()=>'token'}).prepare({},books[0],policy,1200),/catalog_required_needs_review/);
});
test('catalog_optional products keep the traditional listing even with the required_only policy',async()=>{
 const {fetcher}=catalogFetcher({detail:{settings:{listing_strategy:'catalog_optional'}}});
 const seenSearch=async(url,options)=>{const p=new URL(url).pathname;if(p==='/products/search')return Response.json({paging:{total:1},results:[{id:'MLU123456',attributes:[{id:'GTIN',value_name:books[0].isbn}],settings:{listing_strategy:'catalog_optional'}}]});return fetcher(url,options);};
 const payload=await createPublicationMeli({fetcher:seenSearch,tokenProvider:async()=>'token'}).prepare({},books[0],catalogPolicy,1200);
 assert.equal(payload.catalog_listing,false);assert.equal(payload.catalog_product_id,undefined);
});
test('a wrong, inactive or GTIN-incompatible catalog product is review and never a catalog payload',async()=>{
 const scenarios=[
  ['catalog_product_id_mismatch',{detail:{id:'MLU999999'}}],
  ['catalog_product_inactive',{detail:{status:'inactive'}}],
  ['product_identity_mismatch',{detail:{attributes:[{id:'GTIN',value_name:books[1].isbn}]}}],
  ['product_identity_mismatch',{detail:{attributes:[{id:'BOOK_COVER',value_name:'Blanda'}]},searchAttributes:[]}],
 ];
 for(const [code,options] of scenarios){
  const {fetcher,seen}=catalogFetcher(options);
  await assert.rejects(()=>createPublicationMeli({fetcher,tokenProvider:async()=>'token'}).prepare({},books[0],catalogPolicy,1200),new RegExp(code));
  assert.ok(!seen.some(x=>x.path==='/items/validate'||x.path==='/items'));
 }
});
test('a parent catalog product resolves to the single child with the supplier GTIN or stays in review',async()=>{
 const child=(isbn,extra={})=>({domain_id:'MLU-BOOKS',status:'active',category_id:'MLU12345',attributes:[{id:'GTIN',value_name:isbn},{id:'BOOK_COVER',value_name:'Blanda'}],pictures:[{id:'123456-MLU999998'}],...extra});
 const resolved=catalogFetcher({detail:{children_ids:['MLU1001','MLU1002'],attributes:[],pictures:[]},children:{MLU1001:child(books[1].isbn),MLU1002:child(books[0].isbn)}});
 const payload=await createPublicationMeli({fetcher:resolved.fetcher,tokenProvider:async()=>'token'}).prepare({},books[0],catalogPolicy,1200);
 assert.equal(payload.catalog_product_id,'MLU1002');assert.equal(payload.pictures[0].id,'123456-MLU999998');
 for(const children of [{MLU1001:child(books[0].isbn),MLU1002:child(books[0].isbn)},{MLU1001:child(books[1].isbn),MLU1002:child(books[1].isbn)},{MLU1001:child(books[0].isbn,{children_ids:['MLU1003']}),MLU1002:child(books[1].isbn)},{MLU1001:child(books[0].isbn,{status:'inactive'}),MLU1002:child(books[1].isbn)}]){
  const {fetcher,seen}=catalogFetcher({detail:{children_ids:Object.keys(children),attributes:[],pictures:[]},children});
  await assert.rejects(()=>createPublicationMeli({fetcher,tokenProvider:async()=>'token'}).prepare({},books[0],catalogPolicy,1200),/catalog_product_children_unresolved/);
  assert.ok(!seen.some(x=>x.path==='/items/validate'));
 }
});
test('a failed catalog validation keeps the official codes as evidence for review',async t=>{
 const {fetcher}=catalogFetcher({validate:()=>Response.json({cause:[{code:'item.catalog_listing.invalid',message:'x'}]},{status:400})});
 const api=createPublicationMeli({fetcher,tokenProvider:async()=>'token'});
 const f=await fixture(t,{rows:[books[0]],apiOverrides:{prepare:api.prepare}});
 await f.store.db.prepare("UPDATE ml_pub_runs SET policy_json=?,policy_hash=? WHERE id=?").bind(JSON.stringify(validPolicy(catalogPolicy)),await policyHash(catalogPolicy),f.runId).run();
 const result=await f.service.tick(f.env,f.runId);
 assert.equal(result.review_reasons[0].error_code,'ml_http_400');
 const job=await f.store.db.prepare('SELECT payload_json FROM ml_pub_jobs WHERE run_id=?').bind(f.runId).first();
 const diagnostic=JSON.parse(job.payload_json).diagnostic;
 assert.equal(diagnostic.stage,'item_validation');assert.deepEqual(diagnostic.validation_codes,['item.catalog_listing.invalid']);
 // Causes and the shipping attempts are kept as bounded evidence for review.
 assert.deepEqual(diagnostic.causes.map(c=>c.code),['item.catalog_listing.invalid']);assert.equal(diagnostic.shipping_attempts.length,1);assert.equal(diagnostic.shipping_attempts[0].variant,'A');
});
test('a catalog payload is never created under a policy that did not approve Catálogo',async t=>{
 const f=await fixture(t,{rows:[books[0]]});await f.service.tick(f.env,f.runId);await f.service.command(f.env,'approve',{run_id:f.runId,policy_hash:await policyHash(policy)});
 await f.store.job(f.runId,books[0].isbn,'validated',{payload:{price:quoteMercadoLibre(books[0],policy).price,currency_id:'UYU',condition:'new',catalog_listing:true,catalog_product_id:'MLU123456'}});
 const result=await f.service.tick(f.env,f.runId);
 assert.equal(f.calls.create,0);assert.deepEqual(result.review_reasons,[{error_code:'catalog_payload_not_approved',n:1}]);assert.equal(await f.store.receipt('440298103',books[0].isbn),null);
 const api=createPublicationMeli({tokenProvider:async()=>'token',fetcher:async()=>{throw Error('no network expected');}});
 await assert.rejects(()=>api.create({},{price:1,currency_id:'UYU',condition:'new',catalog_listing:true,catalog_product_id:'MLU1'},policy),/catalog_payload_not_approved/);
 await assert.rejects(()=>api.create({},{price:1,currency_id:'UYU',condition:'new',catalog_listing:false,catalog_product_id:'MLU1'},catalogPolicy),/payload_policy_mismatch/);
});
test('approval of a run with the Catálogo policy requires that exact hash',async t=>{
 const f=await fixture(t);
 const runId=crypto.randomUUID();await f.store.createRun({id:runId,feedId:f.feedId,policy:validPolicy(catalogPolicy),policyHash:await policyHash(catalogPolicy),now:f.now,dailyCap:10,preflightLimit:10});
 await f.store.saveIndex(runId,{status:'paused',scroll:null,pending:[],done:true,seen:0});await f.service.tick(f.env,runId);
 const traditionalHash=await policyHash(policy),catalogHash=await policyHash(catalogPolicy);
 await assert.rejects(()=>f.service.command(f.env,'approve',{run_id:runId,policy_hash:traditionalHash}),/policy_hash_mismatch/);
 assert.equal((await f.service.command(f.env,'approve',{run_id:runId,policy_hash:catalogHash})).approved,true);
});
test('retryable auth failures defer the book and non-retryable ones stop the run without reviewing it',async t=>{
 const retryable=createPublicationMeli({tokenProvider:async()=>{throw new MeliAuthError('auth_upstream_503',{status:503,retryable:true});},fetcher:async()=>{throw Error('unexpected');}});
 let f=await fixture(t,{rows:[books[0]],apiOverrides:retryable});
 assert.equal((await f.service.tick(f.env,f.runId)).state,'preflight');
 let job=await f.store.db.prepare('SELECT * FROM ml_pub_jobs WHERE run_id=?').bind(f.runId).first();assert.equal(job.state,'retry');assert.equal(job.error_code,'auth_upstream_503');assert.equal(job.attempts,1);
 const fatal=createPublicationMeli({tokenProvider:async()=>{throw new MeliAuthError('auth_invalid_grant',{status:401,retryable:false});},fetcher:async()=>{throw Error('unexpected');}});
 f=await fixture(t,{rows:[books[0]],apiOverrides:fatal});
 assert.equal((await f.service.tick(f.env,f.runId)).state,'auth_error');
 job=await f.store.db.prepare('SELECT * FROM ml_pub_jobs WHERE run_id=?').bind(f.runId).first();assert.equal(job.state,'retry');assert.equal(job.attempts,0);
 assert.deepEqual((await f.store.summary(f.runId)).review_reasons,[]);
});
test('a 401 from the API invalidates the cached token through the shared store',async()=>{
 const invalidated=[];let tokens=0;
 const api=createPublicationMeli({tokenProvider:async()=>`token-${++tokens}`,tokenInvalidator:async(env,token)=>{invalidated.push(token);},fetcher:async()=>new Response('',{status:401})});
 await assert.rejects(()=>api.account({}),/ml_http_401/);assert.deepEqual(invalidated,['token-1']);
 await assert.rejects(()=>api.account({}),/ml_http_401/);assert.equal(tokens,2);
});
test('attach_feed waits for a busy lease instead of losing the daily snapshot',async t=>{
 const f=await fixture(t);
 const newFeed=async()=>{const id=crypto.randomUUID();await f.store.beginFeed(id,new Date(f.now).toISOString(),2,f.now);await f.store.importRows(id,books);await f.store.commitFeed(id);return id;};
 assert.ok(await f.store.lease(f.runId,'held',Date.now()));
 let waits=0;
 const patient=createPublicationService({api:f.api,storeFactory:()=>f.store,now:()=>f.clock.value,sleep:async()=>{waits++;await f.store.release(f.runId,'held');}});
 const result=await patient.command(f.env,'attach_feed',{run_id:f.runId,feed_id:await newFeed()});
 assert.equal(waits,1);assert.equal(result.state,'preflight');
 assert.ok(await f.store.lease(f.runId,'held-again',Date.now()));
 const impatient=createPublicationService({api:f.api,storeFactory:()=>f.store,now:()=>f.clock.value,attachWaitMs:2500,sleep:async()=>{f.clock.value+=1000;}});
 const lateFeed=await newFeed();
 await assert.rejects(()=>impatient.command(f.env,'attach_feed',{run_id:f.runId,feed_id:lateFeed}),/run_busy/);
 assert.equal((await f.store.run(f.runId)).lease_id,'held-again');
});
test('a timed-out POST /items is uncertain, never repeated, and reconciled later by SKU without a duplicate',async t=>{
 const posts=[];
 const fetcher=async(url,options)=>{
  const p=new URL(url).pathname;
  if(p==='/users/440298103/shipping_preferences')return Response.json({modes:['me2'],logistics:[{mode:'me2',types:[{type:'xd_drop_off',default:true,status:'active'}]}]});
  if(p==='/users/me')return Response.json({id:440298103,site_id:'MLU'});
  if(p==='/sites/MLU/listing_prices')return Response.json({currency_id:'UYU',listing_type_id:'gold_special',sale_fee_amount:0,listing_fee_amount:0});
  if(p==='/items/validate')return new Response(null,{status:204});
  if(p==='/items'&&options.method==='POST'){posts.push(options.body);return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(Object.assign(Error('aborted'),{name:'AbortError'}))));}
  throw Error('Unexpected endpoint '+p);
 };
 const real=createPublicationMeli({fetcher,tokenProvider:async()=>'token',timeouts:{create:20}});
 const f=await fixture(t,{rows:[books[0]],apiOverrides:{create:real.create}});
 await f.service.tick(f.env,f.runId);await f.service.command(f.env,'approve',{run_id:f.runId,policy_hash:await policyHash(policy)});
 const first=await f.service.tick(f.env,f.runId);
 assert.equal(posts.length,1);assert.equal(first.state,'complete_with_review');
 assert.equal((await f.store.receipt('440298103',books[0].isbn)).state,'uncertain');
 assert.equal((await f.store.db.prepare('SELECT error_code FROM ml_pub_jobs WHERE run_id=?').bind(f.runId).first()).error_code,'create_outcome_unknown');
 // Search index not yet consistent: still uncertain, still no second POST.
 await f.service.tick(f.env,f.runId);assert.equal(posts.length,1);assert.equal((await f.store.receipt('440298103',books[0].isbn)).state,'uncertain');
 // The item appears under its SKU: the cron tick (no run id) reconciles it as published, still one POST.
 f.api.skuItems=async()=>['MLU900000077'];
 // While the uncertain job is inside its backoff window the cron tick has nothing due.
 assert.deepEqual(await f.service.tick(f.env),{state:'no_active_run'});
 f.clock.value+=25*60000;
 const reconciled=await f.service.tick(f.env);assert.equal(reconciled.state,'complete');
 const receipt=await f.store.receipt('440298103',books[0].isbn);assert.equal(receipt.state,'published');assert.equal(receipt.item_id,'MLU900000077');
 assert.equal(posts.length,1);assert.equal((await f.store.counts(f.runId)).find(x=>x.state==='published').n,1);
 await f.service.tick(f.env,f.runId);assert.equal(posts.length,1);assert.deepEqual(await f.service.tick(f.env),{state:'no_active_run'});
});
test('index slices accept the /items/bulk status_code shape and reject entries with other statuses',async()=>{
 const api=createPublicationMeli({tokenProvider:async()=>'token',fetcher:async url=>{
  const u=new URL(url);if(u.pathname.includes('/items/search'))return Response.json({results:['MLU900000001','MLU900000002'],scroll_id:null});
  assert.equal(u.pathname,'/items/bulk');
  return Response.json([{status_code:200,body:{id:'MLU900000001',seller_id:440298103,status:'active',title:'Uno',attributes:[]}},{status_code:404,body:{id:'MLU900000002',seller_id:440298103,status:'active',title:'Dos',attributes:[]}}]);
 }});
 await assert.rejects(()=>api.indexSlice({},{status:'active',scroll:null,pending:[],done:false,seen:0}),/index_details_invalid/);
});
