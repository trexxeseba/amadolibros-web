import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {PublicationStore} from '../../worker-sync/publication-store.js';
import {createSbsStock} from '../../worker-sync/sbs-supplier-stock.js';
import {policyHash,PublicationError} from '../../worker-sync/publication-policy.js';
import {MercadoLibreError} from '../../worker-sync/publication-meli.js';
import {VintageBulkStore,createVintageBulk,createVintageBulkFetch,BULK_RUN,PILOT_RUN,VINTAGE_DAILY_CAP} from '../_shared/meli-vintage-bulk.js';
import {createVintageBulkPage} from '../panel/meli-vintage-lote.js';
import {createSessionToken,deriveSessionSecret,sessionCookieHeader} from '../_shared/panel-auth.js';
const seller='2341378249';
function database(t){
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());
 const statement=(sql,args=[])=>({sql,args,bind(...values){return statement(sql,values);},async first(){return sqlite.prepare(sql).get(...args)??null;},async all(){return {results:sqlite.prepare(sql).all(...args)};},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}};}});
 return {prepare:sql=>statement(sql),async batch(statements){sqlite.exec('BEGIN');try{const out=statements.map(s=>{const p=sqlite.prepare(s.sql);return /^(SELECT|PRAGMA)\b|\bRETURNING\b/i.test(s.sql)?{results:p.all(...s.args),meta:{changes:1}}:{results:[],meta:{changes:Number(p.run(...s.args).changes)}};});sqlite.exec('COMMIT');return out;}catch(e){sqlite.exec('ROLLBACK');throw e;}},sqlite};
}
function isbn(i){const stem='978'+String(i).padStart(9,'0');return stem+((10-[...stem].reduce((n,x,j)=>n+Number(x)*(j%2?3:1),0)%10)%10);}
const policy={supplierDiscount:.25,arsPerUyu:40,usdPerUyu:42,freightUsdKg:15,laborUyu:0,margin:.23,mlFee:.17,deliveryUyu:270,minimumContributionUyu:200,minimumSaleUyu:1600,roundUyu:10,availabilityDays:18,additionalPricePct:0,listingTypeId:'gold_special',catalogListing:'required_only'};
async function fixture(t){
 const db=database(t),clock={value:Date.now()},env={ORDERS_DB:db,APP_ID:'4741021817925208',USER_ID:'440298103',ML_PUBLISHER_MODE:'enabled'},s=new VintageBulkStore(db,{sellerId:seller});await new PublicationStore(db).initialize();await s.initialize();
 const feed=crypto.randomUUID(),hash=await policyHash(policy),supplier=createSbsStock({now:()=>clock.value});
 const rows=Array.from({length:10010},(_,i)=>({isbn:isbn(i),title:'Título '+i,listArs:10000,weightKg:.3,stock:'+2'}));
 await supplier(env,'begin',{feed_id:feed,source_date:new Date(clock.value).toISOString(),source_sha256:'e'.repeat(64),expected_rows:rows.length});
 for(let i=0;i<rows.length;i+=200)await supplier(env,'import',{feed_id:feed,rows:rows.slice(i,i+200)});await supplier(env,'commit',{feed_id:feed});
 await db.prepare("INSERT INTO ml_vintage_pub_runs(id,feed_id,policy_json,policy_hash,state,approved_hash,created_at,updated_at,index_json,daily_cap,preflight_limit) VALUES(?,?,?,?,'complete',?,?,?,'{}',5,5)").bind(PILOT_RUN,feed,JSON.stringify(policy),hash,hash,clock.value,clock.value).run();
 await s.stmt('INSERT INTO ml_pub_run_targets VALUES(?,?,?)',PILOT_RUN,5,clock.value).run();
 for(let i=0;i<5;i++){
  await s.stmt("INSERT INTO ml_pub_jobs(run_id,isbn,state,item_id) VALUES(?,?,'published',?)",PILOT_RUN,rows[i].isbn,'MLU'+(100+i)).run();
  await s.stmt("INSERT INTO ml_pub_receipts(seller_id,isbn,state,item_id,run_id,created_at,updated_at) VALUES(?,?,'published',?,?,?,?)",seller,rows[i].isbn,'MLU'+(100+i),PILOT_RUN,clock.value,clock.value).run();
  await s.stmt('INSERT INTO ml_pub_verifications VALUES(?,?,?,?)',PILOT_RUN,rows[i].isbn,clock.value,JSON.stringify({ok:true})).run();
 }
 await s.stmt("INSERT INTO ml_pub_jobs(run_id,isbn,state) VALUES(?,?,'skipped_pilot_limit')",PILOT_RUN,rows[5].isbn).run();
 await db.prepare("INSERT INTO ml_pub_runs(id,feed_id,policy_json,policy_hash,state,created_at,updated_at,index_json,daily_cap,preflight_limit) VALUES('books',?,?,?,'complete',?,?,'{}',1000,5)").bind(feed,JSON.stringify(policy),hash,clock.value,clock.value).run();
 const calls={create:[],sku:[]},api={async indexSlice(e,index){return {index:{...index,done:true},items:[]};},async skuItems(e,id){calls.sku.push(id);return [];},async prepare(e,row,p,price){return {title:row.title,price,currency_id:'UYU',condition:'new',catalog_listing:false,seller_custom_field:'AMADO-AR-'+row.isbn};},async create(e,p){calls.create.push(p);return {id:'MLU'+(1000+calls.create.length)};}};
 const bulk=createVintageBulk({api,now:()=>clock.value}),args={feed_id:feed,policy_hash:hash};
 const books=()=>JSON.stringify(['ml_pub_runs','ml_pub_jobs','ml_pub_receipts','ml_pub_feeds','ml_pub_stock'].map(table=>db.sqlite.prepare('SELECT * FROM '+table).all()));
 return {db,env,s,clock,rows,feed,hash,bulk,args,api,calls,books};
}
test('35 percent amendment changes only unreserved Vintage jobs and preserves published prices and Books',async t=>{
 const f=await fixture(t),books=f.books(),pilot=JSON.stringify(await f.s.run(PILOT_RUN));
 await f.bulk.command(f.env,'start',f.args);
 await f.bulk.command(f.env,'tick',{run_id:BULK_RUN});
 await f.bulk.command(f.env,'pause',{run_id:BULK_RUN});
 const published=JSON.stringify((await f.s.stmt("SELECT * FROM ml_pub_jobs WHERE run_id=? AND state='published'",BULK_RUN).all()).results);
 const result=await f.bulk.command(f.env,'apply_margin_35',{run_id:BULK_RUN});
 assert.equal(JSON.parse((await f.s.run(BULK_RUN)).policy_json).margin,.35);
 assert.equal(f.books(),books);assert.equal(JSON.stringify(await f.s.run(PILOT_RUN)),pilot);
 assert.equal(JSON.stringify((await f.s.stmt("SELECT * FROM ml_pub_jobs WHERE run_id=? AND state='published'",BULK_RUN).all()).results),published);
 await f.bulk.command(f.env,'start',{feed_id:f.feed,policy_hash:result.policy_hash});
 assert.equal((await f.s.run(BULK_RUN)).state,'publishing');
});

