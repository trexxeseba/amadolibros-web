import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sqliteD1} from './helpers/sqlite-d1.js';
import {PublicationStore} from '../publication-store.js';
import {createPublicationService,createRunFromSourceId,ADMIN_ONLY_ACTIONS} from '../publication-engine.js';
import {policyHash,validPolicy} from '../publication-policy.js';

const sourcePolicy={supplierDiscount:.25,arsPerUyu:40,usdPerUyu:42,freightUsdKg:15,laborUyu:0,margin:.23,mlFee:.17,deliveryUyu:270,minimumContributionUyu:200,minimumSaleUyu:1200,roundUyu:10,availabilityDays:17,additionalPricePct:0,listingTypeId:'gold_special'};
const books=[
 {isbn:'9789502323060',title:'Libro uno',author:'A',publisher:'E',listArs:15900,weightKg:.143,stock:'+2'},
 {isbn:'9780060740757',title:'Libro dos',author:'B',publisher:'E',listArs:57014.685,weightKg:.647,stock:'1'},
 {isbn:'9789501295825',title:'Libro tres',author:'C',publisher:'E',listArs:2300,weightKg:.246,stock:'2'},
];

async function fixture(t,{expected=books.length,rows=books,ageHours=0}={}){
 const dir=await mkdtemp(join(tmpdir(),'amado-production-run-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const db=sqliteD1(join(dir,'queue.sqlite')),store=new PublicationStore(db),now=Date.now(),sourceFeed=crypto.randomUUID(),sourceRun=crypto.randomUUID(),freshFeed=crypto.randomUUID();
 const env={ORDERS_DB:db,USER_ID:'440298103',APP_ID:'4741021817925208',ML_PUBLISHER_MODE:'enabled'};
 await store.initialize();
 await store.beginFeed(sourceFeed,new Date(now-3600000).toISOString(),books.length,now-3600000);await store.importRows(sourceFeed,books);await store.commitFeed(sourceFeed);
 await store.createRun({id:sourceRun,feedId:sourceFeed,policy:sourcePolicy,policyHash:await policyHash(sourcePolicy),now:now-3600000,dailyCap:1000,preflightLimit:10});
 await db.prepare("UPDATE ml_pub_runs SET state='ready' WHERE id=?").bind(sourceRun).run();
 const sourceSnapshot=async()=>({run:await store.run(sourceRun),jobs:(await db.prepare('SELECT * FROM ml_pub_jobs WHERE run_id=? ORDER BY isbn').bind(sourceRun).all()).results});
 const at=now-ageHours*3600000;await store.beginFeed(freshFeed,new Date(at).toISOString(),expected,at);if(rows.length)await store.importRows(freshFeed,rows);
 const service=createPublicationService({storeFactory:()=>store,now:()=>now});
 return {db,store,service,env,now,sourceFeed,sourceRun,freshFeed,sourceSnapshot};
}

test('creates an unapproved production-sized run from the exact source policy with only reviewed overrides',async t=>{
 const f=await fixture(t);const before=await f.sourceSnapshot();
 const r=await f.service.command(f.env,'create_run_from_source',{source_run_id:f.sourceRun,feed_id:f.freshFeed,availability_days:18,daily_cap:1000,preflight_limit:20});
 assert.equal((await f.store.feed(f.freshFeed)).state,'ready');
 const run=await f.store.run(r.new_run_id),source=validPolicy(sourcePolicy),clone=validPolicy(JSON.parse(run.policy_json));
 assert.equal(clone.catalogListing,'required_only');assert.equal(clone.availabilityDays,18);
 assert.deepEqual({...clone,catalogListing:false,availabilityDays:17},source);
 assert.equal(run.approved_hash,null);assert.equal(run.state,'preflight');assert.equal(run.daily_cap,1000);assert.equal(run.preflight_limit,20);
 assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM ml_pub_jobs WHERE run_id=?').bind(run.id).first()).n,books.length);
 assert.equal(r.source_run_intact,true);assert.deepEqual(await f.sourceSnapshot(),before);
 const expectedHash=await policyHash({...sourcePolicy,catalogListing:'required_only',availabilityDays:18});
 assert.equal(run.policy_hash,expectedHash);assert.equal(r.new_run_id,await createRunFromSourceId(f.sourceRun,expectedHash,f.freshFeed,1000,20));
});

test('persists target_published as a separate run target and includes it in deterministic identity',async t=>{
 const f=await fixture(t);
 const args={source_run_id:f.sourceRun,feed_id:f.freshFeed,availability_days:18,daily_cap:1000,preflight_limit:20,target_published:2};
 const result=await f.service.command(f.env,'create_run_from_source',args);
 const target=await f.store.target(result.new_run_id);
 assert.equal(target.target_published,2);
 assert.equal(result.target_published,2);
 assert.equal(result.target_remaining,2);
 const hash=(await f.store.run(result.new_run_id)).policy_hash;
 assert.equal(result.new_run_id,await createRunFromSourceId(f.sourceRun,hash,f.freshFeed,1000,20,2));
 const noTarget=await createRunFromSourceId(f.sourceRun,hash,f.freshFeed,1000,20,null);
 assert.notEqual(result.new_run_id,noTarget);
 await assert.rejects(()=>f.service.command(f.env,'create_run_from_source',{...args,target_published:4}),/target_exceeds_feed/);
});

test('is idempotent and refuses incomplete or stale feeds',async t=>{
 const f=await fixture(t);
 const args={source_run_id:f.sourceRun,feed_id:f.freshFeed,availability_days:18,daily_cap:1000,preflight_limit:20};
 const a=await f.service.command(f.env,'create_run_from_source',args),b=await f.service.command(f.env,'create_run_from_source',args);
 assert.equal(a.new_run_id,b.new_run_id);assert.equal(a.created,true);assert.equal(b.created,false);
 const incomplete=await fixture(t,{expected:books.length+1});
 await assert.rejects(()=>incomplete.service.command(incomplete.env,'create_run_from_source',{source_run_id:incomplete.sourceRun,feed_id:incomplete.freshFeed,availability_days:18}),/feed_count_mismatch/);
 const stale=await fixture(t,{ageHours:25});
 await assert.rejects(()=>stale.service.command(stale.env,'create_run_from_source',{source_run_id:stale.sourceRun,feed_id:stale.freshFeed,availability_days:18}),/invalid_run_or_stale_feed/);
});

test('is admin-only and validates explicit limits and availability',async t=>{
 const f=await fixture(t);
 assert.ok(ADMIN_ONLY_ACTIONS.includes('create_run_from_source'));
 await assert.rejects(()=>f.service.command(f.env,'create_run_from_source',{source_run_id:f.sourceRun,feed_id:f.freshFeed,availability_days:18},{id:crypto.randomUUID(),expires:Date.now()+60000}),/admin_only_action/);
 await assert.rejects(()=>f.service.command(f.env,'create_run_from_source',{source_run_id:f.sourceRun,feed_id:f.freshFeed,availability_days:0}),/invalid_availability_days/);
 await assert.rejects(()=>f.service.command(f.env,'create_run_from_source',{source_run_id:f.sourceRun,feed_id:f.freshFeed,availability_days:18,daily_cap:0}),/invalid_run_limits/);
 await assert.rejects(()=>f.service.command(f.env,'create_run_from_source',{source_run_id:f.sourceRun,feed_id:f.freshFeed,availability_days:18,preflight_limit:21}),/invalid_run_limits/);
});
