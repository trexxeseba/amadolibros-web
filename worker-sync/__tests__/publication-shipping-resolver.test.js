import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sqliteD1} from './helpers/sqlite-d1.js';
import {PublicationStore} from '../publication-store.js';
import {createPublicationService} from '../publication-engine.js';
import {createPublicationMeli,shippingSettings,shippingVariants,validationCauses} from '../publication-meli.js';
import {policyHash,quoteMercadoLibre} from '../publication-policy.js';

// El bloque shipping lo decide /items/validate sobre el payload completo, con
// las variantes A, B y C respaldadas por las preferencias de la cuenta. Ninguna
// prueba admite POST /items ni aprobación automática.
const policy={supplierDiscount:.2,arsPerUyu:40,usdPerUyu:40,freightUsdKg:10,laborUyu:0,margin:.2,mlFee:.15,deliveryUyu:200,minimumContributionUyu:100,minimumSaleUyu:1000,roundUyu:10,availabilityDays:18,additionalPricePct:0,listingTypeId:'gold_special',catalogListing:'required_only'};
const isbn=n=>{const stem='97895023'+String(n).padStart(4,'0');const check=(10-[...stem].reduce((s,c,i)=>s+Number(c)*(i%2?3:1),0)%10)%10;return stem+check;};
const row={isbn:isbn(1),title:'Libro de prueba uno',listArs:10000,weightKg:.495,stock:'+2'};
const SHIP_CAUSES=[{code:'shipping.lost_me1_by_user',message:'El usuario perdió ME1',type:'error'},{code:'item.shipping.mandatory_free_shipping',message:'Envío gratis obligatorio',type:'error',references:['item.shipping']}];
const A={mode:'me2',local_pick_up:false,free_shipping:true,free_methods:[]};

// Mercado Libre de prueba: Catálogo obligatorio con category_id, preferencias
// configurables y /items/validate que acepta según el shipping recibido.
function meliFor({accept=()=>true,logistics=[{mode:'me2',types:[{type:'xd_drop_off',default:true,status:'active'},{type:'self_service',default:false,status:'active'}]}],modes=['custom','not_specified','me2'],rejectWith=SHIP_CAUSES}={}){
 const seen=[],validated=[],products=new Map();
 const fetcher=async(url,options={})=>{
  const p=new URL(url).pathname;seen.push({path:p,method:options.method??'GET'});
  if(p==='/users/me')return Response.json({id:440298103,site_id:'MLU',tags:['user_product_seller']});
  if(p==='/users/440298103/items/search')return Response.json({results:[]});
  if(p==='/users/440298103/shipping_preferences')return Response.json({local_pick_up:false,modes,logistics,mandatory_settings:{mode:'me2',price_limit:0},free_configurations:[{rule:{default:true,free_mode:'country'}}],addresses:[{street:'x'}]});
  if(p==='/products/search'){const id=new URL(url).searchParams.get('product_identifier');products.set('MLU1'+id.slice(-5),id);return Response.json({paging:{total:1},results:[{id:'MLU1'+id.slice(-5),attributes:[{id:'GTIN',value_name:id}],settings:{listing_strategy:'catalog_required'}}]});}
  const prod=/^\/products\/(MLU1\d{5})$/.exec(p);
  if(prod)return Response.json({id:prod[1],status:'active',domain_id:'MLU-BOOKS',category_id:'MLU1196',settings:{listing_strategy:'catalog_required'},attributes:[{id:'GTIN',value_name:products.get(prod[1])},{id:'BOOK_COVER',value_name:'Blanda'}],pictures:[{id:'123456-MLU999999'}]});
  if(p==='/categories/MLU1196/attributes')return Response.json([{id:'GTIN',tags:{}},{id:'SELLER_SKU',tags:{}},{id:'BOOK_COVER',tags:{}}]);
  if(p==='/categories/MLU1196')return Response.json({settings:{listing_allowed:true,max_title_length:60},children_categories:[]});
  if(p==='/sites/MLU/listing_prices')return Response.json({currency_id:'UYU',listing_type_id:'gold_special',sale_fee_amount:100,listing_fee_amount:0});
  if(p==='/items/validate'){const body=JSON.parse(options.body);validated.push(body);if(accept(body.shipping,body))return new Response(null,{status:204});return Response.json({message:'Validation error',error:'validation_error',status:400,cause:rejectWith},{status:400});}
  if(p==='/items')throw Error('POST /items must never run');
  throw Error('Unexpected endpoint '+p);
 };
 return {fetcher,seen,validated,api:createPublicationMeli({fetcher,tokenProvider:async()=>'token'})};
}
const noCreate=seen=>assert.ok(!seen.some(x=>x.path==='/items'&&x.method==='POST'),'ninguna prueba puede crear un ítem real');
const noTags=validated=>{for(const v of validated)assert.ok(!('tags' in v.shipping)&&!('methods' in v.shipping),'tags/methods nunca se envían');};

