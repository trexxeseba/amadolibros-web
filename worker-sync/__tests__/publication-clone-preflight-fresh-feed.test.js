import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sqliteD1} from './helpers/sqlite-d1.js';
import {PublicationStore} from '../publication-store.js';
import {createPublicationService,clonePreflightRunId,CLONE_PREFLIGHT_FRESH_FEED_LIMIT} from '../publication-engine.js';
import {policyHash,validPolicy,quoteMercadoLibre,PublicationError} from '../publication-policy.js';

const policy={supplierDiscount:.2,arsPerUyu:40,usdPerUyu:40,freightUsdKg:10,laborUyu:0,margin:.2,mlFee:.15,deliveryUyu:200,minimumContributionUyu:100,minimumSaleUyu:1000,roundUyu:10,availabilityDays:10,additionalPricePct:0,listingTypeId:'gold_special'};
const SOURCE_CODE='catalog_required_needs_review';
const HOUR=3600000;
const isbn=n=>{const stem='97895023'+String(n).padStart(4,'0');const check=(10-[...stem].reduce((s,c,i)=>s+Number(c)*(i%2?3:1),0)%10)%10;return stem+check;};
// Eight catalog books in review on the source run, plus one blocked for another reason.
const catalogBooks=Array.from({length:8},(_,i)=>({isbn:isbn(i+1),title:`Libro catálogo ${i+1}`,listArs:10000+i*100,weightKg:.2,stock:'+2'}));
const otherBook={isbn:isbn(101),title:'Libro identidad',listArs:12000,weightKg:.2,stock:'+1'};
const selected=catalogBooks.map(b=>b.isbn).sort().slice(0,CLONE_PREFLIGHT_FRESH_FEED_LIMIT);
// Today's supplier snapshot for the selected ISBNs, with a different price than the old feed.
const freshRows=catalogBooks.filter(b=>selected.includes(b.isbn)).map(b=>({...b,listArs:b.listArs+5000,stock:'1'}));

// The source run's feed was loaded yesterday: the clock starts 25 h later, so it is stale.
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'amado-clone-fresh-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const db=sqliteD1(join(dir,'queue.sqlite')),store=new PublicationStore(db),loadedAt=Date.now()-25*HOUR,feedId=crypto.randomUUID(),sourceId=crypto.randomUUID();
 const env={ORDERS_DB:db,USER_ID:'440298103',APP_ID:'4741021817925208',ML_PUBLISHER_MODE:'enabled'};
 const rows=[...catalogBooks,otherBook];
 await store.initialize();await store.beginFeed(feedId,new Date(loadedAt).toISOString(),rows.length,loadedAt);await store.importRows(feedId,rows);await store.commitFeed(feedId);
 await store.createRun({id:sourceId,feedId,policy,policyHash:await policyHash(policy),now:loadedAt,dailyCap:10000,preflightLimit:10});
 await store.saveIndex(sourceId,{status:'paused',scroll:null,pending:[],done:true,seen:0,completedAt:new Date(loadedAt).toISOString()},[{id:'MLU900000777',isbn:isbn(777),titleKey:'otrolibro',status:'active'}]);
 for(const book of catalogBooks)await store.job(sourceId,book.isbn,'review',{errorCode:SOURCE_CODE});
 await store.job(sourceId,otherBook.isbn,'review',{errorCode:'product_identity_mismatch'});
 await db.prepare("UPDATE ml_pub_runs SET state='ready' WHERE id=?").bind(sourceId).run();
 const calls={create:0,prepare:0,rows:[]};
 const api={
  async skuItems(){return [];},
  async prepare(env,row,p,price){
   calls.prepare++;calls.rows.push(row);
   if(p.catalogListing!=='required_only')throw new PublicationError(SOURCE_CODE,422);
   return {title:row.title,price,currency_id:'UYU',condition:'new',catalog_listing:true,catalog_product_id:`MLU1${row.isbn.slice(-5)}`,seller_custom_field:`AMADO-AR-${row.isbn}`};
  },
  async create(){calls.create++;throw Error('POST /items must never run during the catalog preflight');},
 };
 const clock={value:Date.now()},service=createPublicationService({api,storeFactory:()=>store,now:()=>clock.value});
 const snapshot=async()=>({run:await store.run(sourceId),jobs:(await db.prepare('SELECT isbn,state,error_code,payload_json,item_id,attempts FROM ml_pub_jobs WHERE run_id=? ORDER BY isbn').bind(sourceId).all()).results});
 const runs=async()=>(await db.prepare('SELECT COUNT(*) n FROM ml_pub_runs').first()).n;
 // Loads a fresh feed; commit=false leaves it importing like an interrupted upload.
 async function freshFeed({rows=freshRows,ageHours=0,expected=rows.length,commit=true}={}){
  const id=crypto.randomUUID(),at=clock.value-ageHours*HOUR;
  await store.beginFeed(id,new Date(at).toISOString(),expected,at);await store.importRows(id,rows);if(commit)await store.commitFeed(id);return id;
 }
 return {store,service,env,sourceId,feedId,calls,clock,db,snapshot,runs,freshFeed};
}