test('bulk preserves Books and pilot, excludes five receipts, retains pilot overflow, targets 9995 additional, and sends one create per tick',async t=>{
 const f=await fixture(t),before=f.books();let state=await f.bulk.command(f.env,'start',f.args);
 assert.equal(state.summary.target_published,9995);assert.equal(state.published_total,5);assert.equal(f.calls.create.length,0);
 assert.equal((await f.s.stmt('SELECT state FROM ml_pub_jobs WHERE run_id=? AND isbn=?',BULK_RUN,f.rows[5].isbn).first()).state,'pending');
 assert.equal((await f.s.stmt("SELECT COUNT(*) n FROM ml_pub_jobs WHERE run_id=? AND state='skipped_duplicate'",BULK_RUN).first()).n,5);
 await f.bulk.command(f.env,'tick',{run_id:BULK_RUN});assert.equal(f.calls.create.length,1);
 await f.bulk.command(f.env,'start',f.args);assert.equal(f.calls.create.length,1);
 assert.equal((await f.s.run(PILOT_RUN)).state,'complete');assert.equal(await f.s.publishedCount(PILOT_RUN),5);assert.equal(f.books(),before);
});
test('existing ISBNs and ambiguous outcomes are reconciled without another POST',async t=>{
 const f=await fixture(t);await f.bulk.command(f.env,'start',f.args);
 await f.s.stmt('INSERT INTO ml_pub_index VALUES(?,?,?,?,?)',BULK_RUN,'MLU999',f.rows[5].isbn,'','closed').run();
 await f.bulk.command(f.env,'tick',{run_id:BULK_RUN});assert.equal(f.calls.create.length,0);
 f.api.create=async(e,p)=>{f.calls.create.push(p);throw new MercadoLibreError('create_outcome_unknown',503);};
 await f.bulk.command(f.env,'tick',{run_id:BULK_RUN});assert.equal(f.calls.create.length,1);
 f.api.skuItems=async(e,id)=>id===f.rows[6].isbn?['MLU12345']:[];
 await f.bulk.command(f.env,'tick',{run_id:BULK_RUN});assert.equal((await f.s.receipt(seller,f.rows[6].isbn)).item_id,'MLU12345');
 assert.equal(f.calls.create.filter(p=>p.seller_custom_field.endsWith(f.rows[6].isbn)).length,1);
});
test('429 persists a cooldown and an expired workbook stops all new creates',async t=>{
 const f=await fixture(t);await f.bulk.command(f.env,'start',f.args);
 f.api.prepare=async()=>{throw new MercadoLibreError('ml_http_429',429,180);};
 let state=await f.bulk.command(f.env,'tick',{run_id:BULK_RUN});assert.ok(state.resume_at>=f.clock.value+180000);
 await f.bulk.command(f.env,'tick',{run_id:BULK_RUN});assert.equal(f.calls.create.length,0);
 f.clock.value+=25*3600000;state=await f.bulk.command(f.env,'tick',{run_id:BULK_RUN});assert.equal(state.run.state,'stock_stale');assert.equal(f.calls.create.length,0);
});
test('concurrent starts/ticks, pause, changed policy and insufficient stock never create another run',async t=>{
 const f=await fixture(t);
 await assert.rejects(()=>f.bulk.command(f.env,'start',{...f.args,policy_hash:'wrong'}),/policy_changed/);
 await Promise.all([f.bulk.command(f.env,'start',f.args),f.bulk.command(f.env,'start',f.args)]);
 await Promise.all([f.bulk.command(f.env,'tick',{run_id:BULK_RUN}),f.bulk.command(f.env,'tick',{run_id:BULK_RUN})]);assert.equal(f.calls.create.length,1);
 await f.bulk.command(f.env,'pause',{run_id:BULK_RUN});await f.bulk.command(f.env,'tick',{run_id:BULK_RUN});assert.equal(f.calls.create.length,1);
 assert.equal((await f.s.stmt('SELECT COUNT(*) n FROM ml_pub_runs WHERE id=?',BULK_RUN).first()).n,1);
});
test('persistent limiter spaces requests and honors HTTP-date Retry-After without another upstream request',async t=>{
 const db=database(t),s=new VintageBulkStore(db,{sellerId:seller});await s.initialize();const env={ORDERS_DB:db},clock={value:Date.now()},sent=[],sleeps=[];
 const rate=createVintageBulkFetch({now:()=>clock.value,sleep:async ms=>{sleeps.push(ms);clock.value+=ms;},random:()=>0,fetcher:async()=>{sent.push(clock.value);return sent.length===3?new Response('{}',{status:429,headers:{'retry-after':new Date(clock.value+240000).toUTCString()}}):new Response('{}');}});
 await rate(env,'https://api.mercadolibre.com/test',{});await rate(env,'https://api.mercadolibre.com/test',{});await rate(env,'https://api.mercadolibre.com/test',{});
 assert.ok(sent[1]-sent[0]>=2000);assert.ok(sent[2]-sent[1]>=2000);assert.ok(sleeps.length>=2);
 await assert.rejects(()=>rate(env,'https://api.mercadolibre.com/test',{}),e=>e.status===429&&e.retryAfter>=239);assert.equal(sent.length,3);
 assert.equal((await db.prepare('SELECT strikes FROM ml_vintage_bulk_rate WHERE id=1').first()).strikes,1);
 clock.value+=250000;await rate(env,'https://api.mercadolibre.com/test',{});
 assert.equal((await db.prepare('SELECT strikes FROM ml_vintage_bulk_rate WHERE id=1').first()).strikes,0);
});
test('the campaign stops at exactly 10000 including the pilot and never promotes the remaining candidates',async t=>{
 const f=await fixture(t);await f.bulk.command(f.env,'start',f.args);
 await f.s.stmt("UPDATE ml_pub_jobs SET state='published',item_id='MLU'||isbn WHERE run_id=? AND isbn IN (SELECT isbn FROM ml_pub_jobs WHERE run_id=? AND state='pending' ORDER BY isbn LIMIT 9994)",BULK_RUN,BULK_RUN).run();
 let state=await f.bulk.command(f.env,'tick',{run_id:BULK_RUN});assert.equal(state.published_total,10000);assert.equal(f.calls.create.length,1);
 state=await f.bulk.command(f.env,'tick',{run_id:BULK_RUN});assert.equal(state.run.state,'complete');assert.equal(f.calls.create.length,1);
 await f.bulk.command(f.env,'start',f.args);await f.bulk.command(f.env,'tick',{run_id:BULK_RUN});assert.equal(f.calls.create.length,1);
});
test('daily cap includes uncertain reservations and does not reserve or send another create',async t=>{
 const f=await fixture(t);await f.bulk.command(f.env,'start',f.args);
 await f.s.stmt("INSERT INTO ml_pub_receipts(seller_id,isbn,state,run_id,created_at,updated_at) SELECT ?,isbn,'uncertain',?,?,? FROM ml_pub_stock WHERE feed_id=? AND isbn NOT IN(SELECT isbn FROM ml_pub_receipts WHERE seller_id=?) LIMIT ?",seller,BULK_RUN,f.clock.value,f.clock.value,f.feed,seller,VINTAGE_DAILY_CAP-5).run();
 const state=await f.bulk.command(f.env,'tick',{run_id:BULK_RUN});assert.equal(f.calls.create.length,0);assert.equal(state.daily_created,VINTAGE_DAILY_CAP);assert.equal(state.daily_cap,VINTAGE_DAILY_CAP);assert.ok(state.resume_at>f.clock.value);
});
test('bulk route requires panel session and same origin; no public start or shared seller argument',async()=>{
 const env={APP_ENV:'production',PANEL_PASSWORD:'a-test-password-long-enough'},origin='https://www.amadolibros.com',url=origin+'/panel/meli-vintage-lote';let calls=0;
 const page=createVintageBulkPage({bulk:{async command(){calls++;return {};},async status(){return {};}}}),cookie=sessionCookieHeader(await createSessionToken(await deriveSessionSecret(env.PANEL_PASSWORD))).split(';')[0];
 assert.equal((await page({env,request:new Request(url,{method:'POST',body:'{}'})})).status,401);
 for(const [requestOrigin,args] of [['https://evil.invalid',{}],[origin,{seller_id:'440298103'}]])assert.equal((await page({env,request:new Request(url,{method:'POST',headers:{cookie,origin:requestOrigin,'content-type':'application/json'},body:JSON.stringify({action:'start',args})})})).status,requestOrigin===origin?400:403);
 assert.equal(calls,0);
});


