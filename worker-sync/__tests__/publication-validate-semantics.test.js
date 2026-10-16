import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sqliteD1} from './helpers/sqlite-d1.js';
import {PublicationStore} from '../publication-store.js';
import {createPublicationService} from '../publication-engine.js';
import {createPublicationMeli} from '../publication-meli.js';
import {policyHash} from '../publication-policy.js';

// Una sola semántica de /items/validate para prepare(), create() y shipping_probe:
// un 400 validation_error sólo cuenta como validado cuando todas sus causas son
// warnings. El probe y el preflight nunca hacen POST /items; create() hace uno
// solo y únicamente después de una validación aceptada.
const policy={supplierDiscount:.2,arsPerUyu:40,usdPerUyu:40,freightUsdKg:10,laborUyu:0,margin:.2,mlFee:.15,deliveryUyu:200,minimumContributionUyu:100,minimumSaleUyu:1000,roundUyu:10,availabilityDays:18,additionalPricePct:0,listingTypeId:'gold_special',catalogListing:'required_only'};
const isbn=n=>{const stem='97895023'+String(n).padStart(4,'0');const check=(10-[...stem].reduce((s,c,i)=>s+Number(c)*(i%2?3:1),0)%10)%10;return stem+check;};
const row={isbn:isbn(1),title:'Libro de prueba uno',listArs:10000,weightKg:.495,stock:'+2'};
const A={mode:'me2',local_pick_up:false,free_shipping:true,free_methods:[]};
// Exactamente lo que devolvió Mercado Libre en el probe real sobre 9780008623210.
const WARNINGS=[{code:'shipping.lost_me1_by_user',message:'User has not mode me1',type:'warning',department:'shipping'},{code:'item.shipping.mandatory_free_shipping',message:'Mandatory free shipping added',type:'warning',department:'items'}];
const ERROR={code:'item.catalog_listing.invalid',message:'Invalid catalog listing',type:'error'};
const reject=(cause,extra={})=>Response.json({message:'Validation error',error:'validation_error',status:400,cause,...extra},{status:400});

function meliFor({validate=()=>new Response(null,{status:204})}={}){
 const seen=[],validated=[],created=[],products=new Map();
 const fetcher=async(url,options={})=>{
  const p=new URL(url).pathname;seen.push({path:p,method:options.method??'GET'});
  if(p==='/users/me')return Response.json({id:440298103,site_id:'MLU',tags:['user_product_seller']});
  if(p==='/users/440298103/items/search')return Response.json({results:[]});
  if(p==='/users/440298103/shipping_preferences')return Response.json({local_pick_up:false,modes:['custom','not_specified','me2'],logistics:[{mode:'me2',types:[{type:'xd_drop_off',default:true,status:'active'}]}],mandatory_settings:{mode:'me2',price_limit:0}});
  if(p==='/products/search'){const id=new URL(url).searchParams.get('product_identifier');products.set('MLU1'+id.slice(-5),id);return Response.json({paging:{total:1},results:[{id:'MLU1'+id.slice(-5),attributes:[{id:'GTIN',value_name:id}],settings:{listing_strategy:'catalog_required'}}]});}
  const prod=/^\/products\/(MLU1\d{5})$/.exec(p);
  if(prod)return Response.json({id:prod[1],status:'active',domain_id:'MLU-BOOKS',category_id:'MLU1196',settings:{listing_strategy:'catalog_required'},attributes:[{id:'GTIN',value_name:products.get(prod[1])},{id:'BOOK_COVER',value_name:'Blanda'}],pictures:[{id:'123456-MLU999999'}]});
  if(p==='/categories/MLU1196/attributes')return Response.json([{id:'GTIN',tags:{}},{id:'SELLER_SKU',tags:{}},{id:'BOOK_COVER',tags:{}}]);
  if(p==='/categories/MLU1196')return Response.json({settings:{listing_allowed:true,max_title_length:60},children_categories:[]});
  if(p==='/sites/MLU/listing_prices')return Response.json({currency_id:'UYU',listing_type_id:'gold_special',sale_fee_amount:100,listing_fee_amount:0});
  if(p==='/items/validate'){const body=JSON.parse(options.body);validated.push(body);return validate(body,validated.length);}
  if(p==='/items'&&options.method==='POST'){created.push(JSON.parse(options.body));return Response.json({id:'MLU777000001',seller_id:440298103});}
  throw Error('Unexpected endpoint '+p);
 };
 return {fetcher,seen,validated,created,api:createPublicationMeli({fetcher,tokenProvider:async()=>'token'})};
}
const posts=seen=>seen.filter(x=>x.path==='/items'&&x.method==='POST').length;

