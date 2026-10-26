import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../../scripts/vintage-local/db.mjs';
import {createLocalAccess} from '../_shared/vintage-local-access.js';
import {createVintageRenew,authorizeRenew,LIVE_WINDOW_MS} from '../_shared/vintage-renew.js';
import {createRenewRoute} from '../operations/vintage-renew.js';
import {localExecutorState} from '../_shared/vintage-executor-state.js';
import {VintageBulkStore,createVintageBulk,BULK_RUN,PILOT_RUN} from '../_shared/meli-vintage-bulk.js';
import {PublicationStore} from '../../worker-sync/publication-store.js';
import {createSbsStock} from '../../worker-sync/sbs-supplier-stock.js';
import {policyHash} from '../../worker-sync/publication-policy.js';
import {checkConfiguration} from '../../scripts/vintage-local/engine.mjs';
import {feedIdFromHash,renewConnection,downloadStock,sbsLogin,readSbsFile,SBS_SOURCE,SBS_PORTAL,SBS_PORTAL_LIST,RENEW_ENDPOINT} from '../../scripts/vintage-local/renew.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const policy={supplierDiscount:.25,arsPerUyu:40,usdPerUyu:42,freightUsdKg:15,laborUyu:0,margin:.23,mlFee:.17,deliveryUyu:270,minimumContributionUyu:200,minimumSaleUyu:1600,roundUyu:10,availabilityDays:18,additionalPricePct:0,listingTypeId:'gold_special',catalogListing:'required_only'};
const SECRET='r'.repeat(40),BEARER='Bearer '+SECRET;
function isbn13(n){const stem='978'+String(n).padStart(9,'0');const sum=[...stem].reduce((t,c,i)=>t+Number(c)*(i%2?3:1),0);return stem+((10-sum%10)%10);}
const supplierRows=count=>Array.from({length:count},(_,i)=>({isbn:isbn13(100000+i),title:`Libro ${i}`,author:'Autor',publisher:'Editorial',listArs:40000,weightKg:.5,stock:'2'}));

async function fixture(t,{secret=SECRET}={}){
 const db=openDatabase(':memory:');t.after(()=>db.close());
 const env={ORDERS_DB:db,APP_ENV:'production',...(secret?{VINTAGE_RENEW_SECRET:secret}:{})},clock={value:Date.now()},s=new VintageBulkStore(db,{sellerId:'2341378249'});
 await new PublicationStore(db).initialize();await s.initialize();
 const feed=crypto.randomUUID(),hash=await policyHash(policy),supplier=createSbsStock({now:()=>clock.value});
 await supplier(env,'begin',{feed_id:feed,source_date:new Date(clock.value).toISOString(),source_sha256:'e'.repeat(64),expected_rows:1});
 await supplier(env,'import',{feed_id:feed,rows:[{isbn:'9789502323060',title:'Test',listArs:40000,weightKg:.5,stock:'2'}]});await supplier(env,'commit',{feed_id:feed});
 await s.createRun({id:BULK_RUN,feedId:feed,policy,policyHash:hash,now:clock.value});
 await s.stmt("INSERT INTO ml_pub_runs(id,feed_id,policy_json,policy_hash,state,approved_hash,created_at,updated_at,index_json,daily_cap,preflight_limit) VALUES(?,?,?,?,'complete',?,?,?,'{}',5,5)",PILOT_RUN,feed,JSON.stringify(policy),hash,hash,clock.value,clock.value).run();
 await s.stmt('INSERT INTO ml_pub_run_targets(run_id,target_published,created_at) VALUES(?,?,?)',PILOT_RUN,5,clock.value).run();
 for(let i=0;i<5;i++){
  await s.stmt('INSERT INTO ml_pub_verifications VALUES(?,?,?,?)',PILOT_RUN,isbn13(i),clock.value,JSON.stringify({ok:true})).run();
  await s.stmt("INSERT INTO ml_pub_jobs(run_id,isbn,state,item_id) VALUES(?,?,'published',?)",PILOT_RUN,isbn13(i),'MLU'+(100+i)).run();
 }
 await db.prepare("INSERT INTO ml_pub_runs(id,feed_id,policy_json,policy_hash,state,created_at,updated_at,index_json,daily_cap,preflight_limit) VALUES('books',?,?,?,'ready',?,?,'{}',1000,5)").bind(feed,JSON.stringify({...policy,minimumSaleUyu:1200}),hash,clock.value,clock.value).run();
 const tokens={async getAccessToken(){return 'test-vintage-access';},async invalidateAccessToken(){}};
 const access=createLocalAccess({now:()=>clock.value,tokens});
 const bulk=createVintageBulk({api:{},now:()=>clock.value});
 const renew=createVintageRenew({bulk,access,now:()=>clock.value});
 const books=async()=>JSON.stringify(await db.prepare("SELECT * FROM ml_pub_runs WHERE id='books'").first());
 return {db,env,s,clock,hash,access,bulk,renew,books};
}
async function loadStock(f,rows){
 const sha=(String(rows.length)+'f'.repeat(64)).slice(0,64),feed_id=feedIdFromHash(sha),source_date=new Date(f.clock.value).toISOString();
 const begin=await f.renew.command(f.env,BEARER,'begin',{feed_id,source_date,source_sha256:sha,expected_rows:rows.length});
 if(begin.state!=='ready'){for(let i=0;i<rows.length;i+=200)await f.renew.command(f.env,BEARER,'import',{feed_id,rows:rows.slice(i,i+200)});await f.renew.command(f.env,BEARER,'commit',{feed_id});}
 return {feed_id,source_date};
}

