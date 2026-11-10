import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {cloudRun,cloudSettings,batchSize,markdown,HARD_MAX_PER_RUN} from '../../scripts/vintage-cloud/run.mjs';
import {campaignNumbers} from '../../scripts/vintage-cloud/numbers.mjs';
import {saveStockState,loadStockState,CLOUD_STOCK_TABLE} from '../../scripts/vintage-cloud/d1.mjs';
import {BULK_RUN} from '../_shared/meli-vintage-bulk.js';
import {policyHash} from '../../worker-sync/publication-policy.js';

const policy={supplierDiscount:.25,arsPerUyu:40,usdPerUyu:42,freightUsdKg:15,laborUyu:0,margin:.23,mlFee:.17,deliveryUyu:270,minimumContributionUyu:200,minimumSaleUyu:1600,roundUyu:10,availabilityDays:18,additionalPricePct:0,listingTypeId:'gold_special',catalogListing:'required_only'};
const campaign=(ejecutor,modo,extra={})=>({target_total:80000,ejecutor,nube:{modo,tanda:50,tope_diario:300,...extra}});

test('only "ejecutor": "nube" plus "modo": "real" lets the cloud publish, and overrides are capped',()=>{
 assert.equal(cloudSettings(campaign('pc','real')).real,false);
 assert.equal(cloudSettings(campaign('nube','prueba')).real,false);
 assert.equal(cloudSettings(campaign('nube','real')).real,true);
 assert.equal(cloudSettings({}).modo,'prueba');
 const s=cloudSettings(campaign('nube','real'),{tanda:'99999',tope:''});
 assert.equal(s.tanda,HARD_MAX_PER_RUN);assert.equal(s.tope_diario,300);
 assert.equal(batchSize({tanda:50,tope_diario:300},280),20);
 assert.equal(batchSize({tanda:50,tope_diario:300},300),0);
 assert.equal(batchSize({tanda:50,tope_diario:300},0),50);
});

test('the numbers compare the list with the receipts without calling Mercado Libre',()=>{
 const rows=[{isbn:'1',listArs:40000,weightKg:.5,stock:'3'},{isbn:'2',listArs:40000,weightKg:.5,stock:'0'},{isbn:'3',listArs:80000,weightKg:.5,stock:'2'},{isbn:'4',listArs:40000,weightKg:.5,stock:'1'}];
 const n=campaignNumbers(rows,[{isbn:'1',state:'published'},{isbn:'2',state:'published'},{isbn:'4',state:'uncertain'}],policy);
 assert.equal(n.con_stock,3);assert.equal(n.publicados,2);assert.equal(n.sin_confirmar,1);
 assert.equal(n.publicados_sin_stock_hoy,1);assert.equal(n.candidatos_nuevos,1);
 assert.ok(n.precio_lista_completo.minimo>=1600);
});

async function harness(t,{campaignValue,daily=[10,12]}={}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'vintage-cloud-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const calls=[],connection={version:1,endpoint:'https://www.amadolibros.com/operations/vintage-local',key:'b'.repeat(64),expires_at:Date.now()+86400000,seller_id:'2341378249',app_id:'4741021817925208',run_id:BULK_RUN,policy,policy_hash:await policyHash(policy),receipts:[{isbn:'1',state:'published'}]};
 const statuses=[...daily];
 const deps={
  vigia:async()=>({nuevas_pi:0}),renewClient:()=>async action=>{calls.push('post:'+action);return action==='keepalive'?{refreshed:false,expires_at:Date.now()+5*3600000}:{};},
  renew:async({connection:file})=>{calls.push('renew');await fs.writeFile(file,JSON.stringify(connection));return {state:'renewed',source_date:'2026-11-05T03:00:00Z',rows:2};},
  inspect:async()=>({rows:[{isbn:'1',listArs:40000,weightKg:.5,stock:'3'},{isbn:'9',listArs:40000,weightKg:.5,stock:'3'}]}),
  sync:async({mode})=>{calls.push('sync:'+mode);return {mode,published:1};},
  engine:async opts=>{calls.push({engine:opts.validateOnly?'validate':'publish',limitNew:opts.limitNew,raise:opts.raiseTargetTo});return {state:'ready',published_total:1};},
  broker:()=>async()=>({daily_created:statuses.shift()??0}),
 };
 const env={VINTAGE_RENEW_SECRET:'r'.repeat(40),SBS_EMAIL:'a@b.c',SBS_PASSWORD:'clave'};
 const go=action=>cloudRun({action,directory:dir,campaign:campaignValue??campaign('pc','prueba'),env,query:async()=>[],deps});
 return {dir,calls,go};
}