test('400 con sólo warnings → validado; la variante aceptada es A y los warnings quedan en diagnostic',async()=>{
 const m=meliFor({validate:()=>reject(WARNINGS)});
 const payload=await m.api.prepare({},row,policy,1200);
 assert.deepEqual(payload.shipping,A);assert.equal(m.validated.length,1);
 assert.deepEqual(payload.diagnostic,{stage:'item_validation',warnings:WARNINGS.map(w=>({code:w.code,type:'warning',message:w.message,department:w.department}))});
 assert.equal(posts(m.seen),0);
});

test('400 con warning + error → rechazado; 400 sin cause → rechazado; invalid_fields / body.* → rechazado',async()=>{
 const mixed=meliFor({validate:()=>reject([...WARNINGS,ERROR])});
 await assert.rejects(()=>mixed.api.prepare({},row,policy,1200),error=>{assert.equal(error.code,'shipping_not_validated');assert.equal(error.shippingAttempts.length,3);for(const a of error.shippingAttempts)assert.ok(a.causes.some(c=>c.type==='error'));return true;});
 const empty=meliFor({validate:()=>reject([])});
 await assert.rejects(()=>empty.api.prepare({},row,policy,1200),error=>{assert.equal(error.code,'ml_http_400');assert.equal(error.shippingAttempts.length,1);assert.deepEqual(error.shippingAttempts[0].causes,[]);return true;});
 await assert.rejects(()=>empty.api.validateItem({},{title:'x'}),error=>{assert.equal(error.code,'ml_http_400');assert.equal(error.causeCount,0);assert.equal(error.onlyWarnings,false);return true;});
 const noCause=meliFor({validate:()=>Response.json({message:'Bad request',error:'bad_request',status:400},{status:400})});
 await assert.rejects(()=>noCause.api.prepare({},row,policy,1200),/ml_http_400/);
 const invalidFields=meliFor({validate:()=>reject(WARNINGS,{invalid_fields:['shipping']})});
 await assert.rejects(()=>invalidFields.api.validateItem({},{title:'x'}),error=>{assert.equal(error.structural,true);assert.equal(error.onlyWarnings,true);return true;});
 await assert.rejects(()=>invalidFields.api.prepare({},row,policy,1200),/shipping_not_validated/);
 const bodyCause=meliFor({validate:()=>reject([{code:'body.invalid_fields',message:'x',type:'warning'},...WARNINGS])});
 await assert.rejects(()=>bodyCause.api.validateItem({},{title:'x'}),error=>{assert.equal(error.structural,true);return true;});
 await assert.rejects(()=>bodyCause.api.prepare({},row,policy,1200),/shipping_not_validated/);
 const otherError=meliFor({validate:()=>Response.json({error:'forbidden_scope',status:400,cause:WARNINGS},{status:400})});
 await assert.rejects(()=>otherError.api.validateItem({},{title:'x'}),error=>{assert.equal(error.code,'ml_http_400');assert.equal(error.upstreamError,'forbidden_scope');return true;});
 await assert.rejects(()=>otherError.api.prepare({},row,policy,1200),/shipping_not_validated/);
 for(const m of [mixed,empty,noCause,invalidFields,bodyCause,otherError])assert.equal(posts(m.seen),0);
});

test('401/403/429/5xx conservan su comportamiento: mismo código y estado, nunca aceptados',async()=>{
 for(const status of [401,403,429,500,503]){
  const m=meliFor({validate:()=>Response.json({error:'x',cause:WARNINGS},{status,headers:status===429?{'retry-after':'7'}:{}})});
  await assert.rejects(()=>m.api.validateItem({},{title:'x'}),error=>{assert.equal(error.code,`ml_http_${status}`);assert.equal(error.status,status);if(status===429)assert.equal(error.retryAfter,7);return true;});
  assert.equal(posts(m.seen),0);
 }
});

