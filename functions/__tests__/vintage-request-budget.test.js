import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../../scripts/vintage-local/db.mjs';
import {VintageBulkStore} from '../_shared/meli-vintage-bulk.js';
import {createVintageBulkFetch,requestEndpoint} from '../_shared/vintage-request-budget.js';
import {createPublicationMeli} from '../../worker-sync/publication-meli.js';
import {createRequestTelemetry,summarizeRequestRows} from '../../scripts/vintage-local/telemetry.mjs';

const origin='https://api.mercadolibre.com',seller='2341378249';
const search=isbn=>origin+'/products/search?'+new URLSearchParams({site_id:'MLU',status:'active',product_identifier:isbn});
async function setup(t,fetcher,onEvent=()=>{}){
 const db=openDatabase(':memory:');t.after(()=>db.close());await new VintageBulkStore(db,{sellerId:seller}).initialize();
 const clock={time:Date.parse('2026-10-19T00:00:00Z')},sent=[],opts={now:()=>clock.time,sleep:async ms=>{clock.time+=ms;},random:()=>0,onEvent,fetcher:async(url,o)=>{sent.push({at:clock.time,path:new URL(url).pathname});return fetcher(url,o);}};
 return {db,clock,sent,opts,env:{ORDERS_DB:db},fetch:createVintageBulkFetch(opts)};
}
test('a success on another endpoint preserves catalog strikes and the next 429 doubles its wait across restart',async t=>{
 const f=await setup(t,async url=>new URL(url).pathname==='/products/search'?new Response('{}',{status:429}):Response.json({}));
 await f.fetch(f.env,search('9789502323060'));
 f.clock.time+=120001;
 await createVintageBulkFetch(f.opts)(f.env,origin+'/users/me');
 assert.equal((await f.db.prepare('SELECT strikes FROM ml_vintage_bulk_endpoint_rate WHERE endpoint=?').bind('GET /products/search').first()).strikes,1);
 await f.fetch(f.env,search('9789502418513'));
 const state=await f.db.prepare('SELECT * FROM ml_vintage_bulk_endpoint_rate WHERE endpoint=?').bind('GET /products/search').first();
 assert.equal(state.strikes,2);assert.equal(state.cooldown-f.clock.time,240000);
 const before=f.sent.length;await assert.rejects(()=>f.fetch(f.env,origin+'/users/me'),e=>e.status===429);assert.equal(f.sent.length,before);
});
test('global spacing stays at 2 seconds and search has its own 5-second clock shared by limiter instances',async t=>{
 const f=await setup(t,async()=>Response.json({results:[]}));
 await f.fetch(f.env,search('9789502323060'));await f.fetch(f.env,origin+'/users/me');
 await createVintageBulkFetch(f.opts)(f.env,search('9789502418513'));await f.fetch(f.env,origin+'/users/me');
 assert.deepEqual(f.sent.map(x=>x.at-f.sent[0].at),[0,2000,5000,7000]);
});
test('catalog cache is positive-only, expires in 5 minutes, distinguishes ISBNs, and never caches identity or readback',async t=>{
 const f=await setup(t,async url=>{
  const p=new URL(url).pathname;
  if(p==='/products/search')return Response.json({paging:{total:1},results:[{id:'MLU123'}]});
  if(p==='/products/MLU123')return Response.json({id:'MLU123',status:'active',domain_id:'MLU-BOOKS'});
  return Response.json({});
 });
 const a=search('9789502323060');await f.fetch(f.env,a);await f.fetch(f.env,a);assert.equal(f.sent.length,1);
 await f.fetch(f.env,search('9789502418513'));assert.equal(f.sent.length,2);
 await f.fetch(f.env,origin+'/products/MLU123');await f.fetch(f.env,origin+'/products/MLU123');assert.equal(f.sent.length,3);
 for(const p of ['/users/me','/items/MLU123']){await f.fetch(f.env,origin+p);await f.fetch(f.env,origin+p);}
 assert.equal(f.sent.length,7);
 f.clock.time+=300001;await f.fetch(f.env,a);await f.fetch(f.env,origin+'/products/MLU123');assert.equal(f.sent.length,9);
});
test('empty catalog results and HTTP failures are not cached; a fresh cached category sends no request during cooldown',async t=>{
 let productFailure=true;
 const f=await setup(t,async url=>{
  const p=new URL(url).pathname;
  if(p==='/products/search')return Response.json({results:[]});
  if(p==='/products/MLU123')return Response.json({}, {status:productFailure?500:200});
  if(p==='/items/MLU123')return new Response('{}',{status:429});
  return Response.json({id:'MLU1196'});
 });
 await f.fetch(f.env,search('9789502323060'));await f.fetch(f.env,search('9789502323060'));
 await f.fetch(f.env,origin+'/products/MLU123');await f.fetch(f.env,origin+'/products/MLU123');assert.equal(f.sent.length,4);
 productFailure=false;await f.fetch(f.env,origin+'/categories/MLU1196');await f.fetch(f.env,origin+'/items/MLU123');
 const before=f.sent.length;assert.equal((await f.fetch(f.env,origin+'/categories/MLU1196')).status,200);assert.equal(f.sent.length,before);
});
test('telemetry counts the wire rather than cache hits and redacts identifiers, queries, headers and arbitrary paths',async t=>{
 const writes=[],telemetry=createRequestTelemetry('unused',{now:()=>Date.parse('2026-10-19T00:01:00Z'),appendFile:async(file,text)=>{writes.push({file,text});}});
 const f=await setup(t,async url=>new URL(url).pathname==='/products/search'?Response.json({results:[{id:'MLU123'}]}):new Response('{}',{status:429,headers:{'retry-after':'secret-credential'}}),telemetry.record);
 await telemetry.withBook('9789502323060','prepare',async()=>{await f.fetch(f.env,search('9789502323060'));await f.fetch(f.env,search('9789502323060'));await f.fetch(f.env,origin+'/items/MLU123?access_token=private-token');});
 await telemetry.flush();
 const text=writes.map(w=>w.text).join('');assert.doesNotMatch(text,/9789502323060|MLU123|private-token|secret-credential|product_identifier|access_token/);
 const rows=writes.filter(w=>w.file.endsWith('request-counts.jsonl')).flatMap(w=>w.text.trim().split('\n').map(x=>JSON.parse(x)));
 const summary=summarizeRequestRows(rows);assert.equal(summary.network_requests,2);assert.equal(summary.cache_hits,1);assert.equal(summary.responses_429,1);
 assert.equal(rows.find(r=>r.kind==='book_delta').requests,2);
 assert.equal(requestEndpoint(origin+'/something/PRIVATE-ID/private-name'),'/other');
 const failing=createRequestTelemetry('unused',{appendFile:async()=>{throw new Error('disk unavailable');}});failing.record({kind:'request',at:f.clock.time,method:'GET',endpoint:'/users/me',status:200,duration_ms:0});assert.equal(await failing.flush(),false);
});

