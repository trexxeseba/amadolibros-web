import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sqliteD1} from './helpers/sqlite-d1.js';
import {PublicationStore} from '../publication-store.js';
import {createPublicationService,clonePreflightRunId} from '../publication-engine.js';
import {policyHash,validPolicy,PublicationError} from '../publication-policy.js';

// Decisión comercial: el clone de Catálogo puede llevar availabilityDays propio
// (MANUFACTURING_TIME) dentro de la política y del policy_hash, sin tocar el
// lote fuente. Ninguna prueba admite POST /items.
const policy={supplierDiscount:.2,arsPerUyu:40,usdPerUyu:40,freightUsdKg:10,laborUyu:0,margin:.2,mlFee:.15,deliveryUyu:200,minimumContributionUyu:100,minimumSaleUyu:1000,roundUyu:10,availabilityDays:10,additionalPricePct:0,listingTypeId:'gold_special'};
const SOURCE_CODE='catalog_required_needs_review';
const isbn=n=>{const stem='97895023'+String(n).padStart(4,'0');const check=(10-[...stem].reduce((s,c,i)=>s+Number(c)*(i%2?3:1),0)%10)%10;return stem+check;};
const books=Array.from({length:5},(_,i)=>({isbn:isbn(i+1),title:`Libro catálogo ${i+1}`,listArs:10000+i*100,weightKg:.3,stock:'+2'}));

async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'amado-clone-availability-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const db=sqliteD1(join(dir,'queue.sqlite')),store=new PublicationStore(db),now=Date.now(),feedId=crypto.randomUUID(),sourceId=crypto.randomUUID();
 const env={ORDERS_DB:db,USER_ID:'440298103',APP_ID:'4741021817925208',ML_PUBLISHER_MODE:'enabled'};
 await store.initialize();await store.beginFeed(feedId,new Date(now).toISOString(),books.length,now);await store.importRows(feedId,books);await store.commitFeed(feedId);
 await store.createRun({id:sourceId,feedId,policy,policyHash:await policyHash(policy),now,dailyCap:10000,preflightLimit:10});
 await store.saveIndex(sourceId,{status:'paused',scroll:null,pending:[],done:true,seen:0,completedAt:new Date(now).toISOString()},[]);
 for(const book of books)await store.job(sourceId,book.isbn,'review',{errorCode:SOURCE_CODE});
 await db.prepare("UPDATE ml_pub_runs SET state='ready' WHERE id=?").bind(sourceId).run();
 const calls={create:0,saleTerms:[]};
 const api={
  async skuItems(){return [];},
  async prepare(env,row,p,price){
   if(p.catalogListing!=='required_only')throw new PublicationError(SOURCE_CODE,422);
   // Same sale_terms the real prepare derives from the policy.
   const sale_terms=p.availabilityDays?[{id:'MANUFACTURING_TIME',value_name:`${p.availabilityDays} días`}]:[];calls.saleTerms.push(sale_terms);
   return {title:row.title,price,currency_id:'UYU',condition:'new',catalog_listing:true,catalog_product_id:`MLU1${row.isbn.slice(-5)}`,sale_terms};
  },
  async create(){calls.create++;throw Error('POST /items must never run during the catalog preflight');},
 };
 const service=createPublicationService({api,storeFactory:()=>store,now:()=>now});
 const snapshot=async()=>({run:await store.run(sourceId),jobs:(await db.prepare('SELECT isbn,state,error_code,payload_json FROM ml_pub_jobs WHERE run_id=? ORDER BY isbn').bind(sourceId).all()).results});
 return {store,service,env,sourceId,calls,db,snapshot};
}

test('availability_days=18 queda en la política del clone, cambia el hash y el payload muestra 18 días',async t=>{
 const f=await fixture(t);const before=await f.snapshot();
 const result=await f.service.command(f.env,'clone_preflight_catalog',{source_run_id:f.sourceId,limit:5,availability_days:18});
 const source=validPolicy(JSON.parse((await f.store.run(f.sourceId)).policy_json)),clone=validPolicy(JSON.parse((await f.store.run(result.new_run_id)).policy_json));
 // Source policy intact: 10 días, sin Catálogo, mismo hash, mismos jobs.
 assert.equal(source.availabilityDays,10);assert.equal(source.catalogListing,false);
 assert.deepEqual(await f.snapshot(),before);assert.equal(result.source_run_intact,true);assert.equal(result.source_policy_hash,await policyHash(policy));
 // Clone: 18 días y required_only; todo lo demás igual.
 assert.equal(clone.availabilityDays,18);assert.equal(result.availability_days,18);assert.equal(clone.catalogListing,'required_only');
 assert.deepEqual({...clone,availabilityDays:10,catalogListing:false},source);
 // Hash distinto del source y del clone sin override; id determinístico derivado de ese hash.
 const expectedHash=await policyHash({...policy,catalogListing:'required_only',availabilityDays:18});
 assert.equal(result.policy_hash,expectedHash);assert.notEqual(result.policy_hash,result.source_policy_hash);
 assert.notEqual(result.policy_hash,await policyHash({...policy,catalogListing:'required_only'}));
 assert.equal(result.new_run_id,await clonePreflightRunId(f.sourceId,expectedHash,5));
 // Payload validado con 18 días, sin aprobar y sin POST /items.
 assert.equal(result.validated,5);assert.equal(result.published,0);assert.equal(result.approved,false);
 for(const terms of f.calls.saleTerms)assert.deepEqual(terms,[{id:'MANUFACTURING_TIME',value_name:'18 días'}]);
 const stored=JSON.parse((await f.db.prepare('SELECT payload_json FROM ml_pub_jobs WHERE run_id=? LIMIT 1').bind(result.new_run_id).first()).payload_json);
 assert.deepEqual(stored.sale_terms,[{id:'MANUFACTURING_TIME',value_name:'18 días'}]);
 assert.equal(f.calls.create,0,'POST /items must never run');
 // Aprobar sigue exigiendo el hash nuevo: el del source se rechaza.
 await assert.rejects(()=>f.service.command(f.env,'approve',{run_id:result.new_run_id,policy_hash:result.source_policy_hash}),/policy_hash_mismatch/);
});

test('sin availability_days el clone conserva los días del lote fuente y es otro lote que el de 18',async t=>{
 const f=await fixture(t);
 const plain=await f.service.command(f.env,'clone_preflight_catalog',{source_run_id:f.sourceId,limit:5});
 const custom=await f.service.command(f.env,'clone_preflight_catalog',{source_run_id:f.sourceId,limit:5,availability_days:18});
 assert.equal(plain.availability_days,10);assert.equal(custom.availability_days,18);
 assert.notEqual(plain.new_run_id,custom.new_run_id);assert.notEqual(plain.policy_hash,custom.policy_hash);
 assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM ml_pub_runs').first()).n,3);
 // Repetir con 18 devuelve el mismo clone sin duplicar.
 const again=await f.service.command(f.env,'clone_preflight_catalog',{source_run_id:f.sourceId,limit:5,availability_days:18});
 assert.equal(again.new_run_id,custom.new_run_id);assert.equal(again.created,false);assert.equal(f.calls.create,0);
});

test('availability_days se valida como entero entre 1 y 60',async t=>{
 const f=await fixture(t);
 for(const bad of [0,61,1.5,'18',-1])await assert.rejects(()=>f.service.command(f.env,'clone_preflight_catalog',{source_run_id:f.sourceId,availability_days:bad}),/invalid_availability_days/,String(bad));
 assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM ml_pub_runs').first()).n,1);
});