test('1600 floor amends only paused Vintage, raises two prices, preserves seals and Books, and reads before retrying an uncertain PUT',async t=>{
 const f=await fixture(t),before=f.books();await f.bulk.command(f.env,'start',f.args);await f.bulk.command(f.env,'pause',{run_id:BULK_RUN});
 const old={...policy,minimumSaleUyu:1200},oldHash=await policyHash(old);
 await f.s.stmt('UPDATE ml_pub_runs SET policy_json=?,policy_hash=?,approved_hash=? WHERE id=?',JSON.stringify(old),oldHash,oldHash,BULK_RUN).run();
 const prices=[1450,3390,1200,2680,1680],items=new Map();
 for(let i=0;i<5;i++){
  const item={id:'MLU'+(100+i),seller_id:seller,currency_id:'UYU',price:prices[i],seller_custom_field:'AMADO-AR-'+f.rows[i].isbn};items.set('/items/'+item.id,item);
  await f.s.stmt('UPDATE ml_pub_jobs SET payload_json=? WHERE run_id=? AND isbn=?',JSON.stringify({price:prices[i],currency_id:'UYU'}),PILOT_RUN,f.rows[i].isbn).run();
 }
 const originalJobs=JSON.stringify(await f.s.jobs(PILOT_RUN)),puts=[];let lost=true;
 f.api.call=async(e,path,options={})=>{
  if(path==='/users/me')return {id:seller,site_id:'MLU'};
  const item=items.get(path);assert.ok(item);
  if(options.method==='PUT'){puts.push(item.id);assert.deepEqual(options.body,{price:1600});item.price=1600;if(lost){lost=false;throw new MercadoLibreError('lost_response',503);}}
  return structuredClone(item);
 };
 await assert.rejects(()=>f.bulk.command(f.env,'apply_minimum',{run_id:BULK_RUN}),/lost_response/);
 let result;for(let i=0;i<6;i++){result=await f.bulk.command(f.env,'apply_minimum',{run_id:BULK_RUN});if(result.minimum_complete)break;}
 assert.equal(result.minimum_complete,true);assert.deepEqual([...items.values()].map(x=>x.price),[1600,3390,1600,2680,1680]);assert.equal(puts.length,2);
 assert.equal((await f.s.run(BULK_RUN)).state,'paused');assert.equal(JSON.parse((await f.s.run(BULK_RUN)).policy_json).minimumSaleUyu,1600);
 assert.equal(JSON.stringify(await f.s.jobs(PILOT_RUN)),originalJobs);assert.equal(f.books(),before);
 await assert.rejects(()=>f.bulk.command(f.env,'start',f.args),/pilot_not_verified/);
 for(let i=0;i<5;i++)await f.s.stmt('INSERT OR REPLACE INTO ml_pub_verifications VALUES(?,?,?,?)',PILOT_RUN,f.rows[i].isbn,f.clock.value,JSON.stringify({ok:true,price:Math.max(1600,prices[i])})).run();
 await f.bulk.command(f.env,'start',f.args);await f.bulk.command(f.env,'tick',{run_id:BULK_RUN});assert.ok(f.calls.create[0].price>=1600);
});