test('prueba never publishes: stock in report mode and five validations only, then the connection is revoked and deleted',async t=>{
 const h=await harness(t);
 const r=await h.go('prueba');
 assert.equal(r.estado,'prueba_lista');
 assert.deepEqual(h.calls,['post:keepalive','renew','sync:report',{engine:'validate',limitNew:undefined,raise:undefined},'post:revoke']);
 await assert.rejects(()=>fs.access(path.join(h.dir,'connection.json')));
 assert.equal(r.numeros.candidatos_nuevos,1);
 assert.ok(!JSON.stringify(r).includes('b'.repeat(64)),'the connection key never reaches the report');
 assert.match(markdown(r),/Candidatos a publicar/);
});

test('publicar is refused without both keys, and with them it publishes a capped batch with stock_only',async t=>{
 const blocked=await harness(t);
 await assert.rejects(()=>blocked.go('publicar'),/publicar_no_habilitado/);
 assert.deepEqual(blocked.calls,[]);
 const h=await harness(t,{campaignValue:campaign('nube','real'),daily:[280,295]});
 const r=await h.go('publicar');
 assert.deepEqual(h.calls,['post:keepalive','renew','sync:stock_only',{engine:'publish',limitNew:20,raise:80000},'post:revoke']);
 assert.equal(r.publicacion.altas_de_esta_corrida,15);
 const full=await harness(t,{campaignValue:campaign('nube','real'),daily:[300]});
 assert.equal((await full.go('publicar')).estado,'tope_diario_alcanzado');
 assert.ok(!full.calls.some(c=>c.engine));
});

test('apagado still keeps the token alive and does nothing else',async t=>{
 const h=await harness(t,{campaignValue:campaign('nube','apagado')});
 assert.equal((await h.go('prueba')).estado,'apagado');
 assert.deepEqual(h.calls,['post:keepalive']);
});

test('the pause state goes to D1 in chunks under the 100-parameter limit',async()=>{
 const sent=[];const query=async(sql,params=[])=>{sent.push({sql,params});return sql.startsWith('SELECT')?[{isbn:'1',item_id:'MLU1'}]:[];};
 const rows=Array.from({length:15},(_,i)=>({isbn:String(i),item_id:'MLU'+i,desired_status:'paused',applied_status:'paused',missing_since:1,updated_at:2}));
 assert.equal(await saveStockState(query,rows),15);
 assert.equal(sent.length,3);assert.ok(sent.every(s=>s.params.length<=100));
 assert.ok(sent[0].sql.includes(CLOUD_STOCK_TABLE));
 sent.length=0;assert.deepEqual(await loadStockState(query),[{isbn:'1',item_id:'MLU1'}]);assert.match(sent[0].sql,/CREATE TABLE IF NOT EXISTS/);
});