test('without feed_id the stale source feed still blocks the clone',async t=>{
 const f=await fixture(t);
 await assert.rejects(()=>f.service.command(f.env,'clone_preflight_catalog',{source_run_id:f.sourceId,limit:5}),/invalid_run_or_stale_feed/);
 assert.equal(await f.runs(),1);
});

test('the clone uses the fresh feed, validates at most five ISBNs and never posts an item',async t=>{
 const f=await fixture(t);const freshId=await f.freshFeed();
 const result=await f.service.command(f.env,'clone_preflight_catalog',{source_run_id:f.sourceId,feed_id:freshId});
 const run=await f.store.run(result.new_run_id);
 assert.equal(run.feed_id,freshId);assert.equal(result.feed_id,freshId);assert.equal(result.source_feed_id,f.feedId);
 assert.deepEqual(result.selected_isbns,selected);assert.equal(result.selected_isbns.length,5);
 assert.ok(!result.selected_isbns.includes(otherBook.isbn));
 assert.equal(result.validated,5);assert.equal(result.published,0);assert.equal(result.state,'ready');
 assert.equal(result.approved,false);assert.equal(run.approved_hash,null);assert.equal(run.preflight_limit,5);assert.equal(run.daily_cap,5);
 // Prices come from today's snapshot, not from the old feed.
 for(const job of result.preflight){const row=freshRows.find(r=>r.isbn===job.isbn);assert.equal(job.price,quoteMercadoLibre(row,policy).price);}
 assert.deepEqual(f.calls.rows.map(r=>r.listArs).sort(),freshRows.map(r=>r.listArs).sort());
 assert.equal(f.calls.create,0,'POST /items must never run');
 // The ML index is copied from the source run as before.
 const index=(await f.db.prepare('SELECT item_id,isbn FROM ml_pub_index WHERE run_id=?').bind(result.new_run_id).all()).results;
 assert.deepEqual(index,[{item_id:'MLU900000777',isbn:isbn(777)}]);
 // The feed is part of the deterministic id: it never collides with a clone over the source feed.
 assert.equal(result.new_run_id,await clonePreflightRunId(f.sourceId,result.policy_hash,5,freshId));
 assert.notEqual(result.new_run_id,await clonePreflightRunId(f.sourceId,result.policy_hash,5));
 // Repeating the request returns the same clone.
 const again=await f.service.command(f.env,'clone_preflight_catalog',{source_run_id:f.sourceId,feed_id:freshId});
 assert.equal(again.new_run_id,result.new_run_id);assert.equal(again.created,false);assert.equal(await f.runs(),2);assert.equal(f.calls.create,0);
});

test('the source run stays intact byte for byte, including its own feed',async t=>{
 const f=await fixture(t);const freshId=await f.freshFeed();
 const before=await f.snapshot();
 const result=await f.service.command(f.env,'clone_preflight_catalog',{source_run_id:f.sourceId,feed_id:freshId});
 const after=await f.snapshot();
 assert.deepEqual(after.run,before.run);assert.deepEqual(after.jobs,before.jobs);
 assert.equal(after.run.feed_id,f.feedId);assert.equal(result.source_run_intact,true);
 assert.equal((await f.store.feed(f.feedId)).state,'ready');
});

