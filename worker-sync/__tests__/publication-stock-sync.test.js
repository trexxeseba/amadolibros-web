import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sqliteD1} from './helpers/sqlite-d1.js';
import {PublicationStore} from '../publication-store.js';
import {createStockSync,stockSyncSettings} from '../publication-stock-sync.js';
import {MercadoLibreError} from '../publication-meli.js';

const SELLER='440298103';
const book=(isbn,stock='+2')=>({isbn,title:`Libro ${isbn}`,listArs:10000,weightKg:.2,stock});
const ISBNS=['9789502323060','9786075272795','9780140328721'];
async function fixture(t,{mode='pause_and_reactivate',published=ISBNS.slice(0,2),grace='20'}={}){
 const dir=await mkdtemp(join(tmpdir(),'amado-stock-sync-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const db=sqliteD1(join(dir,'sync.sqlite')),store=new PublicationStore(db),clock={value:Date.parse('2026-10-15T06:00:00Z')};
 await store.initialize();
 const items=new Map(),puts=[],gets=[];let putResponder=null;
 published.forEach((isbn,i)=>{const id=`MLU90000000${i+1}`;items.set(id,{id,seller_id:440298103,status:'active',available_quantity:1,seller_custom_field:`AMADO-AR-${isbn}`});});
 const runId=crypto.randomUUID();
 for(const [i,isbn] of published.entries()){assert.ok(await store.reserve(SELLER,isbn,runId,clock.value,10000));await store.receiptState(SELLER,isbn,'published',`MLU90000000${i+1}`);}
 const api={async call(env,path,{method='GET',body}={}){
  await new Promise(r=>setTimeout(r,2));
  if(method==='GET'&&path.startsWith('/items/bulk?ids=')){const params=new URL('https://x'+path).searchParams;const ids=params.get('ids').split(',');const attributes=(params.get('attributes')||'').split(',');assert.equal(attributes[0],'status_code','/items/bulk debe pedir status_code');assert.ok(attributes.length>=6&&attributes.slice(1).every(f=>f.startsWith('body.')),'/items/bulk attributes sin prefijo body.: '+params.get('attributes'));gets.push(ids);
   // Como la API real con attributes: la mitad de las entradas vienen proyectadas sin status_code.
   return ids.map((id,i)=>items.has(id)?(i%2?{body:items.get(id)}:{status_code:200,body:items.get(id)}):{status_code:404,body:{id}});}
  if(method==='PUT'&&/^\/items\/MLU\d+$/.test(path)){const id=path.slice(7);puts.push({id,body});if(putResponder){const out=putResponder({id,body});if(out instanceof Error)throw out;}Object.assign(items.get(id),body);return items.get(id);}
  throw Error('Unexpected '+method+' '+path);
 }};
 async function feed(rows,{at=clock.value}={}){const id=crypto.randomUUID();await store.beginFeed(id,new Date(at).toISOString(),rows.length,at);if(rows.length)await store.importRows(id,rows);await db.prepare("UPDATE ml_pub_feeds SET state='ready' WHERE id=?").bind(id).run();return id;}
 const env={ORDERS_DB:db,USER_ID:SELLER,ML_STOCK_SYNC_MODE:mode,ML_STOCK_SYNC_GRACE_HOURS:grace};
 const sync=createStockSync({api,now:()=>clock.value});
 return {db,store,clock,items,puts,gets,feed,env,sync,setPut:fn=>{putResponder=fn;}};
}
const row=(f,isbn)=>f.db.prepare('SELECT * FROM ml_pub_stock_sync WHERE seller_id=? AND isbn=?').bind(SELLER,isbn).first();

test('settings reject unknown modes and the default mode is disabled with no database access',async()=>{
 assert.equal(stockSyncSettings({}).mode,'disabled');assert.equal(stockSyncSettings({ML_STOCK_SYNC_MODE:'pause_only',ML_STOCK_SYNC_GRACE_HOURS:'48'}).graceHours,48);
 assert.throws(()=>stockSyncSettings({ML_STOCK_SYNC_MODE:'close'}),/invalid_stock_sync_mode/);assert.throws(()=>stockSyncSettings({ML_STOCK_SYNC_GRACE_HOURS:'-1'}),/invalid_stock_sync_setting/);
 assert.deepEqual(await createStockSync({api:{}}).sync({USER_ID:SELLER,ORDERS_DB:{prepare(){throw Error('must not touch the database');}}}),{state:'disabled'});
});
test('a disappearing ISBN is paused only after the grace period across fresh snapshots and reactivated when it returns',async t=>{
 const f=await fixture(t);
 await f.feed([book(ISBNS[0]),book(ISBNS[1])]);
 let result=await f.sync.sync(f.env);
 assert.equal(result.state,'synced');assert.equal(result.unchanged,2);assert.deepEqual(f.puts,[]);assert.equal((await row(f,ISBNS[0])).applied_status,'active');
 // First snapshot without the books: recorded, not paused.
 f.clock.value+=3600000;await f.feed([book(ISBNS[0],'0')]);
 result=await f.sync.sync(f.env);assert.equal(result.missing,2);assert.deepEqual(f.puts,[]);
 const first=await row(f,ISBNS[1]);assert.equal(first.missing_since,f.clock.value);assert.equal(first.desired_status,'active');
 // Still missing but within the grace period: nothing happens.
 f.clock.value+=10*3600000;await f.feed([book(ISBNS[0],'0')]);
 await f.sync.sync(f.env);assert.deepEqual(f.puts,[]);assert.equal((await row(f,ISBNS[1])).missing_since,first.missing_since);
 // Grace elapsed on a fresh snapshot: both paused, never closed.
 f.clock.value+=11*3600000;await f.feed([book(ISBNS[0],'0')]);
 result=await f.sync.sync(f.env);assert.equal(result.paused,2);
 assert.deepEqual(f.puts.map(p=>p.body),[{status:'paused'},{status:'paused'}]);assert.equal(f.items.get('MLU900000001').status,'paused');
 // Idempotent: same snapshot again, no further PUT.
 await f.sync.sync(f.env);assert.equal(f.puts.length,2);assert.equal((await row(f,ISBNS[0])).applied_status,'paused');
 // Stock returns for one book: reactivated with one unit; the other stays paused.
 f.clock.value+=3600000;await f.feed([book(ISBNS[0],'+3')]);
 result=await f.sync.sync(f.env);assert.equal(result.activated,1);assert.equal(result.paused,0);
 assert.deepEqual(f.puts.at(-1),{id:'MLU900000001',body:{status:'active',available_quantity:1}});assert.equal(f.items.get('MLU900000002').status,'paused');
 assert.ok(!f.puts.some(p=>p.body.status==='closed'));
});
test('pause_only never reactivates and report mode never calls Mercado Libre',async t=>{
 const f=await fixture(t,{mode:'pause_only',grace:'0'});
 await f.feed([book(ISBNS[0],'0'),book(ISBNS[1],'0')]);
 let result=await f.sync.sync(f.env);assert.equal(result.paused,2);
 f.clock.value+=3600000;await f.feed([book(ISBNS[0]),book(ISBNS[1])]);
 result=await f.sync.sync(f.env);assert.equal(result.activated,0);assert.equal(f.puts.length,2);assert.equal((await row(f,ISBNS[0])).desired_status,'active');
 const reporting={...f.env,ML_STOCK_SYNC_MODE:'report'};const reported=await f.sync.sync(reporting);
 assert.equal(reported.state,'reported');assert.equal(f.puts.length,2);assert.equal(f.gets.length,1);
});
test('a stale, absent or suspiciously incomplete snapshot never pauses anything',async t=>{
 const many=Array.from({length:24},(_,i)=>String(9780000000000+i*10).slice(0,12)).map(stem=>{const digits=[...stem].map(Number);const check=(10-digits.reduce((n,d,i)=>n+d*(i%2?3:1),0)%10)%10;return stem+check;});
 const f=await fixture(t,{published:many,grace:'0'});
 assert.equal((await f.sync.sync(f.env)).state,'feed_stale');assert.deepEqual(f.gets,[]);
 await f.feed(many.map(isbn=>book(isbn)));
 assert.equal((await f.sync.sync(f.env)).unchanged,24);
 // Only 2 of 24 remain: an incomplete file. Missing books are not advanced nor paused.
 f.clock.value+=3600000;await f.feed([book(many[0]),book(many[1])]);
 let result=await f.sync.sync(f.env);assert.equal(result.suspicious_feed,true);assert.equal(result.paused,0);assert.deepEqual(f.puts,[]);
 assert.equal((await row(f,many[5])).missing_since,0);
 // A fresh complete snapshot with a real drop below the threshold does pause.
 f.clock.value+=3600000;await f.feed(many.slice(0,20).map(isbn=>book(isbn)));
 result=await f.sync.sync(f.env);assert.equal(result.suspicious_feed,false);assert.equal(result.paused,4);
 // An expired snapshot stops everything again.
 f.clock.value+=25*3600000;assert.equal((await f.sync.sync(f.env)).state,'feed_stale');assert.equal(f.puts.length,4);
});
test('items that are closed, foreign by SKU or paused by hand are left alone',async t=>{
 const f=await fixture(t,{grace:'0',published:ISBNS});
 f.items.get('MLU900000001').status='closed';
 f.items.get('MLU900000002').seller_custom_field='OTRO-SKU';
 await f.feed(ISBNS.map(isbn=>book(isbn,'0')));
 const result=await f.sync.sync(f.env);
 assert.equal(result.skipped,2);assert.equal(result.paused,1);assert.deepEqual(f.puts,[{id:'MLU900000003',body:{status:'paused'}}]);
 assert.equal((await row(f,ISBNS[0])).last_error,'item_status_closed');assert.equal((await row(f,ISBNS[1])).last_error,'item_identity_mismatch');
 // A manual pause with stock kept is not reactivated; a sell-out pause is.
 f.clock.value+=3600000;const g=await fixture(t,{grace:'0'});
 g.items.get('MLU900000001').status='paused';g.items.get('MLU900000002').status='paused';g.items.get('MLU900000002').available_quantity=0;
 await g.feed([book(ISBNS[0]),book(ISBNS[1])]);
 const second=await g.sync.sync(g.env);assert.equal(second.activated,1);assert.equal(second.skipped,1);
 assert.deepEqual(g.puts,[{id:'MLU900000002',body:{status:'active',available_quantity:1}}]);assert.equal((await row(g,ISBNS[0])).last_error,'paused_externally');
});
test('rate limits defer the remaining work and transient errors back off per item',async t=>{
 const f=await fixture(t,{grace:'0'});
 await f.feed([book(ISBNS[0],'0'),book(ISBNS[1],'0')]);
 f.setPut(()=>new MercadoLibreError('ml_http_429',429,120));
 let result=await f.sync.sync(f.env);assert.equal(result.state,'backoff');assert.equal(result.paused,0);assert.equal(f.puts.length,1);
 const deferred=await row(f,ISBNS[1]);assert.equal(deferred.last_error,'ml_http_429');assert.ok(deferred.next_at>=f.clock.value+120000);assert.equal(deferred.applied_status,null);
 assert.equal((await row(f,ISBNS[0])).next_at,0);
 f.setPut(({id})=>id==='MLU900000001'?new MercadoLibreError('ml_http_503',503):null);
 // The 429 deferral has a five-minute floor even when Retry-After is shorter.
 f.clock.value+=6*60000;result=await f.sync.sync(f.env);assert.equal(result.errors,1);assert.equal(result.paused,1);
 assert.equal((await row(f,ISBNS[1])).applied_status,'paused');assert.equal((await row(f,ISBNS[0])).last_error,'ml_http_503');
 f.setPut(null);f.clock.value+=11*60000;result=await f.sync.sync(f.env);assert.equal(result.paused,1);assert.equal((await row(f,ISBNS[0])).applied_status,'paused');
 assert.ok(!f.puts.some(p=>p.body.status==='closed'));
});
test('concurrent runs are serialized by the database lock',async t=>{
 const f=await fixture(t);await f.feed([book(ISBNS[0]),book(ISBNS[1])]);
 const results=await Promise.all([f.sync.sync(f.env),f.sync.sync(f.env)]);
 assert.deepEqual(results.map(r=>r.state).sort(),['busy','synced']);assert.equal(f.gets.length,1);
 assert.equal((await f.sync.status(f.env)).running,false);
});
