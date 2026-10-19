import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../../scripts/vintage-local/db.mjs';
import {syncStock,SELLER,MIN_WORKBOOK_ROWS} from '../../scripts/vintage-local/stock-sync.mjs';
import {MercadoLibreError} from '../../worker-sync/publication-meli.js';

const NOW=Date.parse('2026-10-19T04:30:00Z'),SOURCE='2026-10-19T01:04:20-03:00';
const isbnOf=n=>'9780000'+String(n).padStart(6,'0');
const workbook=(missing=[],count=MIN_WORKBOOK_ROWS+10)=>{const out=new Set(missing.map(isbnOf));const rows=[];for(let n=0;n<count;n++){const isbn=isbnOf(n);if(!out.has(isbn))rows.push({isbn,stock:'2'});}return rows;};

async function fixture(t,{published=10}={}){
 const db=openDatabase(':memory:');t.after(()=>db.close());
 await db.prepare('CREATE TABLE ml_vintage_pub_receipts (seller_id TEXT,isbn TEXT,state TEXT,item_id TEXT,run_id TEXT,created_at INTEGER,updated_at INTEGER)').run();
 const items=new Map(),puts=[],state={failPut:null};
 for(let n=0;n<published;n++){
  const isbn=isbnOf(n),id='MLU'+(1000+n);
  await db.prepare('INSERT INTO ml_vintage_pub_receipts VALUES(?,?,?,?,?,?,?)').bind(SELLER,isbn,'published',id,'run',1,1).run();
  items.set(id,{id,seller_id:Number(SELLER),status:'active',available_quantity:1,seller_custom_field:'AMADO-AR-'+isbn});
 }
 const api={async call(env,path,opts={}){
  if(path.startsWith('/items/bulk')){const ids=new URL('https://x'+path).searchParams.get('ids').split(',');return ids.map(id=>items.has(id)?{status_code:200,body:{...items.get(id)}}:{status_code:404,body:null});}
  const m=path.match(/^\/items\/(MLU\d+)$/);
  if(m&&opts.method==='PUT'){if(state.failPut)throw state.failPut;Object.assign(items.get(m[1]),opts.body);puts.push({id:m[1],body:opts.body});return {id:m[1]};}
  throw new Error('unexpected_call '+path);
 }};
 const run=(over={})=>syncStock({db,api,env:{},rows:workbook(),sourceDate:SOURCE,mode:'pause_only',now:()=>NOW,...over});
 return {db,items,puts,state,run,itemOf:n=>items.get('MLU'+(1000+n))};
}

test('report mode lists what would be paused and changes nothing on Mercado Libre',async t=>{
 const f=await fixture(t),result=await f.run({mode:'report',rows:workbook([2,3])});
 assert.equal(result.state,'reported');assert.equal(result.missing,2);assert.equal(result.would_pause,2);
 assert.deepEqual(result.would_pause_isbns,[isbnOf(2),isbnOf(3)]);assert.equal(f.puts.length,0);assert.equal(f.itemOf(2).status,'active');
});

test('pause_only pauses sold-out ISBNs once, never touches the rest and is idempotent',async t=>{
 const f=await fixture(t),rows=workbook([2,3]);
 const result=await f.run({rows});
 assert.equal(result.paused,2);assert.deepEqual(result.paused_isbns,[isbnOf(2),isbnOf(3)]);
 assert.equal(f.itemOf(2).status,'paused');assert.equal(f.itemOf(3).status,'paused');assert.equal(f.itemOf(4).status,'active');
 assert.deepEqual(f.puts.map(p=>p.body),[{status:'paused'},{status:'paused'}]);
 const again=await f.run({rows});assert.equal(again.paused,0);assert.equal(f.puts.length,2,'no second PUT for an already paused item');
});

test('pause_and_reactivate brings back only what this process paused, never a manual pause',async t=>{
 const f=await fixture(t);
 f.itemOf(5).status='paused'; // paused by hand, quantity still 1, supplier still has it
 const first=await f.run({mode:'pause_and_reactivate',rows:workbook([2,3])});
 assert.equal(first.paused,2);assert.equal(first.skipped_by_reason.paused_externally,1);assert.equal(f.itemOf(5).status,'paused');
 const later=Date.parse('2026-10-20T04:30:00Z');
 const second=await f.run({mode:'pause_and_reactivate',rows:workbook([3]),sourceDate:'2026-10-20T01:04:20-03:00',now:()=>later});
 assert.equal(second.activated,1);assert.deepEqual(second.activated_isbns,[isbnOf(2)]);
 assert.equal(f.itemOf(2).status,'active');assert.equal(f.itemOf(2).available_quantity,1);assert.deepEqual(f.puts.at(-1),{id:'MLU1002',body:{status:'active',available_quantity:1}});assert.equal(f.itemOf(3).status,'paused');assert.equal(f.itemOf(5).status,'paused');
});

test('pause_only does not reactivate when the book comes back',async t=>{
 const f=await fixture(t);await f.run({rows:workbook([2])});
 const later=Date.parse('2026-10-20T04:30:00Z');
 await f.run({rows:workbook(),sourceDate:'2026-10-20T01:04:20-03:00',now:()=>later});
 assert.equal(f.itemOf(2).status,'paused');assert.equal(f.puts.length,1);
});

test('a mass disappearance is treated as a broken file: nothing is paused',async t=>{
 const f=await fixture(t,{published:20}),result=await f.run({rows:workbook([0,1,2,3,4,5,6,7,8,9])});
 assert.equal(result.suspicious_feed,true);assert.equal(result.paused,0);assert.equal(f.puts.length,0);
});

test('items that are not ours by seller and SKU are skipped, not paused',async t=>{
 const f=await fixture(t);f.itemOf(1).seller_custom_field='OTHER-SKU';f.itemOf(2).seller_id=440298103;
 const result=await f.run({rows:workbook([1,2,3])});
 assert.equal(result.paused,1);assert.equal(result.skipped_by_reason.item_identity_mismatch,2);
 assert.equal(f.itemOf(1).status,'active');assert.equal(f.itemOf(2).status,'active');assert.equal(f.itemOf(3).status,'paused');
});

test('stale, incomplete or older-than-last files never pause anything',async t=>{
 const f=await fixture(t);
 assert.equal((await f.run({rows:workbook([2]),sourceDate:'2026-10-16T01:04:20-03:00'})).state,'feed_stale');
 assert.equal((await f.run({rows:workbook([2]).slice(0,100)})).state,'workbook_incomplete');
 assert.equal((await f.run({mode:'report',rows:workbook([2])})).state,'reported');
 assert.equal((await f.run({rows:workbook([2]),sourceDate:'2026-10-18T10:00:00-03:00'})).state,'older_than_last_sync');
 assert.equal(f.puts.length,0);
});

test('a 429 while pausing stops and retries later instead of continuing',async t=>{
 const f=await fixture(t);f.state.failPut=new MercadoLibreError('ml_http_429',429,30);
 const result=await f.run({rows:workbook([2,3])});
 assert.equal(result.state,'backoff');assert.equal(result.paused,0);assert.equal(f.itemOf(2).status,'active');
 f.state.failPut=null;const retried=await f.run({rows:workbook([2,3]),now:()=>NOW+10*60*1000});
 assert.equal(retried.paused,2);
});