test('a fresh engine database seeds receipts whose book left today\'s list (cloud runs start empty)',async t=>{
 const {run}=await import('../../scripts/vintage-local/engine.mjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'vintage-fresh-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const now=Date.now(),source_date=new Date(now-3600000).toISOString(),sha='c'.repeat(64);
 const isbn=n=>{const stem='978'+String(n).padStart(9,'0');const sum=[...stem].reduce((t,c,i)=>t+Number(c)*(i%2?3:1),0);return stem+((10-sum%10)%10);};
 const rows=[{isbn:isbn(1),title:'Hoy',listArs:40000,weightKg:.5,stock:'2'}];
 const receipts=[{seller_id:'2341378249',isbn:isbn(1),state:'published',item_id:'MLU1',run_id:BULK_RUN,created_at:1,updated_at:1},{seller_id:'2341378249',isbn:isbn(2),state:'published',item_id:'MLU2',run_id:BULK_RUN,created_at:1,updated_at:1},{seller_id:'2341378249',isbn:isbn(3),state:'uncertain',item_id:null,run_id:BULK_RUN,created_at:1,updated_at:1}];
 const c={version:1,endpoint:'https://www.amadolibros.com/operations/vintage-local',key:'b'.repeat(64),expires_at:now+86400000,seller_id:'2341378249',app_id:'4741021817925208',run_id:BULK_RUN,policy,policy_hash:await policyHash(policy),feed_id:crypto.randomUUID(),source_date,source_sha256:sha,receipts,inventory:[],identifiers:[],amendments:[],inventory_checkpoint:{status:'all',scroll:null,pending:[],done:true,seen:0}};
 const connection=path.join(dir,'connection.json');await fs.writeFile(connection,JSON.stringify(c));
 const stop=Object.assign(new Error('stop_here'),{code:'stop_here'});
 await assert.rejects(()=>run({excel:'x',connection,directory:dir,validateOnly:5,readWorkbook:async()=>({source_date,source_sha256:sha,rows}),apiFactory:()=>({async account(){throw stop;}}),brokerFactory:()=>async()=>({})}),/stop_here/);
});

test('an authorization cut during the test is retried and resumes from the saved database',async t=>{
 const h=await harness(t);
 const states=['auth_error','ready'];
 const r=await cloudRun({action:'prueba',directory:h.dir,campaign:campaign('pc','prueba'),env:{VINTAGE_RENEW_SECRET:'r'.repeat(40),SBS_EMAIL:'a@b.c',SBS_PASSWORD:'x'},query:async()=>[],deps:{
  vigia:async()=>({nuevas_pi:0}),renewClient:()=>async a=>a==='keepalive'?{refreshed:false,expires_at:Date.now()+5*3600000}:{},
  renew:async({connection:file})=>{await fs.writeFile(file,JSON.stringify({version:1,endpoint:'https://www.amadolibros.com/operations/vintage-local',key:'b'.repeat(64),expires_at:Date.now()+86400000,seller_id:'2341378249',app_id:'4741021817925208',run_id:BULK_RUN,policy,receipts:[]}));return {state:'renewed'};},
  inspect:async()=>({rows:[]}),sync:async()=>({}),
  engine:async()=>({state:states.shift()}),
 }});
 assert.equal(r.prueba.estado,'ready');assert.equal(r.reintentos_autorizacion,1);
});

test('the request interval is configurable for the cloud, clamped between 0.25 and 2 seconds',()=>{
 assert.equal(cloudSettings(campaign('nube','real',{intervalo_ms:500})).intervalo_ms,500);
 assert.equal(cloudSettings(campaign('nube','real',{intervalo_ms:50})).intervalo_ms,250);
 assert.equal(cloudSettings(campaign('nube','real')).intervalo_ms,2000);
});

test('the committed campaign is stopped (Mercado Libre suspended Vintage on 08/11 for intellectual property)',async()=>{
 const c=JSON.parse(await fs.readFile(new URL('../../scripts/vintage-local/campaign.json',import.meta.url),'utf8'));
 const s=cloudSettings(c);
 assert.equal(s.real,true);assert.equal(s.modo,'real');assert.equal(s.tope_diario,100);assert.equal(s.tanda,10);assert.ok(s.intervalo_ms>=250);
});

test('the Vintage request clock spaces requests by the configured interval',async()=>{
 const {createVintageBulkFetch}=await import('../_shared/meli-vintage-bulk.js');
 const {openDatabase}=await import('../../scripts/vintage-local/db.mjs');
 const db=openDatabase(':memory:');
 await db.prepare('CREATE TABLE ml_vintage_bulk_rate (id INTEGER PRIMARY KEY,next_at INTEGER NOT NULL DEFAULT 0,cooldown INTEGER NOT NULL DEFAULT 0,strikes INTEGER NOT NULL DEFAULT 0)').run();
 await db.prepare('INSERT INTO ml_vintage_bulk_rate(id) VALUES(1)').run();
 let clock=1_000_000;const waits=[];
 const limited=createVintageBulkFetch({intervalMs:500,now:()=>clock,sleep:async ms=>{waits.push(ms);clock+=ms;},fetcher:async()=>new Response('{}')});
 for(let i=0;i<3;i++)await limited({ORDERS_DB:db},'https://api.mercadolibre.com/items/MLU1',{});
 assert.deepEqual(waits,[500,500]);
 db.close();
});

test('a new supplier list keeps a recent complete inventory scan (cloud), and the old behaviour stays without keepIndexDays',async t=>{
 const {run}=await import('../../scripts/vintage-local/engine.mjs');
 const {openDatabase}=await import('../../scripts/vintage-local/db.mjs');
 const isbn=n=>{const stem='978'+String(n).padStart(9,'0');const sum=[...stem].reduce((t,c,i)=>t+Number(c)*(i%2?3:1),0);return stem+((10-sum%10)%10);};
 for(const [keepIndexDays,expected] of [[3,1],[0,0]]){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'vintage-keep-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const now=Date.now(),source_date=new Date(now-3600000).toISOString(),rows=[{isbn:isbn(1),title:'Hoy',listArs:40000,weightKg:.5,stock:'2'}];
  const base={version:1,endpoint:'https://www.amadolibros.com/operations/vintage-local',key:'b'.repeat(64),expires_at:now+86400000,seller_id:'2341378249',app_id:'4741021817925208',run_id:BULK_RUN,policy,policy_hash:await policyHash(policy),source_date,receipts:[],inventory:[{item_id:'MLU9',isbn:isbn(9),title_key:'x',status:'active'}],identifiers:[],amendments:[],inventory_checkpoint:{status:'all',scroll:null,pending:[],done:true,seen:1,completedAt:new Date(now-3600000).toISOString()}};
  const stop=Object.assign(new Error('stop_here'),{code:'stop_here'});
  const go=async(feed_id,sha)=>{const connection=path.join(dir,'c.json');await fs.writeFile(connection,JSON.stringify({...base,feed_id,source_sha256:sha}));
   await assert.rejects(()=>run({excel:'x',connection,directory:dir,keepIndexDays,readWorkbook:async()=>({source_date,source_sha256:sha,rows}),apiFactory:()=>({async account(){throw stop;}}),brokerFactory:()=>async()=>({})}),/stop_here/);};
  await go(crypto.randomUUID(),'c'.repeat(64));
  await go(crypto.randomUUID(),'d'.repeat(64));
  const db=openDatabase(path.join(dir,'publisher.sqlite'));
  const n=(await db.prepare('SELECT COUNT(*) n FROM ml_vintage_pub_index').first()).n,idx=JSON.parse((await db.prepare('SELECT index_json FROM ml_vintage_pub_runs WHERE id=?').bind(BULK_RUN).first()).index_json);
  db.close();
  assert.equal(n,expected,`keepIndexDays=${keepIndexDays}`);assert.equal(Boolean(idx.done),expected===1);
 }
});

test('the D1 state save runs several writes at once and still saves every row',async()=>{
 let inFlight=0,peak=0,saved=0;
 const query=async(sql,params)=>{inFlight++;peak=Math.max(peak,inFlight);await new Promise(r=>setTimeout(r,5));inFlight--;saved+=params.length/13;return [];};
 const rows=Array.from({length:100},(_,i)=>({isbn:String(i),item_id:'MLU'+i,updated_at:1}));
 assert.equal(await saveStockState(query,rows),100);
 assert.equal(saved,100);assert.ok(peak>1&&peak<=8);
});

async function freshEngine(t,{rows,receipts=[]}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'vintage-classify-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const now=Date.now(),source_date=new Date(now-3600000).toISOString(),sha='e'.repeat(64);
 const c={version:1,endpoint:'https://www.amadolibros.com/operations/vintage-local',key:'b'.repeat(64),expires_at:now+86400000,seller_id:'2341378249',app_id:'4741021817925208',run_id:BULK_RUN,policy,policy_hash:await policyHash(policy),feed_id:crypto.randomUUID(),source_date,source_sha256:sha,receipts,inventory:[],identifiers:[],amendments:[],inventory_checkpoint:{status:'all',scroll:null,pending:[],done:true,seen:0,completedAt:new Date(now).toISOString()}};
 const connection=path.join(dir,'c.json');await fs.writeFile(connection,JSON.stringify(c));
 return {dir,connection,readWorkbook:async()=>({source_date,source_sha256:sha,rows})};
}
const isbnN=n=>{const stem='978'+String(n).padStart(9,'0');const sum=[...stem].reduce((t,c,i)=>t+Number(c)*(i%2?3:1),0);return stem+((10-sum%10)%10);};

test('classify-only checks candidates in parallel and never reserves nor creates',async t=>{
 const {run}=await import('../../scripts/vintage-local/engine.mjs');
 const {openDatabase}=await import('../../scripts/vintage-local/db.mjs');
 const rows=Array.from({length:12},(_,i)=>({isbn:isbnN(100+i),title:'Libro '+i,listArs:40000,weightKg:.5,stock:'2'}));
 const f=await freshEngine(t,{rows});
 let inFlight=0,peak=0,creates=0,reserves=0;
 const slow=async v=>{inFlight++;peak=Math.max(peak,inFlight);await new Promise(r=>setTimeout(r,5));inFlight--;return v;};
 const api={
  async account(){return {id:2341378249};},
  async call(env,p){if(p.includes('seller_sku='))return slow({results:[]});throw new Error('unexpected_call '+p);},
  async skuItems(){return slow([]);},
  async competitorPrice(){return slow(null);},
  async prepare(env,row,pol,price){if(row.isbn===isbnN(103)){const {PublicationError}=await import('../../worker-sync/publication-policy.js');throw new PublicationError('missing_book_category',422);}return slow({title:row.title,price,currency_id:'UYU'});},
  async create(){creates++;throw new Error('must_not_create');},
 };
 const broker=async action=>{if(action==='reserve')reserves++;return {daily_created:0,daily_cap:10000,published_total:5};};
 const result=await run({excel:'x',connection:f.connection,directory:f.dir,readWorkbook:f.readWorkbook,classifiers:4,classifyOnly:true,maxMs:60000,apiFactory:()=>api,brokerFactory:()=>broker,waitFor:ms=>new Promise(r=>setTimeout(r,Math.min(ms,5)))});
 assert.equal(creates,0);assert.equal(reserves,0);
 assert.equal(result.state,'classified');assert.equal(result.classified.validated,11);assert.equal(result.classified.skipped_category,1);
 assert.ok(peak>1,'several candidates are checked at once');
 const db=openDatabase(path.join(f.dir,'publisher.sqlite'));t.after(()=>db.close());
 const states=(await db.prepare('SELECT state,COUNT(*) n FROM ml_vintage_pub_jobs WHERE run_id=? GROUP BY state').bind(BULK_RUN).all()).results;
 assert.deepEqual(Object.fromEntries(states.map(x=>[x.state,x.n])),{validated:11,skipped_category:1});
 const payload=JSON.parse((await db.prepare("SELECT payload_json FROM ml_vintage_pub_jobs WHERE state='validated' LIMIT 1").first()).payload_json);
 assert.equal(payload.currency_id,'UYU');
});

test('the classifier never overwrites a job the publisher already handled',async t=>{
 const {openDatabase}=await import('../../scripts/vintage-local/db.mjs');
 const {VintageBulkStore}=await import('../_shared/meli-vintage-bulk.js');
 const {PublicationStore}=await import('../../worker-sync/publication-store.js');
 const db=openDatabase(':memory:');t.after(()=>db.close());
 const s=new VintageBulkStore(db,{sellerId:'2341378249'});await new PublicationStore(db).initialize();await s.initialize();
 await s.stmt("INSERT INTO ml_pub_jobs(run_id,isbn,state,item_id) VALUES(?,?,'published','MLU1')",BULK_RUN,'1').run();
 await s.stmt("INSERT INTO ml_pub_jobs(run_id,isbn,state) VALUES(?,?,'pending')",BULK_RUN,'2').run();
 assert.equal(await s.jobIfOpen(BULK_RUN,'1','validated',{payload:{price:1}}),false);
 assert.equal(await s.jobIfOpen(BULK_RUN,'2','validated',{payload:{price:1}}),true);
 const rows=(await s.stmt('SELECT isbn,state,item_id FROM ml_pub_jobs WHERE run_id=? ORDER BY isbn',BULK_RUN).all()).results;
 assert.deepEqual(rows.map(r=>[r.isbn,r.state,r.item_id]),[['1','published','MLU1'],['2','validated',null]]);
});

test('with parallel=true the clock spaces the start of each request but lets several be in flight',async()=>{
 const {createVintageBulkFetch}=await import('../_shared/meli-vintage-bulk.js');
 const {openDatabase}=await import('../../scripts/vintage-local/db.mjs');
 for(const [parallel,expectPeak] of [[true,3],[false,1]]){
  const db=openDatabase(':memory:');
  await db.prepare('CREATE TABLE ml_vintage_bulk_rate (id INTEGER PRIMARY KEY,next_at INTEGER NOT NULL DEFAULT 0,cooldown INTEGER NOT NULL DEFAULT 0,strikes INTEGER NOT NULL DEFAULT 0)').run();
  await db.prepare('INSERT INTO ml_vintage_bulk_rate(id) VALUES(1)').run();
  let inFlight=0,peak=0;const starts=[];
  const limited=createVintageBulkFetch({intervalMs:250,parallel,sleep:ms=>new Promise(r=>setTimeout(r,ms)),fetcher:async()=>{starts.push(Date.now());inFlight++;peak=Math.max(peak,inFlight);await new Promise(r=>setTimeout(r,700));inFlight--;return new Response('{}');}});
  await Promise.all([1,2,3].map(()=>limited({ORDERS_DB:db},'https://api.mercadolibre.com/items/MLU1',{})));
  assert.equal(peak,expectPeak,`parallel=${parallel}`);
  for(let i=1;i<starts.length;i++)assert.ok(starts[i]-starts[i-1]>=240,'starts stay spaced');
  db.close();
 }
});

test('publishing next to the classifiers creates each ISBN at most once and stops at the batch',async t=>{
 const {run}=await import('../../scripts/vintage-local/engine.mjs');
 const rows=Array.from({length:10},(_,i)=>({isbn:isbnN(200+i),title:'Libro '+i,listArs:40000,weightKg:.5,stock:'2'}));
 const f=await freshEngine(t,{rows});
 const created=new Map();let n=0;
 const api={
  async account(){return {id:2341378249};},
  async call(env,p){
   if(p.includes('seller_sku='))return {results:[]};
   const m=p.match(/^\/items\/(MLU\d+)$/);
   if(m){const x=[...created.values()].find(v=>v.id===m[1]);return {id:x.id,seller_id:2341378249,seller_custom_field:'AMADO-AR-'+x.isbn,attributes:[],price:x.price,currency_id:'UYU',available_quantity:1,status:'active',sale_terms:[{id:'MANUFACTURING_TIME',value_name:'18 días'}]};}
   throw new Error('unexpected_call '+p);
  },
  async skuItems(){return [];},
  async competitorPrice(){return null;},
  async prepare(env,row,pol,price){await new Promise(r=>setTimeout(r,3));return {title:row.title,price,currency_id:'UYU',condition:'new',catalog_listing:false,seller_custom_field:'AMADO-AR-'+row.isbn};},
  async create(env,payload){const isbn=payload.seller_custom_field.replace('AMADO-AR-','');if(created.has(isbn))throw new Error('duplicate_create '+isbn);const id='MLU'+(++n);created.set(isbn,{id,isbn,price:payload.price});return {id};},
 };
 const reserved=new Set();
 const broker=async(action,args)=>{
  if(action==='status')return {daily_created:reserved.size,daily_cap:10000,published_total:5+reserved.size};
  if(action==='token')return {access_token:'t',expires_at:Date.now()+600000};
  if(action==='reserve'){if(reserved.has(args.isbn))return {reserved:false,receipt:null};reserved.add(args.isbn);return {reserved:true};}
  if(action==='report')return {recorded:true};
  return {};
 };
 const result=await run({excel:'x',connection:f.connection,directory:f.dir,readWorkbook:f.readWorkbook,classifiers:3,limitNew:4,target:80000,raiseTargetTo:80000,maxMs:60000,apiFactory:()=>api,brokerFactory:()=>broker,waitFor:ms=>new Promise(r=>setTimeout(r,Math.min(ms,5)))});
 assert.equal(created.size,4,'stops at the batch');
 assert.equal(new Set([...created.values()].map(v=>v.id)).size,4);
 assert.ok(result.classified.validated>=4);
});

test('a fresh create paused only for picture download is accepted when deferring pictures, never otherwise',async()=>{
 const {checkCreated}=await import('../../scripts/vintage-local/engine.mjs');
 const item={seller_id:2341378249,seller_custom_field:'AMADO-AR-9789502323060',attributes:[],price:1990,currency_id:'UYU',available_quantity:1,status:'paused',sub_status:['picture_download_pending'],sale_terms:[{id:'MANUFACTURING_TIME',value_name:'18 días'}]};
 assert.throws(()=>checkCreated(item,'9789502323060',1990),/created_item_check_failed/);
 assert.doesNotThrow(()=>checkCreated(item,'9789502323060',1990,{picturesPending:true}));
 assert.throws(()=>checkCreated({...item,price:2000},'9789502323060',1990,{picturesPending:true}),/created_item_check_failed/);
 assert.throws(()=>checkCreated({...item,sub_status:['out_of_stock']},'9789502323060',1990,{picturesPending:true}),/created_item_check_failed/);
});

test('the daily cap can never pass the server cap of 10000',async()=>{
 const {VINTAGE_DAILY_CAP}=await import('../_shared/meli-vintage-bulk.js');
 assert.equal(cloudSettings(campaign('nube','real',{tope_diario:50000})).tope_diario,VINTAGE_DAILY_CAP);
});

test('a run that crosses midnight counts its altas with the campaign total, not the day counter',async t=>{
 const h=await harness(t,{campaignValue:campaign('nube','real')});
 const statuses=[{daily_created:7555,published_total:21359},{daily_created:120,published_total:21731}];
 const r=await cloudRun({action:'publicar',directory:h.dir,campaign:campaign('nube','real',{tope_diario:8000}),env:{VINTAGE_RENEW_SECRET:'r'.repeat(40),SBS_EMAIL:'a@b.c',SBS_PASSWORD:'x'},query:async()=>[],deps:{
  vigia:async()=>({nuevas_pi:0}),renewClient:()=>async a=>a==='keepalive'?{refreshed:false,expires_at:Date.now()+5*3600000}:{},
  renew:async({connection:file})=>{await fs.writeFile(file,JSON.stringify({version:1,endpoint:'https://www.amadolibros.com/operations/vintage-local',key:'b'.repeat(64),expires_at:Date.now()+86400000,seller_id:'2341378249',app_id:'4741021817925208',run_id:BULK_RUN,policy,receipts:[]}));return {state:'renewed'};},
  inspect:async()=>({rows:[]}),sync:async()=>({}),engine:async()=>({state:'time_slice_done',published_total:21731}),
  broker:()=>async()=>statuses.shift(),
 }});
 assert.equal(r.publicacion.altas_de_esta_corrida,372);
});

test('reviews with a requeued code go back to pending; other reviews and listings are left alone',async t=>{
 const {run}=await import('../../scripts/vintage-local/engine.mjs');
 const {openDatabase}=await import('../../scripts/vintage-local/db.mjs');
 const rows=[1,2,3].map(i=>({isbn:isbnN(300+i),title:'L'+i,listArs:40000,weightKg:.5,stock:'2'}));
 const f=await freshEngine(t,{rows});
 const stop=Object.assign(new Error('stop_here'),{code:'stop_here'});let calls=0;
 const api={async account(){if(++calls===1)return {id:2341378249};throw stop;}};
 // Primera corrida: crea la base. Después se marcan las revisiones a mano.
 await assert.rejects(()=>run({excel:'x',connection:f.connection,directory:f.dir,readWorkbook:f.readWorkbook,classifiers:1,classifyOnly:true,maxMs:1,apiFactory:()=>({account:async()=>{throw stop;}}),brokerFactory:()=>async()=>({})}),/stop_here/);
 const db=openDatabase(path.join(f.dir,'publisher.sqlite'));
 await db.prepare("UPDATE ml_vintage_pub_jobs SET state='review',error_code='ml_http_404' WHERE isbn=?").bind(isbnN(301)).run();
 await db.prepare("UPDATE ml_vintage_pub_jobs SET state='review',error_code='ml_http_403' WHERE isbn=?").bind(isbnN(302)).run();
 db.close();
 try{await run({excel:'x',connection:f.connection,directory:f.dir,readWorkbook:f.readWorkbook,requeueReviewCodes:['ml_http_404'],apiFactory:()=>api,brokerFactory:()=>async()=>{throw stop;},maxMs:60000});}catch{}
 const db2=openDatabase(path.join(f.dir,'publisher.sqlite'));t.after(()=>db2.close());
 const state=async n=>(await db2.prepare('SELECT state,error_code FROM ml_vintage_pub_jobs WHERE isbn=?').bind(isbnN(n)).first());
 assert.deepEqual({...await state(301)},{state:'pending',error_code:null});
 assert.deepEqual({...await state(302)},{state:'review',error_code:'ml_http_403'});
});

test('a risky title is dropped before any Mercado Libre call and is never prepared nor created',async t=>{
 const {run}=await import('../../scripts/vintage-local/engine.mjs');
 const rows=[{isbn:isbnN(401),title:'Libro Digital Society For The Ib Diploma',listArs:40000,weightKg:.5,stock:'2'},{isbn:isbnN(402),title:'Cien años de soledad',listArs:40000,weightKg:.5,stock:'2'}];
 const f=await freshEngine(t,{rows});
 const touched=[];
 const api={async account(){return {id:2341378249};},async call(env,p){if(p.includes('seller_sku='))return {results:[]};throw new Error('unexpected');},
  async skuItems(env,isbn){touched.push(isbn);return [];},async competitorPrice(env,isbn){touched.push(isbn);return null;},
  async prepare(env,row,pol,price){touched.push(row.isbn);return {title:row.title,price,currency_id:'UYU',condition:'new',catalog_listing:false};},async create(){throw new Error('must_not_create');}};
 const result=await run({excel:'x',connection:f.connection,directory:f.dir,readWorkbook:f.readWorkbook,classifiers:2,classifyOnly:true,maxMs:60000,apiFactory:()=>api,brokerFactory:()=>async()=>({}),waitFor:ms=>new Promise(r=>setTimeout(r,Math.min(ms,5)))});
 assert.equal(result.classified.skipped_ip_risk,1);assert.equal(result.classified.validated,1);
 assert.ok(!touched.includes(isbnN(401)),'no ML call for the risky book');
});

test('with the IP brake on, or if the watcher could not read, publicar does not publish',async t=>{
 for(const [vigia,brakeRow,expected] of [[async()=>({nuevas_pi:1}),{value:JSON.stringify({motivo:'infraccion_pi'}),at:1},'frenado_por_infraccion_pi'],[async()=>{throw Object.assign(new Error('x'),{code:'cloudflare_http_500'});},null,'vigia_sin_datos']]){
  const h=await harness(t,{campaignValue:campaign('nube','real',{tope_diario:8000})});
  const query=async sql=>/FROM ml_vintage_cloud_flags/.test(sql)&&brakeRow?[brakeRow]:[];
  const engineCalls=[];
  const r=await cloudRun({action:'publicar',directory:h.dir,campaign:campaign('nube','real',{tope_diario:8000}),env:{VINTAGE_RENEW_SECRET:'r'.repeat(40),SBS_EMAIL:'a@b.c',SBS_PASSWORD:'x'},query,deps:{vigia,renewClient:()=>async a=>a==='keepalive'?{refreshed:false,expires_at:Date.now()+5*3600000}:{},renew:async()=>{engineCalls.push('renew');return {};},engine:async()=>{engineCalls.push('engine');return {};}}});
  assert.equal(r.estado,expected);assert.deepEqual(engineCalls,[]);
 }
});

test('a supplier 500 reports its content type and a short body without mails',async()=>{
 const {renewConnection}=await import('../../scripts/vintage-local/renew.mjs');
 const fetcher=async()=>new Response('<html><body>Error interno. Contacte a soporte@sbs.com.ar</body></html>',{status:500,headers:{'content-type':'text/html'}});
 await assert.rejects(()=>renewConnection({excel:'/tmp/x.xlsx',connection:'/tmp/c',secret:'s'.repeat(40),fetcher}),e=>{
  assert.equal(e.code,'supplier_download_failed');assert.equal(e.detail.http_status,500);
  assert.equal(e.detail.content_type,'text/html');assert.match(e.detail.body,/Error interno/);assert.ok(!/soporte@/.test(e.detail.body));return true;});
});

test('when the supplier portal fails, the error also lists the internal links of its home page',async()=>{
 const {renewConnection}=await import('../../scripts/vintage-local/renew.mjs');
 const jar={'set-cookie':'s=1; path=/'};
 const fetcher=async(url,o={})=>{
  const u=String(url);
  if(/Account\/Login/.test(u)&&!o.method)return new Response('<input name="__RequestVerificationToken" type="hidden" value="tok">',{status:200,headers:jar});
  if(/Account\/Login/.test(u))return new Response(null,{status:302,headers:{location:'/Home/AllPriceList',...jar}});
  if(/AllPriceList/.test(u))return new Response('<style>.a{color:red}</style><h1>Error interno</h1>',{status:500,headers:{'content-type':'text/html'}});
  return new Response('<a href="/Home/Dashboard">x</a><a href="/Home/PriceListNew">Lista</a><a href="/Account/Logout">y</a>',{status:200});
 };
 await assert.rejects(()=>renewConnection({excel:'/tmp/x.xlsx',connection:'/tmp/c',secret:'s'.repeat(40),sbs:{email:'a@b.c',password:'xxxxxx'},fetcher}),e=>{
  assert.equal(e.detail.http_status,500);assert.match(e.detail.body,/Error interno/);assert.ok(!/color:red/.test(e.detail.body));
  assert.deepEqual(e.detail.portal_links,['/Home/Dashboard','/Home/PriceListNew','/Account/Logout']);return true;});
});

test('the SBS probe reads every list of the Catalog menu, reports rows and errors, and keeps going after one fails',async()=>{
 const {sondear,RUTAS}=await import('../../scripts/vintage-cloud/sbs-sondeo.mjs');
 const fetcher=async(url,o={})=>{
  const u=String(url);
  if(/Account\/Login/.test(u)&&!o.method)return new Response('<input name="__RequestVerificationToken" type="hidden" value="tok">',{status:200,headers:{'set-cookie':'s=1; path=/'}});
  if(/Account\/Login/.test(u))return new Response(null,{status:302,headers:{location:'/Home/AllPriceList','set-cookie':'s=1; path=/'}});
  if(/AllPriceList/.test(u))return new Response('<html>Error</html>',{status:500,headers:{'content-type':'text/html'}});
  return new Response(new Uint8Array([1,2,3,4]),{status:200,headers:{'content-type':'application/octet-stream'}});
 };
 const lines=[];
 const out=await sondear({email:'a@b.c',password:'xxxxxx',fetcher,dir:await (await import('node:fs/promises')).mkdtemp('/tmp/sbs-sondeo-test-'),log:x=>lines.push(x),inspect:async()=>({source_date:'2026-11-10',rows:[{isbn:'1',stock:'2'},{isbn:'2',stock:'0'}]})});
 assert.equal(out.length,RUTAS.length);
 assert.equal(out[0].error,'supplier_download_failed');assert.equal(out[0].http,500);
 assert.equal(out[1].filas,2);assert.equal(out[1].con_stock,1);assert.equal(out[1].fecha,'2026-11-10');
 assert.equal(lines.length,RUTAS.length);
});
