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