test('las variantes salen de las preferencias: logística ME2 por defecto real, sin tags ni free_methods inventados',()=>{
 const settings=shippingSettings({local_pick_up:false,modes:['custom','not_specified','me2'],logistics:[{mode:'me2',types:[{type:'self_service',default:false,status:'active'},{type:'cross_docking',default:true,status:'active'}]}],mandatory_settings:{mode:'me2',price_limit:0}});
 assert.deepEqual(settings,{me2Available:true,mandatoryFreeShipping:true,localPickUp:false,logisticType:'cross_docking'});
 const variants=shippingVariants(settings);
 assert.deepEqual(variants,[{variant:'A',shipping:A},{variant:'B',shipping:{...A,logistic_type:'cross_docking'}},{variant:'C',shipping:{...A,logistic_type:'cross_docking',local_pick_up:true}}]);
 for(const v of variants){assert.ok(!('tags' in v.shipping));assert.deepEqual(v.shipping.free_methods,[]);}
 // Sin logística ME2 no hay B; sin ME2 no hay variantes válidas.
 assert.deepEqual(shippingVariants(shippingSettings({modes:['me2'],logistics:[{mode:'me2',types:[]}]})).map(v=>v.variant),['A','C']);
 assert.equal(shippingSettings({modes:['custom'],logistics:[]}).me2Available,false);
});

test('las causas de /items/validate se guardan acotadas: código, mensaje y campo, nunca tokens',()=>{
 const out=validationCauses([{code:'item.shipping.mandatory_free_shipping',message:'Bearer APP_USR-secret '+'texto '.repeat(60)+'APP_USR-1234-abcd '+'A'.repeat(40),type:'error',references:['item.shipping']},{code:'weird code',message:7,department:'shipping'},{code:'shipping.lost_me1_by_user'},{code:'item.x',message:'el token private-test-token no va'}],['private-test-token']);
 assert.equal(out[0].code,'item.shipping.mandatory_free_shipping');assert.ok(out[0].message.startsWith('[token] texto'));assert.equal(out[0].message.length,200);assert.equal(out[0].department,'item.shipping');assert.equal(out[0].type,'error');
 assert.doesNotMatch(JSON.stringify(out),/APP_USR|private-test-token|AAAA/);assert.equal(out[3].message,'el token [token] no va');
 assert.deepEqual(out[1],{code:'other',type:null,message:null,department:'shipping'});
 assert.deepEqual(out[2],{code:'shipping.lost_me1_by_user',type:null,message:null,department:null});
 assert.equal(validationCauses(Array.from({length:30},(_,i)=>({code:'item.x'+i}))).length,10);
});

test('A valida → se usa A con una sola validación',async()=>{
 const {api,seen,validated}=meliFor();
 const payload=await api.prepare({},row,policy,1200);
 assert.deepEqual(payload.shipping,A);assert.equal(validated.length,1);
 assert.deepEqual(payload.sale_terms,[{id:'MANUFACTURING_TIME',value_name:'18 días'}]);assert.equal(payload.catalog_listing,true);
 assert.ok(payload.attributes.some(a=>a.id==='SELLER_PACKAGE_WEIGHT'&&a.value_name==='700 g'));
 noTags(validated);noCreate(seen);
});

test('A falla / B valida → se usa B con la logística de las preferencias',async()=>{
 const {api,seen,validated}=meliFor({accept:s=>s.logistic_type==='cross_docking'&&s.local_pick_up===false,logistics:[{mode:'me2',types:[{type:'cross_docking',default:true,status:'active'}]}]});
 const payload=await api.prepare({},row,policy,1200);
 assert.deepEqual(payload.shipping,{...A,logistic_type:'cross_docking'});assert.equal(validated.length,2);
 assert.deepEqual(validated.map(v=>v.shipping),[A,{...A,logistic_type:'cross_docking'}]);
 // El resto del payload es el mismo en cada intento.
 for(const v of validated){assert.equal(v.price,1200);assert.equal(v.catalog_product_id,payload.catalog_product_id);assert.deepEqual(v.sale_terms,payload.sale_terms);}
 noTags(validated);noCreate(seen);
});

