import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sqliteD1} from './helpers/sqlite-d1.js';
import {PublicationStore} from '../publication-store.js';
import {createPublicationService} from '../publication-engine.js';
import {createPublicationMeli,shippingSafe} from '../publication-meli.js';
import {policyHash} from '../publication-policy.js';

// Diagnóstico de envíos: sólo GET, sólo con SYNC_SECRET, sin datos personales
// ni de ubicación en la respuesta y sin escribir en D1. Nunca POST /items.
const policy={supplierDiscount:.2,arsPerUyu:40,usdPerUyu:40,freightUsdKg:10,laborUyu:0,margin:.2,mlFee:.15,deliveryUyu:200,minimumContributionUyu:100,minimumSaleUyu:1000,roundUyu:10,availabilityDays:10,additionalPricePct:0,listingTypeId:'gold_special'};

function fetcherFor({preferencesStatus=200,itemSeller='440298103'}={}){
 const seen=[];
 const fetcher=async(url,options={})=>{
  const u=new URL(url),p=u.pathname;seen.push({path:p,method:options.method??'GET',query:Object.fromEntries(u.searchParams)});
  if(p==='/users/me')return Response.json({id:440298103,nickname:'AMADO',email:'x@y.z',site_id:'MLU',tags:['me2_available','mshops'],shipping_modes:['me2','custom'],status:{mercadoenvios:'accepted',sell:{allow:true},list:{allow:true}},address:{city:'Montevideo'}});
  if(p==='/users/440298103/shipping_preferences'){if(preferencesStatus!==200)return Response.json({message:'forbidden',cause:[]},{status:preferencesStatus});return Response.json({modes:['me2','custom'],logistics:[{mode:'me2',types:[{type:'xd_drop_off',default:true}]}],local_pick_up:true,mandatory_free_shipping:true,addresses:[{street:'x'}],phone:'1'});}
  if(p==='/categories/MLU1196/shipping_preferences')return Response.json({modes:['me2','custom'],free_shipping:{threshold:1000}});
  if(p==='/items/MLU644187249')return Response.json({id:'MLU644187249',seller_id:Number(itemSeller),price:2199,category_id:'MLU1196',listing_type_id:'gold_special',catalog_listing:true,status:'active',shipping:{mode:'me2',free_shipping:true,local_pick_up:true,logistic_type:'xd_drop_off',tags:['self_service_in','mandatory_free_shipping']},sale_terms:[{id:'MANUFACTURING_TIME',value_name:'10 días'}]});
  if(p==='/users/440298103/shipping_options/free')return Response.json({coverage:{all_country:{list_cost:290,currency_id:'UYU',billable_weight:700}}});
  throw Error('Unexpected endpoint '+p);
 };
 return {fetcher,seen,api:createPublicationMeli({fetcher,tokenProvider:async()=>'token'})};
}

