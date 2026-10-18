import test from 'node:test';
import assert from 'node:assert/strict';
import {importBulkRows} from '../../astro-front/public/assets/meli-vintage-bulk-import.mjs';
test('stock ingestion uses at most four requests, visits each row once and only imports',async()=>{
 const rows=Array.from({length:1857},(_,isbn)=>({isbn})),seen=[],progress=[];let active=0,maximum=0;
 const count=await importBulkRows({rows,feed_id:'feed',send:async(action,args)=>{assert.equal(action,'import');assert.equal(args.feed_id,'feed');assert.ok(args.rows.length<=200);active++;maximum=Math.max(maximum,active);await new Promise(r=>setImmediate(r));seen.push(...args.rows.map(r=>r.isbn));active--;},onProgress:n=>progress.push(n)});
 assert.equal(count,rows.length);assert.equal(maximum,4);assert.equal(new Set(seen).size,rows.length);assert.equal(seen.length,rows.length);assert.equal(progress.at(-1),rows.length);
});
test('a failed stock request drains in-flight work and schedules no more chunks',async()=>{
 let calls=0,active=0;
 await assert.rejects(()=>importBulkRows({rows:Array.from({length:2000},(_,isbn)=>({isbn})),feed_id:'feed',send:async()=>{calls++;active++;await new Promise(r=>setImmediate(r));active--;throw Error('offline');}}),/offline/);
 assert.equal(calls,4);assert.equal(active,0);
});