test('A y B fallan / C valida → se usa C (retiro en persona como MLU644187249)',async()=>{
 const {api,seen,validated}=meliFor({accept:s=>s.local_pick_up===true&&s.logistic_type==='xd_drop_off'});
 const payload=await api.prepare({},row,policy,1200);
 assert.deepEqual(payload.shipping,{...A,logistic_type:'xd_drop_off',local_pick_up:true});assert.equal(validated.length,3);
 noTags(validated);noCreate(seen);
});

test('todas fallan → un solo error con códigos y mensajes de A, B y C',async()=>{
 const {api,seen,validated}=meliFor({accept:()=>false});
 await assert.rejects(()=>api.prepare({},row,policy,1200),error=>{
  assert.equal(error.code,'shipping_not_validated');assert.equal(error.status,422);assert.equal(error.stage,'item_validation');
  assert.deepEqual(error.shippingAttempts.map(a=>a.variant),['A','B','C']);
  for(const a of error.shippingAttempts){assert.equal(a.status,400);assert.deepEqual(a.causes.map(c=>c.code),['shipping.lost_me1_by_user','item.shipping.mandatory_free_shipping']);assert.equal(a.causes[0].message,'El usuario perdió ME1');assert.equal(a.causes[1].department,'item.shipping');}
  assert.deepEqual(error.validationCodes,['shipping.lost_me1_by_user','item.shipping.mandatory_free_shipping']);
  assert.equal(error.shippingSettings.logisticType,'xd_drop_off');
  return true;
 });
 assert.equal(validated.length,3);noTags(validated);noCreate(seen);
});

test('un rechazo que no menciona shipping no prueba más variantes y conserva ml_http_400',async()=>{
 const {api,seen,validated}=meliFor({accept:()=>false,rejectWith:[{code:'item.attribute.missing.seller.package.dimensions',message:'Faltan medidas'}]});
 await assert.rejects(()=>api.prepare({},row,policy,1200),error=>{assert.equal(error.code,'ml_http_400');assert.equal(error.shippingAttempts.length,1);assert.equal(error.validationCauses[0].message,'Faltan medidas');return true;});
 assert.equal(validated.length,1);noCreate(seen);
});

test('ME2 no disponible en la cuenta corta antes de validar',async()=>{
 const {api,validated}=meliFor({modes:['custom','not_specified'],logistics:[]});
 await assert.rejects(()=>api.prepare({},row,policy,1200),/me2_not_available/);
 assert.equal(validated.length,0);
});