test('price correction rejects another seller or ISBN before any PUT, and refuses an ignored price update',async t=>{
 const f=await fixture(t);await f.bulk.command(f.env,'start',f.args);await f.bulk.command(f.env,'pause',{run_id:BULK_RUN});let puts=0;
 const item={id:'MLU100',seller_id:'440298103',currency_id:'UYU',price:1200,seller_custom_field:'AMADO-AR-'+f.rows[0].isbn};
 f.api.call=async(e,path,options={})=>{if(path==='/users/me')return {id:seller,site_id:'MLU'};if(options.method==='PUT')puts++;return {...item};};
 await assert.rejects(()=>f.bulk.command(f.env,'apply_minimum',{run_id:BULK_RUN}),/identity_mismatch/);assert.equal(puts,0);
 item.seller_id=seller;item.seller_custom_field='AMADO-AR-'+f.rows[9].isbn;
 await assert.rejects(()=>f.bulk.command(f.env,'apply_minimum',{run_id:BULK_RUN}),/identity_mismatch/);assert.equal(puts,0);
 item.seller_custom_field='AMADO-AR-'+f.rows[0].isbn;
 await assert.rejects(()=>f.bulk.command(f.env,'apply_minimum',{run_id:BULK_RUN}),/not_confirmed/);assert.equal(puts,1);
 assert.equal((await f.s.run(BULK_RUN)).state,'paused');
});