test('the cloned policy is identical except catalogListing',async t=>{
 const f=await fixture(t);const freshId=await f.freshFeed();
 const result=await f.service.command(f.env,'clone_preflight_catalog',{source_run_id:f.sourceId,feed_id:freshId});
 const source=validPolicy(JSON.parse((await f.store.run(f.sourceId)).policy_json)),clone=validPolicy(JSON.parse((await f.store.run(result.new_run_id)).policy_json));
 assert.deepEqual({...clone,catalogListing:source.catalogListing},source);
 assert.equal(source.catalogListing,false);assert.equal(clone.catalogListing,'required_only');
 assert.equal(result.policy_hash,await policyHash({...policy,catalogListing:'required_only'}));
});

test('a stale fresh feed is rejected and creates nothing',async t=>{
 const f=await fixture(t);const staleId=await f.freshFeed({ageHours:25});
 await assert.rejects(()=>f.service.command(f.env,'clone_preflight_catalog',{source_run_id:f.sourceId,feed_id:staleId}),/invalid_run_or_stale_feed/);
 assert.equal(await f.runs(),1);
});

test('a selected ISBN missing from the fresh feed or without stock is rejected',async t=>{
 const f=await fixture(t);
 const missingId=await f.freshFeed({rows:freshRows.slice(1)});
 await assert.rejects(()=>f.service.command(f.env,'clone_preflight_catalog',{source_run_id:f.sourceId,feed_id:missingId}),/fresh_feed_missing_stock/);
 const noStockId=await f.freshFeed({rows:freshRows.map((r,i)=>i===2?{...r,stock:'0'}:r)});
 await assert.rejects(()=>f.service.command(f.env,'clone_preflight_catalog',{source_run_id:f.sourceId,feed_id:noStockId}),/fresh_feed_missing_stock/);
 assert.equal(await f.runs(),1);assert.equal(f.calls.prepare,0);assert.equal(f.calls.create,0);
});

test('a complete fresh feed still importing is committed and used',async t=>{
 const f=await fixture(t);const freshId=await f.freshFeed({commit:false});
 assert.equal((await f.store.feed(freshId)).state,'importing');
 const result=await f.service.command(f.env,'clone_preflight_catalog',{source_run_id:f.sourceId,feed_id:freshId});
 assert.equal((await f.store.feed(freshId)).state,'ready');
 assert.equal((await f.store.run(result.new_run_id)).feed_id,freshId);assert.equal(result.validated,5);assert.equal(f.calls.create,0);
});

test('an incomplete fresh feed is rejected and stays importing',async t=>{
 const f=await fixture(t);const freshId=await f.freshFeed({expected:freshRows.length+1,commit:false});
 await assert.rejects(()=>f.service.command(f.env,'clone_preflight_catalog',{source_run_id:f.sourceId,feed_id:freshId}),/feed_count_mismatch/);
 assert.equal((await f.store.feed(freshId)).state,'importing');assert.equal(await f.runs(),1);
});

test('feed_id inputs are validated and the clone is capped at five ISBNs',async t=>{
 const f=await fixture(t);const freshId=await f.freshFeed();
 await assert.rejects(()=>f.service.command(f.env,'clone_preflight_catalog',{source_run_id:f.sourceId,feed_id:'not-a-feed'}),/invalid_feed_id/);
 await assert.rejects(()=>f.service.command(f.env,'clone_preflight_catalog',{source_run_id:f.sourceId,feed_id:freshId,limit:6}),/invalid_run_limits/);
 await assert.rejects(()=>f.service.command(f.env,'clone_preflight_catalog',{source_run_id:f.sourceId,feed_id:crypto.randomUUID()}),/invalid_run_or_stale_feed/);
 assert.equal(await f.runs(),1);
});
