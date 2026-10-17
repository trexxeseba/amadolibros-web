import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sqliteD1} from './helpers/sqlite-d1.js';
import {PublicationStore} from '../publication-store.js';
import {createPublicationService} from '../publication-engine.js';
import {policyHash} from '../publication-policy.js';

const policy={supplierDiscount:.25,arsPerUyu:40,usdPerUyu:42,freightUsdKg:15,laborUyu:0,margin:.23,mlFee:.17,deliveryUyu:270,minimumContributionUyu:200,minimumSaleUyu:1200,roundUyu:10,availabilityDays:18,additionalPricePct:0,listingTypeId:'gold_special',catalogListing:'required_only'};
const books=[
 {isbn:'9789502323060',title:'Libro uno',listArs:15900,weightKg:.143,stock:'2'},
 {isbn:'9780060740757',title:'Libro dos',listArs:57014.685,weightKg:.647,stock:'2'},
 {isbn:'9789501295825',title:'Libro tres',listArs:2300,weightKg:.246,stock:'2'},
];

test('availability audit reads real sale_terms and reports missing/wrong without writes',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'amado-availability-audit-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const db=sqliteD1(join(dir,'queue.sqlite')),store=new PublicationStore(db),now=Date.now(),feedId=crypto.randomUUID(),runId=crypto.randomUUID();
 await store.initialize();await store.beginFeed(feedId,new Date(now).toISOString(),books.length,now);await store.importRows(feedId,books);await store.commitFeed(feedId);
 await store.createRun({id:runId,feedId,policy,policyHash:await policyHash(policy),now,dailyCap:1000,preflightLimit:20});
 const ids=['MLU700000001','MLU700000002','MLU700000003'];
 for(let i=0;i<books.length;i++)await store.job(runId,books[i].isbn,'published',{itemId:ids[i]});
 const calls=[];
 const api={call:async(_env,path)=>{
  calls.push(path);const q=new URL('https://x'+path).searchParams.get('ids').split(',');
  return q.map(id=>({status_code:200,body:{
   id,seller_id:440298103,
   sale_terms:id===ids[0]?[{id:'MANUFACTURING_TIME',value_name:'18 días'}]:
              id===ids[1]?[]:[{id:'MANUFACTURING_TIME',value_name:'12 días'}]
  }}));
 }};
 const service=createPublicationService({api,storeFactory:()=>store,now:()=>now});
 const before=await store.counts(runId);
 const result=await service.command({ORDERS_DB:db,USER_ID:'440298103',APP_ID:'4741021817925208',ML_PUBLISHER_MODE:'enabled'},'audit_availability_terms',{run_id:runId,limit:200});
 assert.equal(result.total_published,3);assert.equal(result.scanned,3);assert.equal(result.ok,1);assert.equal(result.missing,1);assert.equal(result.wrong,1);assert.equal(result.next_offset,null);assert.equal(result.read_only_mercado_libre,true);
 assert.deepEqual(result.mismatches.map(x=>[x.item_id,x.has_term,x.actual_days]),[[ids[1],false,null],[ids[2],true,12]]);
 assert.deepEqual(await store.counts(runId),before);
 assert.equal(calls.length,1);
});

test('availability audit pages published jobs and uses policy days by default',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'amado-availability-audit-page-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const db=sqliteD1(join(dir,'queue.sqlite')),store=new PublicationStore(db),now=Date.now(),feedId=crypto.randomUUID(),runId=crypto.randomUUID();
 await store.initialize();await store.beginFeed(feedId,new Date(now).toISOString(),books.length,now);await store.importRows(feedId,books);await store.commitFeed(feedId);
 await store.createRun({id:runId,feedId,policy,policyHash:await policyHash(policy),now,dailyCap:1000,preflightLimit:20});
 for(let i=0;i<books.length;i++)await store.job(runId,books[i].isbn,'published',{itemId:`MLU70000000${i+1}`});
 const api={call:async(_env,path)=>new URL('https://x'+path).searchParams.get('ids').split(',').map(id=>({status_code:200,body:{id,seller_id:440298103,sale_terms:[{id:'MANUFACTURING_TIME',value_name:'18 días'}]}}))};
 const service=createPublicationService({api,storeFactory:()=>store,now:()=>now});
 const env={ORDERS_DB:db,USER_ID:'440298103',APP_ID:'4741021817925208',ML_PUBLISHER_MODE:'enabled'};
 const first=await service.command(env,'audit_availability_terms',{run_id:runId,limit:2});
 assert.equal(first.expected_days,18);assert.equal(first.scanned,2);assert.equal(first.next_offset,2);
 const second=await service.command(env,'audit_availability_terms',{run_id:runId,offset:first.next_offset,limit:2});
 assert.equal(second.scanned,1);assert.equal(second.next_offset,null);assert.equal(first.ok+second.ok,3);
});
