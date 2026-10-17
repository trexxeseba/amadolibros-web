import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { PublicationStore } from '../../worker-sync/publication-store.js';
import { createVintagePilot } from '../_shared/meli-vintage-pilot.js';
import { createVintageTokenProvider } from '../_shared/meli-vintage-token.js';
import { createPublicationMeli } from '../../worker-sync/publication-meli.js';
import { policyHash } from '../../worker-sync/publication-policy.js';
import { createVintagePilotPage } from '../panel/meli-vintage-piloto.js';
import { createSessionToken, deriveSessionSecret, sessionCookieHeader } from '../_shared/panel-auth.js';

const vintage='2341378249',books='440298103',app='4741021817925208';
const policy={supplierDiscount:.25,arsPerUyu:40,usdPerUyu:40,freightUsdKg:10,laborUyu:0,margin:.2,mlFee:.15,deliveryUyu:200,minimumContributionUyu:100,minimumSaleUyu:1000,roundUyu:10,availabilityDays:18,additionalPricePct:0,listingTypeId:'gold_special',catalogListing:'required_only'};
function database(t) {
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());
 const statement=(sql,args=[])=>({sql,args,bind(...values){return statement(sql,values);},async first(){return sqlite.prepare(sql).get(...args)??null;},async all(){return {results:sqlite.prepare(sql).all(...args)};},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}};}});
 return {prepare:sql=>statement(sql),async batch(statements){sqlite.exec('BEGIN');try{const out=statements.map(s=>{const prepared=sqlite.prepare(s.sql);if(prepared.columns().length)return {results:prepared.all(...s.args),meta:{changes:1}};return {results:[],meta:{changes:Number(prepared.run(...s.args).changes)}};});sqlite.exec('COMMIT');return out;}catch(e){sqlite.exec('ROLLBACK');throw e;}},sqlite};
}
function isbn(index){const prefix='978950232'+String(index).padStart(3,'0');return prefix+((10-[...prefix].reduce((n,x,i)=>n+Number(x)*(i%2?3:1),0)%10)%10);}
async function fixture(t) {
 const db=database(t),s=new PublicationStore(db),clock={value:Date.now()},feed=crypto.randomUUID(),source=crypto.randomUUID();
 await s.initialize();
 const rows=Array.from({length:8},(_,i)=>({isbn:isbn(i),title:'Libro '+i,listArs:10000+i*1000,weightKg:.3,stock:'+2'}));
 await s.beginFeed(feed,new Date(clock.value).toISOString(),rows.length,clock.value);await s.importRows(feed,rows);await s.commitFeed(feed);
 await s.createRun({id:source,feedId:feed,policy,policyHash:await policyHash(policy),now:clock.value,dailyCap:1000,preflightLimit:5});
 const env={ORDERS_DB:db,APP_ID:app,USER_ID:books,ML_PUBLISHER_MODE:'enabled',ML_PUBLISH_QUEUE_ENABLED:'true',ML_PUBLISH_QUEUE:{send(){throw Error('Vintage must not enter Libros queue');}}};
 const calls={create:[],prepare:[]};
 const api={async account(){return {id:vintage,site_id:'MLU'};},async indexSlice(e,index){return {index:{...index,done:true},items:[]};},async skuItems(){return [];},async prepare(e,row,p,price){calls.prepare.push(row.isbn);return {title:row.title,price,currency_id:'UYU',condition:'new',catalog_listing:false,seller_custom_field:'AMADO-AR-'+row.isbn};},async create(e,payload){calls.create.push(payload);return {id:'MLU90000000'+calls.create.length,seller_id:vintage};}};
 const pilot=createVintagePilot({api,now:()=>clock.value});
 return {db,s,clock,feed,source,rows,env,calls,api,pilot};
}

test('Vintage run history, receipts, indexes and counts are isolated from Libros over the same supplier stock',async t=>{
 const f=await fixture(t),v=new PublicationStore(f.db,{sellerId:vintage}),isbn=f.rows[0].isbn;
 await f.s.reserve(books,isbn,f.source,f.clock.value,100);await f.s.receiptState(books,isbn,'published','MLU123456789');
 const before=await f.s.jobs(f.source);
 await f.pilot.prepare(f.env,{source_run_id:f.source,feed_id:f.feed});
 const run=(await f.pilot.snapshot(f.env)).run;
 assert.equal((await v.run(run.id)).seller_id,vintage);
 assert.equal((await v.jobs(run.id)).find(x=>x.isbn===isbn).state,'validated');
 assert.equal(await v.receipt(vintage,isbn),null);
 assert.deepEqual(await f.s.jobs(f.source),before);
 assert.equal(await v.dayCreated(f.clock.value),0);assert.equal(await f.s.dayCreated(f.clock.value),1);
 assert.throws(()=>f.db.sqlite.exec("UPDATE ml_vintage_pub_runs SET seller_id='440298103'"),/CHECK/);
 assert.equal(await v.run(f.source),null);
});