async function fixture(t,options){
 const dir=await mkdtemp(join(tmpdir(),'amado-shipping-diag-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const db=sqliteD1(join(dir,'queue.sqlite')),store=new PublicationStore(db),now=Date.now(),feedId=crypto.randomUUID(),runId=crypto.randomUUID();
 const env={ORDERS_DB:db,USER_ID:'440298103',APP_ID:'4741021817925208',ML_PUBLISHER_MODE:'enabled'};
 await store.initialize();await store.beginFeed(feedId,new Date(now).toISOString(),1,now);await store.importRows(feedId,[{isbn:'9789502323060',title:'Libro',listArs:10000,weightKg:.2,stock:'+2'}]);await store.commitFeed(feedId);
 await store.createRun({id:runId,feedId,policy,policyHash:await policyHash(policy),now,dailyCap:10,preflightLimit:5});
 const {api,seen}=fetcherFor(options);
 const service=createPublicationService({api,storeFactory:()=>store,now:()=>now});
 const dump=async()=>JSON.stringify([(await db.prepare('SELECT * FROM ml_pub_runs ORDER BY id').all()).results,(await db.prepare('SELECT * FROM ml_pub_jobs ORDER BY isbn').all()).results,(await db.prepare('SELECT * FROM ml_pub_feeds ORDER BY id').all()).results]);
 return {service,env,seen,runId,dump};
}

test('shippingSafe quita datos personales y de ubicación y acota tamaño',()=>{
 const out=shippingSafe({mode:'me2',nickname:'A',email:'e',address:{street:'s'},city:'Montevideo',state_id:'UY-MO',latitude:1,name:'n',logistics:[{type:'xd_drop_off',phone:'1'}],long:'x'.repeat(500)});
 assert.deepEqual(out,{mode:'me2',logistics:[{type:'xd_drop_off'}],long:'x'.repeat(120)});
 assert.deepEqual(shippingSafe(Array.from({length:40},(_,i)=>i)).length,25);
});

test('el diagnóstico sólo hace GET, no escribe en D1 y reporta cuenta, preferencias, categoría, ítem y cotización',async t=>{
 const f=await fixture(t);const before=await f.dump();
 const r=await f.service.command(f.env,'shipping_diagnostic',{run_id:f.runId,item_id:'MLU644187249',item_price:2199});
 assert.ok(f.seen.length>=5);assert.ok(f.seen.every(x=>x.method==='GET'),'sólo GET');assert.ok(!f.seen.some(x=>x.path==='/items'||x.path==='/items/validate'));
 assert.equal(await f.dump(),before,'sin escrituras en D1');
 assert.equal(r.seller_id,'440298103');assert.equal(r.dimensions,'6x22x30,700');assert.equal(r.read_only_mercado_libre,true);
 assert.deepEqual(r.account.data.tags,['me2_available','mshops']);assert.deepEqual(r.account.data.shipping_modes,['me2','custom']);assert.equal(r.account.data.status.mercadoenvios,'accepted');
 assert.equal(r.account.data.nickname,undefined);assert.equal(r.account.data.email,undefined);assert.equal(r.account.data.address,undefined);
 assert.equal(r.shipping_preferences.ok,true);assert.equal(r.shipping_preferences.data.mandatory_free_shipping,true);assert.equal(r.shipping_preferences.data.addresses,undefined);assert.equal(r.shipping_preferences.data.phone,undefined);
 assert.deepEqual(r.category_shipping_preferences.data.modes,['me2','custom']);
 assert.equal(r.reference_item.data.shipping.logistic_type,'xd_drop_off');assert.deepEqual(r.reference_item.data.shipping.tags,['self_service_in','mandatory_free_shipping']);
 assert.equal(r.free_shipping_quote.data.coverage.all_country.list_cost,290);
 const quote=f.seen.find(x=>x.path==='/users/440298103/shipping_options/free').query;
 assert.equal(quote.dimensions,'6x22x30,700');assert.equal(quote.item_price,'2199');assert.equal(quote.mode,'me2');assert.equal(quote.category_id,'MLU1196');
 // Lo que manda hoy el payload, incluida la disponibilidad de stock de la política del lote.
 assert.deepEqual(r.current_payload,{shipping:{mode:'me2',local_pick_up:true,free_shipping:true},sale_terms:[{id:'MANUFACTURING_TIME',value_name:'10 días'}]});
 assert.ok(!JSON.stringify(r).includes('token'));
});

test('un endpoint rechazado se reporta sin ocultar el resto',async t=>{
 const f=await fixture(t,{preferencesStatus:403});
 const r=await f.service.command(f.env,'shipping_diagnostic',{});
 assert.deepEqual(r.shipping_preferences,{ok:false,error:'ml_http_403',status:403,validation_codes:[]});
 assert.equal(r.account.ok,true);assert.equal(r.category_shipping_preferences.ok,true);
 assert.equal(r.reference_item,undefined);assert.equal(r.free_shipping_quote,undefined);assert.equal(r.current_payload.sale_terms,null);
});

test('es admin only, valida sus entradas y rechaza ítems de otro vendedor',async t=>{
 const f=await fixture(t,{itemSeller:'1'});
 await assert.rejects(()=>f.service.command(f.env,'shipping_diagnostic',{},{id:crypto.randomUUID(),expires:Date.now()+60000}),/admin_only_action/);
 await assert.rejects(()=>f.service.command(f.env,'shipping_diagnostic',{item_id:'MLA1'}),/invalid_item_id/);
 await assert.rejects(()=>f.service.command(f.env,'shipping_diagnostic',{item_price:-1}),/invalid_diagnostic_args/);
 await assert.rejects(()=>f.service.command(f.env,'shipping_diagnostic',{weight_kg:31}),/invalid_diagnostic_args/);
 await assert.rejects(()=>f.service.command(f.env,'shipping_diagnostic',{run_id:'nope'}),/invalid_run_id/);
 await assert.rejects(()=>f.service.command(f.env,'shipping_diagnostic',{run_id:crypto.randomUUID()}),/run_not_found/);
 await assert.rejects(()=>f.service.command(f.env,'shipping_diagnostic',{item_id:'MLU644187249'}),/item_seller_mismatch/);
 assert.ok(f.seen.every(x=>x.method==='GET'));
});
