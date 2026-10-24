import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {PublicationStore} from '../../worker-sync/publication-store.js';
import {VintageBulkStore,BULK_RUN} from '../_shared/meli-vintage-bulk.js';
import {run,MAX_TARGET_TOTAL,SELLER} from '../../scripts/vintage-local/engine.mjs';
import {setTarget} from '../../scripts/vintage-local/set-target.mjs';

function database(t){
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());
 const statement=(sql,args=[])=>({sql,args,bind(...values){return statement(sql,values);},async first(){return sqlite.prepare(sql).get(...args)??null;},async all(){return {results:sqlite.prepare(sql).all(...args)};},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}};}});
 return {prepare:sql=>statement(sql),async batch(statements){sqlite.exec('BEGIN');try{const out=statements.map(s=>{const p=sqlite.prepare(s.sql);return /^(SELECT|PRAGMA)\b|\bRETURNING\b/i.test(s.sql)?{results:p.all(...s.args),meta:{changes:1}}:{results:[],meta:{changes:Number(p.run(...s.args).changes)}};});sqlite.exec('COMMIT');return out;}catch(e){sqlite.exec('ROLLBACK');throw e;}},sqlite};
}
async function store(t){
 const db=database(t),s=new VintageBulkStore(db,{sellerId:SELLER});
 await new PublicationStore(db).initialize();await s.initialize();
 await s.stmt('INSERT INTO ml_pub_run_targets VALUES(?,?,?)',BULK_RUN,9995,0).run();
 return s;
}

test('set-target without --apply shows the change and writes nothing',async t=>{
 const s=await store(t);
 assert.deepEqual(await setTarget(s,13000),{from_total:10000,to_total:13000,published_total:5,applied:false});
 assert.equal((await s.target(BULK_RUN)).target_published,9995);
});

test('set-target --apply stores the new total minus the five pilot books',async t=>{
 const s=await store(t);
 assert.equal((await setTarget(s,13000,{apply:true})).applied,true);
 assert.equal((await s.target(BULK_RUN)).target_published,12995);
});

test('set-target refuses to lower the target, to pass the ceiling or to take a non-integer',async t=>{
 const s=await store(t);
 await assert.rejects(()=>setTarget(s,10000,{apply:true}),/target_not_higher/);
 await assert.rejects(()=>setTarget(s,9000,{apply:true}),/target_not_higher/);
 await assert.rejects(()=>setTarget(s,MAX_TARGET_TOTAL+1,{apply:true}),/invalid_target/);
 await assert.rejects(()=>setTarget(s,12000.5,{apply:true}),/invalid_target/);
 assert.equal((await s.target(BULK_RUN)).target_published,9995);
});

test('the engine accepts a target above the old 10000 limit but never above the ceiling',async()=>{
 await assert.rejects(()=>run({excel:'x',connection:'x',directory:'x',target:MAX_TARGET_TOTAL+1}),/invalid_local_limits/);
 await assert.rejects(()=>run({excel:'x',connection:'/no/existe/connection.json',directory:'x',target:15000}),error=>error.message!=='invalid_local_limits');
});