test('create() comparte la semántica: warnings-only revalida y hace un único POST /items sin diagnostic; un error no publica',async()=>{
 const m=meliFor({validate:()=>reject(WARNINGS)});
 const payload=await m.api.prepare({},row,policy,1200);
 const result=await m.api.create({},payload,policy);
 assert.equal(result.id,'MLU777000001');assert.equal(posts(m.seen),1);assert.equal(m.validated.length,2);
 assert.equal(m.created[0].diagnostic,undefined);assert.deepEqual(m.created[0].shipping,A);assert.equal(m.validated[1].diagnostic,undefined);
 // La misma revalidación con una causa error frena antes del POST.
 const failing=meliFor({validate:(body,n)=>n===1?reject(WARNINGS):reject([ERROR])});
 const prepared=await failing.api.prepare({},row,policy,1200);
 await assert.rejects(()=>failing.api.create({},prepared,policy),/ml_http_400/);
 assert.equal(posts(failing.seen),0);
});

async function queue(t,meli){
 const dir=await mkdtemp(join(tmpdir(),'amado-validate-semantics-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const db=sqliteD1(join(dir,'queue.sqlite')),store=new PublicationStore(db),now=Date.now(),feedId=crypto.randomUUID(),sourceId=crypto.randomUUID(),catalogId=crypto.randomUUID();
 const env={ORDERS_DB:db,USER_ID:'440298103',APP_ID:'4741021817925208',ML_PUBLISHER_MODE:'enabled'};
 const books=[1,2,3].map(n=>({...row,isbn:isbn(n),title:`Libro ${n}`})),sourcePolicy={...policy,catalogListing:false};
 await store.initialize();await store.beginFeed(feedId,new Date(now).toISOString(),books.length,now);await store.importRows(feedId,books);await store.commitFeed(feedId);
 await store.createRun({id:sourceId,feedId,policy:sourcePolicy,policyHash:await policyHash(sourcePolicy),now,dailyCap:10000,preflightLimit:10});
 await store.createRun({id:catalogId,feedId,policy,policyHash:await policyHash(policy),now,dailyCap:5,preflightLimit:5});
 await store.saveIndex(sourceId,{status:'paused',scroll:null,pending:[],done:true,seen:0,completedAt:new Date(now).toISOString()},[]);
 for(const b of books)await store.job(sourceId,b.isbn,'review',{errorCode:'catalog_required_needs_review'});
 await db.prepare("UPDATE ml_pub_runs SET state='ready' WHERE id=?").bind(sourceId).run();
 const service=createPublicationService({api:meli.api,storeFactory:()=>store,now:()=>now});
 return {service,env,db,sourceId,catalogId,feedId,books};
}

test('shipping_probe y el preflight aceptan warnings-only con validated:true, guardan los warnings y nunca hacen POST /items',async t=>{
 const m=meliFor({validate:()=>reject(WARNINGS)});const q=await queue(t,m);
 const probe=await q.service.command(q.env,'shipping_probe',{run_id:q.catalogId,isbn:q.books[0].isbn});
 assert.equal(probe.validated,true);assert.equal(probe.variant,'A');assert.deepEqual(probe.shipping,A);assert.deepEqual(probe.attempts,[]);
 assert.deepEqual(probe.warnings.map(w=>w.code),WARNINGS.map(w=>w.code));assert.equal(probe.availability_days,18);
 const result=await q.service.command(q.env,'clone_preflight_catalog',{source_run_id:q.sourceId,limit:3,availability_days:18});
 assert.equal(result.validated,3);assert.equal(result.review,0);assert.equal(result.approved,false);assert.equal(result.published,0);assert.equal(result.source_run_intact,true);
 for(const job of result.preflight){assert.equal(job.state,'validated');assert.deepEqual(job.validation.warnings.map(w=>w.code),WARNINGS.map(w=>w.code));assert.equal(job.validation.stage,'item_validation');}
 const stored=JSON.parse((await q.db.prepare('SELECT payload_json FROM ml_pub_jobs WHERE run_id=? ORDER BY isbn LIMIT 1').bind(result.new_run_id).first()).payload_json);
 assert.deepEqual(stored.shipping,A);assert.deepEqual(stored.sale_terms,[{id:'MANUFACTURING_TIME',value_name:'18 días'}]);assert.equal(stored.diagnostic.warnings.length,2);
 assert.equal(posts(m.seen),0);
});
