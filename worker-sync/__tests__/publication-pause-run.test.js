import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sqliteD1} from './helpers/sqlite-d1.js';
import {PublicationStore} from '../publication-store.js';
import {createPublicationService} from '../publication-engine.js';
import {policyHash} from '../publication-policy.js';

const policy={supplierDiscount:.2,arsPerUyu:40,usdPerUyu:40,freightUsdKg:10,laborUyu:0,margin:.2,mlFee:.15,deliveryUyu:200,minimumContributionUyu:100,minimumSaleUyu:1000,roundUyu:10,availabilityDays:18,additionalPricePct:0,listingTypeId:'gold_special'};
const book={isbn:'9789502323060',title:'Libro de prueba',listArs:10000,weightKg:.2,stock:'+2'};

async function fixture(t,{sku='AMADO-AR-9789502323060'}={}){
 const dir=await mkdtemp(join(tmpdir(),'amado-pause-run-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const db=sqliteD1(join(dir,'queue.sqlite')),store=new PublicationStore(db),now=Date.now(),feedId=crypto.randomUUID(),runId=crypto.randomUUID();
 const env={ORDERS_DB:db,USER_ID:'440298103',APP_ID:'4741021817925208',ML_PUBLISHER_MODE:'enabled'};
 await store.initialize();await store.beginFeed(feedId,new Date(now).toISOString(),1,now);await store.importRows(feedId,[book]);await store.commitFeed(feedId);
 await store.createRun({id:runId,feedId,policy,policyHash:await policyHash(policy),now,dailyCap:10,preflightLimit:1});
 await store.job(runId,book.isbn,'published',{itemId:'MLU900000001'});
 let status='active';const puts=[];
 const api={
  async account(){return {id:440298103,site_id:'MLU'};},
  async call(_env,path,options={}){
   if(path==='/items/bulk?ids=MLU900000001')return [{status_code:200,body:{id:'MLU900000001',seller_id:440298103,status,seller_custom_field:sku}}];
   if(path==='/items/MLU900000001'&&options.method==='PUT'){puts.push(options.body);status='paused';return {id:'MLU900000001',status};}
   throw Error('unexpected '+path);
  }
 };
 const service=createPublicationService({api,storeFactory:()=>store,now:()=>now});
 return {service,env,runId,puts};
}

test('pauses only published items from the exact SBS SKU scope and is idempotent',async t=>{
 const f=await fixture(t);
 let result=await f.service.command(f.env,'pause_run_publications',{run_id:f.runId,offset:0,limit:50});
 assert.deepEqual(result,{run_id:f.runId,offset:0,scanned:1,paused:1,already_paused:0,next_offset:null});
 assert.deepEqual(f.puts,[{status:'paused'}]);
 result=await f.service.command(f.env,'pause_run_publications',{run_id:f.runId,offset:0,limit:50});
 assert.equal(result.paused,0);assert.equal(result.already_paused,1);assert.equal(f.puts.length,1);
});

test('scope mismatch aborts before any write',async t=>{
 const f=await fixture(t,{sku:'OTHER-9789502323060'});
 await assert.rejects(()=>f.service.command(f.env,'pause_run_publications',{run_id:f.runId}),/pause_scope_mismatch/);
 assert.equal(f.puts.length,0);
});

test('pause_run_publications is admin-only',async t=>{
 const f=await fixture(t);
 await assert.rejects(()=>f.service.command(f.env,'pause_run_publications',{run_id:f.runId},{id:crypto.randomUUID(),expires:Date.now()+60000}),/admin_only_action/);
});