test('pilot validates without creation, requires exact sample approval and creates only its five reviewed ISBNs',async t=>{
 const f=await fixture(t),before=await f.s.jobs(f.source);
 let state=await f.pilot.prepare(f.env,{source_run_id:f.source,feed_id:f.feed});
 await f.pilot.prepare(f.env,{source_run_id:f.source,feed_id:f.feed});
 assert.equal(f.calls.create.length,0);
 state=await f.pilot.advance(f.env,{run_id:state.run.id});
 assert.equal(state.run.state,'ready');assert.equal(state.sample.length,5);assert.equal(state.can_approve,true);assert.equal(f.calls.create.length,0);
 const args={run_id:state.run.id,policy_hash:state.policy_hash,sample_hash:state.sample_hash};
 await assert.rejects(()=>f.pilot.approve(f.env,{...args,sample_hash:'tampered'}),/sample_changed/);
 const approved=state.sample.map(j=>j.isbn).sort();
 await f.pilot.approve(f.env,args);
 assert.equal(f.calls.create.length,5);
 await f.pilot.advance(f.env,{run_id:state.run.id});
 await f.pilot.advance(f.env,{run_id:state.run.id});
 assert.equal(f.calls.create.length,5);
 assert.deepEqual(f.calls.create.map(p=>p.seller_custom_field.slice(9)).sort(),approved);
 assert.equal((await f.pilot.snapshot(f.env)).run.state,'complete');
 assert.deepEqual(await f.s.jobs(f.source),before);
 assert.equal((await f.s.counts(f.source))[0].n,8);
 await assert.rejects(()=>f.pilot.approve(f.env,args),/sample_changed/);
});

test('stale stock or wrong identity prevents approval/preparation',async t=>{
 const f=await fixture(t);
 f.api.account=async()=>({id:books,site_id:'MLU'});
 await assert.rejects(()=>f.pilot.prepare(f.env,{source_run_id:f.source,feed_id:f.feed}),/seller_mismatch/);
 f.api.account=async()=>({id:vintage,site_id:'MLU'});
 let state=await f.pilot.prepare(f.env,{source_run_id:f.source,feed_id:f.feed});
 state=await f.pilot.advance(f.env,{run_id:state.run.id});
 f.clock.value+=25*3600000;
 await assert.rejects(()=>f.pilot.approve(f.env,{run_id:state.run.id,policy_hash:state.policy_hash,sample_hash:state.sample_hash}),/not_ready/);
 assert.equal(f.calls.create.length,0);
});

test('final identity gate blocks POST /items with Libros and pins the verified token across cache expiry',async()=>{
 let clock=0,tokenNumber=0;const requests=[];
 const api=createPublicationMeli({sellerId:vintage,now:()=>clock,tokenProvider:async()=> 'mock-token-'+(++tokenNumber),fetcher:async(url,options)=>{
  requests.push({path:new URL(url).pathname,auth:options.headers.Authorization});
  if(url.includes('/listing_prices'))return Response.json({currency_id:'UYU',listing_type_id:'gold_special',sale_fee_amount:0,listing_fee_amount:0});
  if(url.endsWith('/items/validate'))return new Response(null,{status:204});
  if(url.endsWith('/users/me')){clock+=120000;return Response.json({id:requests.some(r=>r.path==='/items')?books:vintage,site_id:'MLU'});}
  return Response.json({id:'MLU123456789',seller_id:vintage});
 }});
 await api.create({}, {currency_id:'UYU',condition:'new',catalog_listing:false,price:1000,category_id:'MLU1196'},policy);
 assert.equal(requests.find(r=>r.path==='/users/me').auth,requests.find(r=>r.path==='/items').auth);
 const blocked=createPublicationMeli({sellerId:vintage,tokenProvider:async()=>'mock',fetcher:async(url)=>{
  if(url.endsWith('/users/me'))return Response.json({id:books,site_id:'MLU'});
  if(url.includes('/listing_prices'))return Response.json({currency_id:'UYU',listing_type_id:'gold_special',sale_fee_amount:0,listing_fee_amount:0});
  if(url.endsWith('/items/validate'))return new Response(null,{status:204});
  assert.fail('wrong account must never create');
 }});
 await assert.rejects(()=>blocked.create({}, {currency_id:'UYU',condition:'new',catalog_listing:false,price:1000,category_id:'MLU1196'},policy),/seller_mismatch/);
});

