import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createSbsStock} from '../../worker-sync/sbs-supplier-stock.js';
import {PublicationStore} from '../../worker-sync/publication-store.js';
import {createPublicationRoutes} from '../../worker-sync/publication-routes.js';
import {refreshSbsStock,SBS_SOURCE} from '../../scripts/mercadolibre/refresh-sbs-stock.mjs';

function database(t){
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());
 const statement=(sql,args=[])=>({sql,args,bind(...values){return statement(sql,values);},async first(){return sqlite.prepare(sql).get(...args)??null;},async all(){return {results:sqlite.prepare(sql).all(...args)};},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}};}});
 return {prepare:sql=>statement(sql),async batch(items){sqlite.exec('BEGIN');try{const result=items.map(s=>({results:sqlite.prepare(s.sql).all(...s.args)}));sqlite.exec('COMMIT');return result;}catch(e){sqlite.exec('ROLLBACK');throw e;}},sqlite};
}
const clock=Date.parse('2026-10-17T16:00:00Z');
const rows=[{isbn:'9786075272795',title:'Libro',author:'Autor',publisher:'Editorial',listArs:27700,weightKg:.3,stock:'+2'}];
function input(){return {source_date:new Date(clock-1000).toISOString(),rows};}
function manifest(seed='file',date=input().source_date){const hash=createHash('sha256').update(seed).digest('hex');return {feed_id:`${hash.slice(0,8)}-${hash.slice(8,12)}-${hash.slice(12,16)}-${hash.slice(16,20)}-${hash.slice(20,32)}`,source_date:date,source_sha256:hash,expected_rows:rows.length};}

test('complete refresh is isolated, idempotent and never calls publication services or ML',async t=>{
 const db=database(t),books=new PublicationStore(db);await books.initialize();
 await books.beginFeed('old-books','2026-10-17T15:00:00Z',1,clock);await books.importRows('old-books',rows);await books.commitFeed('old-books');
 const tables=['ml_pub_feeds','ml_pub_stock','ml_pub_runs','ml_pub_jobs','ml_pub_receipts'];
 const dump=()=>JSON.stringify(tables.map(name=>db.sqlite.prepare(`SELECT * FROM ${name}`).all()));const before=dump();
 const supplier=createSbsStock({now:()=>clock});
 const route=createPublicationRoutes({supplier,service:{command(){throw Error('Publication service must not run');}},stockSync:{sync(){throw Error('Stock sync must not run');}}});
 const calls=[];
 const fetchImpl=async(url,options)=>{
  calls.push(String(url));
  if(String(url)===SBS_SOURCE){assert.equal(options.headers.Authorization,undefined);return new Response('supplier file');}
  assert.equal(String(url),'https://amadolibros-sync.undiaes.workers.dev/publisher/sbs-stock');
  assert.equal(options.headers.Authorization,'Bearer test-secret');
  return route(new Request(url,options),{ORDERS_DB:db},{admin:true});
 };
 const options={env:{SYNC_SECRET:'test-secret'},fetchImpl,parse:async()=>input(),now:()=>clock};
 const first=await refreshSbsStock(options);assert.equal(first.state,'stock_ready');assert.equal(first.rows,1);
 assert.equal((await refreshSbsStock(options)).state,'unchanged');
 assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM sbs_supplier_feeds').get().n,1);
 assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM sbs_supplier_stock').get().n,1);
 assert.equal((await supplier({ORDERS_DB:db},'status')).fresh,true);
 assert.equal(dump(),before);assert.equal(calls.length,6);
});

test('stale and future dates stop before authenticated ingestion and do not relabel download time',async()=>{
 for(const date of ['2026-08-25T01:04:11-03:00','2026-10-18T16:00:00Z']){
  let calls=0;
  await assert.rejects(()=>refreshSbsStock({env:{SYNC_SECRET:'secret'},fetchImpl:async()=>{calls++;return new Response('old workbook');},parse:async()=>({...input(),source_date:date}),now:()=>clock}),e=>e.code==='supplier_stock_stale_or_future'&&e.detail.source_date===date);
  assert.equal(calls,1);
 }
});

test('partial feed remains invisible, current stock cannot regress, ready snapshots cannot change',async t=>{
 const db=database(t),env={ORDERS_DB:db},command=createSbsStock({now:()=>clock}),m=manifest();
 await command(env,'begin',m);
 await assert.rejects(()=>command(env,'commit',{feed_id:m.feed_id}),/supplier_feed_count_mismatch/);
 assert.equal((await command(env,'status')).state,'no_stock');
 await command(env,'import',{feed_id:m.feed_id,rows});
 await command(env,'import',{feed_id:m.feed_id,rows});
 await assert.rejects(()=>command(env,'import',{feed_id:m.feed_id,rows:[{...rows[0],listArs:1}]}),/supplier_batch_changed/);
 await command(env,'commit',{feed_id:m.feed_id});
 await assert.rejects(()=>command(env,'import',{feed_id:m.feed_id,rows}),/supplier_feed_immutable/);
 await assert.rejects(()=>command(env,'begin',manifest('older',new Date(clock-3600000).toISOString())),/older_than_current/);
 await assert.rejects(()=>command(env,'begin',{...m,expected_rows:2}),/manifest_changed/);
 assert.equal((await command(env,'status')).latest.id,m.feed_id);
});

test('SBS route rejects unsigned access and publication commands',async t=>{
 const db=database(t),route=createPublicationRoutes(),url='https://example.com/publisher/sbs-stock';
 const unsigned=await route(new Request(url,{method:'POST',headers:{'content-type':'application/json'},body:'{}'}),{ORDERS_DB:db});assert.equal(unsigned.status,401);
 const invalid=await route(new Request(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'approve',args:{}})}),{ORDERS_DB:db},{admin:true});assert.equal(invalid.status,400);
});

test('transient ingestion response loss retries safely without repeating the source download',async()=>{
 let begins=0,downloads=0;const delays=[];
 const result=await refreshSbsStock({env:{SYNC_SECRET:'secret'},now:()=>clock,parse:async()=>input(),sleep:async ms=>delays.push(ms),fetchImpl:async(url,options)=>{
  if(String(url)===SBS_SOURCE){downloads++;return new Response('file');}
  const {action}=JSON.parse(options.body);
  if(action==='begin'&&++begins===1)throw Error('connection lost');
  return Response.json({state:action==='begin'?'ready':'ready'});
 }});
 assert.equal(result.state,'unchanged');assert.equal(begins,2);assert.equal(downloads,1);assert.deepEqual(delays,[2000]);
});

test('supplier parser supports one-digit dates and rejects price-only reports',()=>{
 execFileSync(process.env.SBS_PYTHON||'python3',[fileURLToPath(new URL('../../scripts/mercadolibre/test_supplier_feed.py',import.meta.url))],{encoding:'utf8'});
});