test('without the renew secret nothing works, and a wrong secret is rejected before any read',async t=>{
 const unset=await fixture(t,{secret:''});
 await assert.rejects(()=>unset.renew.command(unset.env,BEARER,'status'),/renew_not_configured/);
 const f=await fixture(t);
 await assert.rejects(()=>f.renew.command(f.env,'Bearer '+'x'.repeat(40),'status'),/renew_unauthorized/);
 await assert.rejects(()=>authorizeRenew({VINTAGE_RENEW_SECRET:'short'},BEARER),/renew_not_configured/);
 await assert.rejects(()=>f.renew.command(f.env,BEARER,'tick'),/invalid_renew_action/);
});
test('renew loads the supplier stock, starts the Vintage run, pauses it for the PC and issues a usable connection',async t=>{
 const f=await fixture(t),before=await f.books(),rows=supplierRows(10000);
 const {feed_id,source_date}=await loadStock(f,rows);
 const c=await f.renew.command(f.env,BEARER,'renew',{feed_id});
 assert.equal(c.seller_id,'2341378249');assert.match(c.key,/^[a-f0-9]{64}$/);assert.equal(c.feed_id,feed_id);
 assert.equal(c.expires_at,Date.parse(source_date)+86400000);assert.equal(checkConfiguration(c).minimumSaleUyu,1600);
 assert.ok(!JSON.stringify(c).includes('refresh_token'));assert.ok(!JSON.stringify(c).includes(SECRET));
 const run=await f.s.run(BULK_RUN);assert.equal(run.state,'paused');assert.equal(run.feed_id,feed_id);
 assert.equal((await f.s.stmt('SELECT COUNT(*) n FROM ml_pub_jobs WHERE run_id=?',BULK_RUN).first()).n,10001);
 assert.equal((await localExecutorState(f.env,f.clock.value)).active,true);
 assert.equal((await f.access.command(f.env,c.key,'status')).seller_id,'2341378249');
 assert.equal((await f.renew.command(f.env,BEARER,'status')).run.state,'paused');
 assert.equal(await f.books(),before);
});
test('a live executor keeps its key; after revoke the old key is dead and a new one is issued',async t=>{
 const f=await fixture(t),{feed_id}=await loadStock(f,supplierRows(10000));
 const first=await f.renew.command(f.env,BEARER,'renew',{feed_id});
 await f.access.command(f.env,first.key,'status');
 await assert.rejects(()=>f.renew.command(f.env,BEARER,'renew',{feed_id}),/local_executor_running/);
 f.clock.value+=LIVE_WINDOW_MS+1;
 const second=await f.renew.command(f.env,BEARER,'renew',{feed_id});
 assert.notEqual(second.key,first.key);await assert.rejects(()=>f.access.command(f.env,first.key,'status'),/revoked/);
 await f.access.command(f.env,second.key,'status');
 await f.renew.command(f.env,BEARER,'revoke');
 await assert.rejects(()=>f.access.command(f.env,second.key,'status'),/revoked/);assert.equal((await f.s.run(BULK_RUN)).state,'paused');
 const third=await f.renew.command(f.env,BEARER,'renew',{feed_id});await f.access.command(f.env,third.key,'status');
});
test('renew refuses a stock snapshot that is too small or stale, without issuing a connection',async t=>{
 const f=await fixture(t),small=await loadStock(f,supplierRows(50));
 await assert.rejects(()=>f.renew.command(f.env,BEARER,'renew',{feed_id:small.feed_id}),/bulk_feed_not_ready/);
 assert.equal((await localExecutorState(f.env,f.clock.value)).active,false);
 const {feed_id}=await loadStock(f,supplierRows(10000));f.clock.value+=25*3600000;
 await assert.rejects(()=>f.renew.command(f.env,BEARER,'renew',{feed_id}),/bulk_feed_not_ready/);
 assert.equal((await localExecutorState(f.env,f.clock.value)).active,false);
});
test('the PC client downloads the supplier stock, loads it through the route and saves a connection the engine accepts',async t=>{
 const f=await fixture(t),route=createRenewRoute({renew:f.renew}),temp=await fs.mkdtemp(path.join(os.tmpdir(),'vintage-renew-'));t.after(()=>fs.rm(temp,{recursive:true,force:true}));
 const excel=path.join(temp,'stock.xlsx'),connection=path.join(temp,'private','connection.json'),bytes=Buffer.from('fake-workbook-bytes');
 const rows=supplierRows(10000),sha='a'.repeat(64),inspect=async file=>{assert.equal((await fs.readFile(file)).toString(),bytes.toString());return {source_date:new Date(f.clock.value).toISOString(),source_sha256:sha,rows};};
 const seen=[],fetcher=async(url,init)=>{
  if(url===SBS_SOURCE){seen.push('download');return new Response(bytes,{status:200});}
  assert.equal(url,RENEW_ENDPOINT);seen.push(JSON.parse(init.body).action);
  return route({env:f.env,request:new Request(url,{method:'POST',headers:init.headers,body:init.body})});
 };
 const result=await renewConnection({excel,connection,secret:SECRET,fetcher,inspect,now:()=>f.clock.value});
 assert.equal(result.state,'renewed');assert.equal(result.rows,10000);assert.equal(result.feed_id,feedIdFromHash(sha));
 assert.deepEqual(seen.slice(0,3),['download','revoke','begin']);assert.equal(seen.filter(x=>x==='import').length,50);assert.deepEqual(seen.slice(-2),['commit','renew']);
 const saved=JSON.parse(await fs.readFile(connection,'utf8'));assert.equal(checkConfiguration(saved).minimumSaleUyu,1600);assert.equal(saved.feed_id,feedIdFromHash(sha));
 assert.equal((await f.s.run(BULK_RUN)).feed_id,saved.feed_id);assert.equal((await f.s.run(BULK_RUN)).state,'paused');
 // the next day's renewal reuses nothing: the old key dies, the run moves to the new stock, the saved file is replaced
 f.clock.value+=23*3600000;const next=supplierRows(10001),sha2='b'.repeat(64);
 const again=await renewConnection({excel,connection,secret:SECRET,fetcher,now:()=>f.clock.value,inspect:async()=>({source_date:new Date(f.clock.value).toISOString(),source_sha256:sha2,rows:next})});
 assert.equal(again.feed_id,feedIdFromHash(sha2));await assert.rejects(()=>f.access.command(f.env,saved.key,'status'),/revoked/);
 const replaced=JSON.parse(await fs.readFile(connection,'utf8'));assert.notEqual(replaced.key,saved.key);await f.access.command(f.env,replaced.key,'status');
 // stale supplier stock is refused locally, before any request to the server
 const before=seen.length;
 await assert.rejects(()=>renewConnection({excel,connection,secret:SECRET,fetcher,now:()=>f.clock.value,inspect:async()=>({source_date:new Date(f.clock.value-48*3600000).toISOString(),source_sha256:'c'.repeat(64),rows:next})}),/supplier_stock_stale/);
 assert.equal(seen.length,before+1);assert.equal(seen.at(-1),'download');
 await assert.rejects(()=>renewConnection({excel,connection,secret:'short',fetcher,inspect,now:()=>f.clock.value}),/renew_secret_missing/);
 await assert.rejects(()=>downloadStock(SBS_SOURCE,{fetcher:async()=>new Response('',{status:503})}),/supplier_download_failed/);
 await assert.rejects(()=>downloadStock(SBS_SOURCE,{fetcher:async()=>new Response(new Uint8Array(65*1024*1024),{status:200})}),/supplier_file_too_large/);
});
test('the PC client logs into the SBS portal, downloads the complete list with the session cookie and never sends it elsewhere',async t=>{
 const f=await fixture(t),route=createRenewRoute({renew:f.renew}),temp=await fs.mkdtemp(path.join(os.tmpdir(),'vintage-sbs-'));t.after(()=>fs.rm(temp,{recursive:true,force:true}));
 const login=`${SBS_PORTAL}/Account/Login?ReturnUrl=${encodeURIComponent(SBS_PORTAL_LIST)}`,bytes=Buffer.from('portal-workbook'),calls=[];
 // portal falso con el mismo formulario que el real: token en cookie y campo oculto, POST Email/Password
 const portal=async(url,init={})=>{
  const cookies=init.headers?.Cookie??'';calls.push({url,method:init.method??'GET',cookies});
  if(url===login&&!init.method)return new Response('<form action="/Account/Login" method="post"><input name="__RequestVerificationToken" type="hidden" value="tok-1" /><input name="Email" /></form>',{status:200,headers:{'content-type':'text/html; charset=utf-8','set-cookie':'__RequestVerificationToken=cookie-1; path=/; HttpOnly'}});
  if(url===login&&init.method==='POST'){
   const body=new URLSearchParams(init.body);
   if(body.get('__RequestVerificationToken')!=='tok-1'||!cookies.includes('__RequestVerificationToken=cookie-1'))return new Response('bad token',{status:400});
   if(body.get('Email')!=='amadolibro@gmail.com'||body.get('Password')!=='clave-correcta')return new Response('<form>Intento inválido</form>',{status:200,headers:{'content-type':'text/html'}});
   return new Response('',{status:302,headers:{location:SBS_PORTAL_LIST,'set-cookie':'.AspNet.ApplicationCookie=session-9; path=/; HttpOnly'}});
  }
  if(url===SBS_PORTAL+SBS_PORTAL_LIST){
   if(!cookies.includes('.AspNet.ApplicationCookie=session-9'))return new Response('',{status:302,headers:{location:'/Account/Login?ReturnUrl=%2FHome%2FAllPriceList'}});
   return new Response('',{status:302,headers:{location:'https://files.example.com/lista.xlsx?sig=1'}});
  }
  if(url==='https://files.example.com/lista.xlsx?sig=1')return new Response(bytes,{status:200,headers:{'content-type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}});
  if(url===RENEW_ENDPOINT)return route({env:f.env,request:new Request(url,{method:'POST',headers:init.headers,body:init.body})});
  throw new Error('unexpected '+url);
 };
 const excel=path.join(temp,'stock.xlsx'),connection=path.join(temp,'connection.json'),sha='d'.repeat(64);
 const inspect=async file=>{assert.equal((await fs.readFile(file)).toString(),'portal-workbook');return {source_date:new Date(f.clock.value).toISOString(),source_sha256:sha,rows:supplierRows(10000)};};
 const result=await renewConnection({excel,connection,secret:SECRET,fetcher:portal,inspect,now:()=>f.clock.value,sbs:{email:'amadolibro@gmail.com',password:'clave-correcta'}});
 assert.equal(result.state,'renewed');assert.equal(result.feed_id,feedIdFromHash(sha));
 const s3=calls.find(c=>c.url.startsWith('https://files.example.com'));assert.equal(s3.cookies,'');
 const list=calls.find(c=>c.url===SBS_PORTAL+SBS_PORTAL_LIST);assert.ok(list.cookies.includes('.AspNet.ApplicationCookie=session-9'));
 assert.ok(!calls.some(c=>c.url===RENEW_ENDPOINT&&c.cookies));
 assert.equal(checkConfiguration(JSON.parse(await fs.readFile(connection,'utf8'))).minimumSaleUyu,1600);
 // el archivo que escribe el instalador (PowerShell 5.1) empieza con BOM
 const sbsFile=path.join(temp,'sbs.json');await fs.writeFile(sbsFile,'﻿{"email":"amadolibro@gmail.com","password":"AG#x_1"}');
 assert.deepEqual(await readSbsFile(sbsFile),{email:'amadolibro@gmail.com',password:'AG#x_1',portal:undefined});
 await assert.rejects(()=>sbsLogin({email:'amadolibro@gmail.com',password:'otra',fetcher:portal}),/sbs_login_rejected/);
 await assert.rejects(()=>sbsLogin({email:'',password:'x',fetcher:portal}),/sbs_credentials_missing/);
 await assert.rejects(()=>downloadStock(SBS_PORTAL+SBS_PORTAL_LIST,{fetcher:portal}),/supplier_login_required/);
 await assert.rejects(()=>downloadStock(SBS_SOURCE,{fetcher:async()=>new Response('<html>login</html>',{status:200,headers:{'content-type':'text/html'}})}),/supplier_login_required/);
});
test('the renew route accepts only its fixed actions and arguments and never a seller, run or URL',async()=>{
 let calls=0;const route=createRenewRoute({renew:{async command(){calls++;return {ok:true};}}}),env={APP_ENV:'production'},url='https://www.amadolibros.com/operations/vintage-renew';
 const post=(body,extra={})=>route({env,request:new Request(url,{method:'POST',headers:{'Content-Type':'application/json',...extra},body:typeof body==='string'?body:JSON.stringify(body)})});
 assert.equal((await route({env,request:new Request(url)})).status,400);
 for(const body of [{action:'tick',args:{}},{action:'renew',args:{feed_id:'x',seller_id:'440298103'}},{action:'start',args:{}},{action:'renew',args:{run_id:'y'}}])assert.equal((await post(body)).status,400);
 assert.equal((await post('x'.repeat(600000))).status,413);assert.equal(calls,0);
 assert.equal((await route({env:{APP_ENV:'preview'},request:new Request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})})).status,403);
 const ok=await post({action:'renew',args:{feed_id:'a'.repeat(8)+'-aaaa-aaaa-aaaa-aaaaaaaaaaaa'}},{Authorization:BEARER});
 assert.equal(ok.status,200);assert.equal(calls,1);assert.equal(ok.headers.get('cache-control'),'no-store');
});
test('renew switches the Vintage run to the competitive price once, as a recorded amendment the PC can follow',async t=>{
 const {amendmentChain}=await import('../../scripts/vintage-local/engine.mjs');
 const {vintageCompetitivePolicy,vintagePolicy}=await import('../../worker-sync/vintage-pricing.js');
 const f=await fixture(t),{feed_id}=await loadStock(f,supplierRows(10000));
 const old=(await f.s.run(BULK_RUN)).policy_hash;
 const c=await f.renew.command(f.env,BEARER,'renew',{feed_id});
 const run=await f.s.run(BULK_RUN),wanted=await policyHash(vintageCompetitivePolicy(vintagePolicy(policy)));
 assert.equal(run.policy_hash,wanted);assert.equal(run.approved_hash,wanted);assert.equal(c.policy_hash,wanted);
 assert.equal(c.policy.competitive,true);assert.equal(c.policy.competitiveFloorMargin,.18);assert.equal(c.policy.competitiveMinimumSaleUyu,1500);
 assert.equal(amendmentChain(c.amendments,old,wanted),true);
 // la segunda renovación no vuelve a enmendar
 f.clock.value+=LIVE_WINDOW_MS+1;
 const again=await f.renew.command(f.env,BEARER,'renew',{feed_id});
 assert.equal(again.policy_hash,wanted);assert.equal(again.amendments.length,c.amendments.length);
});