// Cola real sobre D1: el clone de Catálogo y shipping_probe usan el mismo prepare().
async function queue(t,meli){
 const dir=await mkdtemp(join(tmpdir(),'amado-shipping-resolver-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const db=sqliteD1(join(dir,'queue.sqlite')),store=new PublicationStore(db),now=Date.now(),feedId=crypto.randomUUID(),sourceId=crypto.randomUUID();
 const env={ORDERS_DB:db,USER_ID:'440298103',APP_ID:'4741021817925208',ML_PUBLISHER_MODE:'enabled'};
 const books=[1,2,3].map(n=>({...row,isbn:isbn(n),title:`Libro ${n}`}));
 const sourcePolicy={...policy,catalogListing:false};
 await store.initialize();await store.beginFeed(feedId,new Date(now).toISOString(),books.length,now);await store.importRows(feedId,books);await store.commitFeed(feedId);
 await store.createRun({id:sourceId,feedId,policy:sourcePolicy,policyHash:await policyHash(sourcePolicy),now,dailyCap:10000,preflightLimit:10});
 // A Catálogo run (required_only, 18 días) like the clone the probe will be pointed at.
 const catalogId=crypto.randomUUID();await store.createRun({id:catalogId,feedId,policy,policyHash:await policyHash(policy),now,dailyCap:5,preflightLimit:5});
 await store.saveIndex(sourceId,{status:'paused',scroll:null,pending:[],done:true,seen:0,completedAt:new Date(now).toISOString()},[]);
 for(const b of books)await store.job(sourceId,b.isbn,'review',{errorCode:'catalog_required_needs_review'});
 await db.prepare("UPDATE ml_pub_runs SET state='ready' WHERE id=?").bind(sourceId).run();
 const service=createPublicationService({api:meli.api,storeFactory:()=>store,now:()=>now});
 const snapshot=async()=>({run:await store.run(sourceId),jobs:(await db.prepare('SELECT isbn,state,error_code,payload_json FROM ml_pub_jobs WHERE run_id=? ORDER BY isbn').bind(sourceId).all()).results});
 return {service,env,store,db,sourceId,catalogId,feedId,books,snapshot};
}

test('el clone de Catálogo guarda cada intento de shipping en el diagnóstico y deja el lote fuente intacto',async t=>{
 const meli=meliFor({accept:()=>false});const q=await queue(t,meli);const before=await q.snapshot();
 const result=await q.service.command(q.env,'clone_preflight_catalog',{source_run_id:q.sourceId,limit:3,availability_days:18});
 assert.equal(result.validated,0);assert.equal(result.review,3);assert.equal(result.published,0);assert.equal(result.approved,false);assert.equal(result.source_run_intact,true);
 for(const job of result.preflight){
  assert.equal(job.state,'review');assert.equal(job.error_code,'shipping_not_validated');
  assert.deepEqual(job.validation.shipping_attempts.map(a=>a.variant),['A','B','C']);
  assert.equal(job.validation.shipping_attempts[2].shipping.local_pick_up,true);
  assert.equal(job.validation.causes[0].message,'El usuario perdió ME1');
 }
 assert.deepEqual(await q.snapshot(),before);
 noTags(meli.validated);noCreate(meli.seen);
});

test('con C aceptada el clone valida los ISBN con ese shipping y 18 días, sin aprobar',async t=>{
 const meli=meliFor({accept:s=>s.local_pick_up===true});const q=await queue(t,meli);
 const result=await q.service.command(q.env,'clone_preflight_catalog',{source_run_id:q.sourceId,limit:3,availability_days:18});
 assert.equal(result.validated,3);assert.equal(result.approved,false);assert.equal(result.state,'ready');
 const stored=JSON.parse((await q.db.prepare('SELECT payload_json FROM ml_pub_jobs WHERE run_id=? ORDER BY isbn LIMIT 1').bind(result.new_run_id).first()).payload_json);
 assert.deepEqual(stored.shipping,{...A,logistic_type:'xd_drop_off',local_pick_up:true});
 assert.deepEqual(stored.sale_terms,[{id:'MANUFACTURING_TIME',value_name:'18 días'}]);
 noCreate(meli.seen);
});

test('shipping_probe corre el mismo prepare() sobre un ISBN del feed y no guarda nada',async t=>{
 const meli=meliFor({accept:s=>s.logistic_type==='xd_drop_off'&&s.local_pick_up===false});const q=await queue(t,meli);const before=await q.snapshot();
 const r=await q.service.command(q.env,'shipping_probe',{run_id:q.catalogId,isbn:q.books[0].isbn});
 assert.equal(r.validated,true,JSON.stringify(r));assert.equal(r.variant,'B');assert.deepEqual(r.shipping,{...A,logistic_type:'xd_drop_off'});
 assert.equal(r.attempts.length,1);assert.equal(r.attempts[0].variant,'A');assert.equal(r.price,quoteMercadoLibre(q.books[0],policy).price);
 assert.equal(r.feed_id,q.feedId);assert.equal(r.availability_days,18);assert.equal(r.read_only_mercado_libre,true);
 assert.deepEqual(await q.snapshot(),before);
 assert.equal((await q.db.prepare('SELECT COUNT(*) n FROM ml_pub_runs').first()).n,2);
 // Con la política del lote fuente (sin Catálogo) el probe devuelve el mismo bloqueo que la cola, sin intentos de shipping.
 const plain=await q.service.command(q.env,'shipping_probe',{run_id:q.sourceId,isbn:q.books[0].isbn});
 assert.equal(plain.validated,false);assert.equal(plain.error,'catalog_required_needs_review');assert.deepEqual(plain.attempts,[]);
 // Todas fallan: devuelve los tres intentos en vez de un error ciego.
 const failing=meliFor({accept:()=>false});const q2=await queue(t,failing);
 const r2=await q2.service.command(q2.env,'shipping_probe',{run_id:q2.catalogId,isbn:q2.books[1].isbn,feed_id:q2.feedId});
 assert.equal(r2.validated,false);assert.equal(r2.error,'shipping_not_validated');assert.deepEqual(r2.attempts.map(a=>a.variant),['A','B','C']);assert.equal(r2.causes.length,6);
 // Admin only y entradas validadas.
 await assert.rejects(()=>q2.service.command(q2.env,'shipping_probe',{run_id:q2.catalogId,isbn:q2.books[1].isbn},{id:crypto.randomUUID(),expires:Date.now()+60000}),/admin_only_action/);
 await assert.rejects(()=>q2.service.command(q2.env,'shipping_probe',{run_id:q2.catalogId,isbn:isbn(999)}),/isbn_not_in_feed/);
 await assert.rejects(()=>q2.service.command(q2.env,'shipping_probe',{run_id:crypto.randomUUID(),isbn:q2.books[1].isbn}),/run_not_found/);
 noCreate(meli.seen);noCreate(failing.seen);
});