test('Vintage rejects any stale payload below 1600 before external calls',async()=>{
 const {createPublicationMeli}=await import('../../worker-sync/publication-meli.js');let calls=0;
 const api=createPublicationMeli({sellerId:seller,tokenProvider:async()=>'test-vintage',fetcher:async()=>{calls++;throw Error('unexpected network');}});
 for(const price of [1200,1450,1599])await assert.rejects(()=>api.create({}, {price,currency_id:'UYU'},policy),/vintage_price_below_1600/);
 assert.equal(calls,0);
});


test('availability repair updates only four mismatches to 18 days, preserves prices and Books, and re-reads a lost response',async t=>{
 const f=await fixture(t),before=f.books();await f.bulk.command(f.env,'start',f.args);await f.bulk.command(f.env,'pause',{run_id:BULK_RUN});
 const items=new Map(f.rows.slice(0,5).map((r,i)=>['/items/MLU'+(100+i),{id:'MLU'+(100+i),seller_id:seller,price:1600+i*100,currency_id:'UYU',seller_custom_field:'AMADO-AR-'+r.isbn,sale_terms:[{id:'MANUFACTURING_TIME',value_name:(i===2?'18':'19')+' días'}]}]));let puts=0,lost=true;
 f.api.call=async(e,path,options={})=>{
  if(path==='/users/me')return {id:seller,site_id:'MLU'};
  const item=items.get(path);assert.ok(item);
  if(options.method==='PUT'){assert.deepEqual(options.body,{sale_terms:[{id:'MANUFACTURING_TIME',value_name:'18 días'}]});puts++;item.sale_terms=options.body.sale_terms;if(lost){lost=false;throw new MercadoLibreError('lost_response',503);}}
  return structuredClone(item);
 };
 let result=await f.bulk.command(f.env,'repair_availability',{run_id:BULK_RUN});assert.equal(result.availability_error.code,'lost_response');
 for(let i=0;i<6;i++){result=await f.bulk.command(f.env,'repair_availability',{run_id:BULK_RUN});if(result.availability_complete)break;}
 assert.equal(result.availability_complete,true);assert.equal(puts,4);assert.deepEqual([...items.values()].map(x=>x.price),[1600,1700,1800,1900,2000]);assert.ok([...items.values()].every(x=>x.sale_terms[0].value_name==='18 días'));assert.equal(f.books(),before);
});