async function authFixture(t) {
 const db=database(t);
 db.sqlite.exec('CREATE TABLE ml_oauth (app_id TEXT PRIMARY KEY,refresh_token TEXT); CREATE TABLE ml_oauth_sellers (app_id TEXT,seller_id TEXT,access_token TEXT,access_expires_at INTEGER,refresh_token TEXT,PRIMARY KEY(app_id,seller_id));');
 await db.prepare('INSERT INTO ml_oauth VALUES(?,?)').bind(app,'libros-refresh-unchanged').run();
 await db.prepare('INSERT INTO ml_oauth_sellers VALUES(?,?,?,?,?)').bind(app,vintage,'old-vintage-token',0,'old-vintage-refresh').run();
 return db;
}
test('refresh uses only Vintage credentials, has a durable lock, verifies identity and preserves Libros',async t=>{
 const db=await authFixture(t),env={ORDERS_DB:db,APP_ID:app,CLIENT_SECRET:'must-not-use-libros-binding',MELI_VINTAGE_CLIENT_SECRET:'vintage-app-secret'};
 let entered,release;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 const provider=createVintageTokenProvider({fetcher:async(url,options)=>{
  assert.equal(options.redirect,'manual');
  if(url.endsWith('/oauth/token')){
   assert.equal(options.body.get('client_secret'),'vintage-app-secret');assert.equal(options.body.get('refresh_token'),'old-vintage-refresh');
   entered();await gate;
   return Response.json({user_id:vintage,access_token:'new-vintage-token',refresh_token:'new-vintage-refresh',expires_in:21600});
  }
  return Response.json({id:vintage,site_id:'MLU'});
 }});
 const pending=provider.getAccessToken(env);await started;
 await assert.rejects(()=>provider.getAccessToken(env),/vintage_auth_busy/);release();
 assert.equal(await pending,'new-vintage-token');assert.equal(await provider.getAccessToken(env),'new-vintage-token');
 assert.equal(db.sqlite.prepare('SELECT refresh_token FROM ml_oauth').get().refresh_token,'libros-refresh-unchanged');
 assert.equal(db.sqlite.prepare('SELECT refresh_token FROM ml_oauth_sellers').get().refresh_token,'new-vintage-refresh');
});
test('refresh mismatch never selects or updates a Libros grant',async t=>{
 const db=await authFixture(t),provider=createVintageTokenProvider({fetcher:async()=>Response.json({user_id:books,access_token:'wrong',refresh_token:'wrong',expires_in:21600})});
 await assert.rejects(()=>provider.getAccessToken({ORDERS_DB:db,MELI_VINTAGE_CLIENT_SECRET:'secret'}),/identity_mismatch/);
 assert.equal(db.sqlite.prepare('SELECT refresh_token FROM ml_oauth_sellers').get().refresh_token,'old-vintage-refresh');
 assert.equal(db.sqlite.prepare('SELECT refresh_token FROM ml_oauth').get().refresh_token,'libros-refresh-unchanged');
});

test('a transient identity lookup failure preserves the rotated Vintage refresh token',async t=>{
 const db=await authFixture(t),provider=createVintageTokenProvider({fetcher:async(url)=>url.endsWith('/oauth/token')?Response.json({user_id:vintage,access_token:'new-vintage-token',refresh_token:'rotated-vintage-refresh',expires_in:21600}):Response.json({error:'unavailable'},{status:503})});
 await assert.rejects(()=>provider.getAccessToken({ORDERS_DB:db,MELI_VINTAGE_CLIENT_SECRET:'secret'}),/vintage_auth_upstream/);
 assert.equal(db.sqlite.prepare('SELECT refresh_token FROM ml_oauth_sellers').get().refresh_token,'rotated-vintage-refresh');
 assert.equal(db.sqlite.prepare('SELECT refresh_token FROM ml_oauth').get().refresh_token,'libros-refresh-unchanged');
});

test('pilot page requires panel session and rejects cross-origin POST before invoking the service',async()=>{
 const env={APP_ENV:'production',PANEL_PASSWORD:'a-test-password-long-enough'};
 const page=createVintagePilotPage({pilot:{prepare(){assert.fail('no service invocation');}}});
 const url='https://www.amadolibros.com/panel/meli-vintage-piloto';
 assert.equal((await page({request:new Request(url),env})).status,401);
 const cookie=sessionCookieHeader(await createSessionToken(await deriveSessionSecret(env.PANEL_PASSWORD))).split(';')[0];
 const request=new Request(url,{method:'POST',headers:{cookie,origin:'https://evil.invalid','content-type':'application/x-www-form-urlencoded'},body:'action=prepare'});
 assert.equal((await page({request,env})).status,403);
});