test('real API code with a fake server measures 15 cold calls, 12 for a new ISBN with warm categories, retaining both validates and readback',async t=>{
 const products=new Map(),items=new Map(),lines=[],telemetry=createRequestTelemetry('unused',{appendFile:async(file,text)=>{if(file.endsWith('request-counts.jsonl'))lines.push(...text.trim().split('\n').map(s=>JSON.parse(s)));}});
 const f=await setup(t,async(url,options={})=>{
  const u=new URL(url),p=u.pathname;
  if(p==='/users/me')return Response.json({id:seller,site_id:'MLU'});
  if(p===`/users/${seller}/items/search`)return Response.json({results:[]});
  if(p===`/users/${seller}/shipping_preferences`)return Response.json({modes:['me2'],logistics:[{mode:'me2',types:[{type:'drop_off',default:true,status:'active'}]}]});
  if(p==='/products/search'){const isbn=u.searchParams.get('product_identifier'),id='MLU'+isbn;products.set(id,isbn);return Response.json({paging:{total:1},results:[{id,attributes:[{id:'GTIN',value_name:isbn}]}]});}
  if(p.startsWith('/products/')){const id=p.slice(10);return Response.json({id,status:'active',domain_id:'MLU-BOOKS',category_id:'MLU1196',attributes:[{id:'GTIN',value_name:products.get(id)}],pictures:[{id:'123456-MLU999999'}]});}
  if(p==='/categories/MLU1196/attributes')return Response.json([{id:'GTIN'},{id:'SELLER_SKU'}]);
  if(p==='/categories/MLU1196')return Response.json({settings:{listing_allowed:true},children_categories:[]});
  if(p==='/sites/MLU/listing_prices')return Response.json({currency_id:'UYU',listing_type_id:'gold_special',sale_fee_amount:100,listing_fee_amount:0});
  if(p==='/items/validate')return new Response(null,{status:204});
  if(p==='/items'){const body=JSON.parse(options.body),id='MLU'+(items.size+1),item={...body,id,seller_id:seller,status:'active'};items.set(id,item);return Response.json(item);}
  if(p.startsWith('/items/'))return Response.json(items.get(p.slice(7)));
  throw new Error('unexpected test endpoint');
 },telemetry.record);
 const api=createPublicationMeli({sellerId:seller,fetcher:(...args)=>f.fetch(f.env,...args),tokenProvider:async()=>'test-token',now:()=>f.clock.time});
 const policy={listingTypeId:'gold_special',catalogListing:'required_only',availabilityDays:18,mlFee:.17};
 const trace=async isbn=>telemetry.withBook(isbn,'publication',async()=>{
  await api.skuItems(f.env,isbn);await api.call(f.env,`/users/${seller}/items/search?seller_sku=AMADO-AR-${isbn}`);
  const body=await api.prepare(f.env,{isbn,title:'Libro de prueba',weightKg:.5},policy,1600);assert.equal(body.catalog_listing,false);
  const created=await api.create(f.env,body,policy);assert.equal((await api.call(f.env,'/items/'+created.id)).id,created.id);telemetry.mark(isbn,'published');
 });
 await trace('9789502323060');await telemetry.flush();await trace('9789502418513');await telemetry.flush();
 const observations=lines.filter(r=>r.kind==='book_delta');assert.deepEqual(observations.map(r=>r.requests),[15,12]);assert.equal(observations[1].cache_hits,2);
 assert.equal(observations[1].endpoints['POST /items/validate'].requests,2);assert.equal(observations[1].endpoints['GET /items/MLU#'].requests,1);
 assert.equal(summarizeRequestRows(lines).network_requests,27);
});