test('availability repair blocks another seller, and reports a rejected or ignored PUT without changing permissions or resuming',async t=>{
 const f=await fixture(t);await f.bulk.command(f.env,'start',f.args);await f.bulk.command(f.env,'pause',{run_id:BULK_RUN});let puts=0;
 const item={id:'MLU100',seller_id:'440298103',currency_id:'UYU',price:1600,seller_custom_field:'AMADO-AR-'+f.rows[0].isbn,sale_terms:[{id:'MANUFACTURING_TIME',value_name:'19 días'}]};let reject=true;
 f.api.call=async(e,path,options={})=>{if(path==='/users/me')return {id:seller,site_id:'MLU'};if(options.method==='PUT'){puts++;if(reject)throw new MercadoLibreError('ml_http_403',403);}return structuredClone(item);};
 await assert.rejects(()=>f.bulk.command(f.env,'repair_availability',{run_id:BULK_RUN}),/identity_mismatch/);assert.equal(puts,0);
 item.seller_id=seller;let result=await f.bulk.command(f.env,'repair_availability',{run_id:BULK_RUN});assert.equal(result.availability_error.status,403);assert.equal(result.availability_complete,false);
 reject=false;result=await f.bulk.command(f.env,'repair_availability',{run_id:BULK_RUN});assert.equal(result.availability_error.code,'availability_update_not_confirmed');assert.equal((await f.s.run(BULK_RUN)).state,'paused');
});
test('reaching the target closes the run but keeps the remaining candidates pending, and raising the target reopens it',async t=>{
 const f=await fixture(t);await f.bulk.command(f.env,'start',f.args);
 await f.s.stmt("UPDATE ml_pub_jobs SET state='published',item_id='MLU'||isbn WHERE run_id=? AND isbn IN (SELECT isbn FROM ml_pub_jobs WHERE run_id=? AND state='pending' ORDER BY isbn LIMIT 9994)",BULK_RUN,BULK_RUN).run();
 await f.bulk.command(f.env,'tick',{run_id:BULK_RUN});
 const closed=await f.bulk.command(f.env,'tick',{run_id:BULK_RUN});assert.equal(closed.run.state,'complete');assert.equal(f.calls.create.length,1);
 const count=async state=>(await f.s.stmt('SELECT COUNT(*) n FROM ml_pub_jobs WHERE run_id=? AND state=?',BULK_RUN,state).first()).n;
 assert.equal(await count('skipped_target_reached'),0);assert.ok(await count('pending')>0);
 f.clock.value+=3600_000;
 assert.equal(await f.s.reopenForRaisedTarget(BULK_RUN,f.clock.value),false,'without a higher target nothing reopens');
 await f.s.raiseTarget(BULK_RUN,9996,20000);
 assert.equal(await f.s.reopenForRaisedTarget(BULK_RUN,f.clock.value),true);
 const reopened=await f.bulk.command(f.env,'tick',{run_id:BULK_RUN});assert.equal(f.calls.create.length,2);
 const again=await f.bulk.command(f.env,'tick',{run_id:BULK_RUN});assert.equal(again.run.state,'complete');assert.equal(f.calls.create.length,2);
});
test('the target can only go up, never past the ceiling, and only for an existing run',async t=>{
 const f=await fixture(t);await f.bulk.command(f.env,'start',f.args);
 await assert.rejects(()=>f.s.raiseTarget(BULK_RUN,9995,20000),/target_not_higher/);
 await assert.rejects(()=>f.s.raiseTarget(BULK_RUN,9000,20000),/target_not_higher/);
 await assert.rejects(()=>f.s.raiseTarget(BULK_RUN,20001,20000),/invalid_target/);
 await assert.rejects(()=>f.s.raiseTarget('otro-run',12000,20000),/target_not_found/);
 assert.deepEqual(await f.s.raiseTarget(BULK_RUN,12995,19995),{from:9995,to:12995});
 assert.equal((await f.s.target(BULK_RUN)).target_published,12995);
 assert.equal((await f.s.target(PILOT_RUN)).target_published,5,'the pilot target is untouched');
});
