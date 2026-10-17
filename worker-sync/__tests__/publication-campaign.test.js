import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sqliteD1} from './helpers/sqlite-d1.js';
import {PublicationStore} from '../publication-store.js';
import {createPublicationService,classifyError} from '../publication-engine.js';
import {createPublicationMeli,MercadoLibreError} from '../publication-meli.js';
import {supplierBookMetadata} from '../publication-book-metadata.js';
import {MeliAuthError} from '../meli-auth.js';
import {policyHash,PublicationError} from '../publication-policy.js';

// Campaña: objetivo exacto de publicaciones reales sobre un pool, preparación en
// paralelo, creación serializada, descartes skipped_* y breaker. Ninguna prueba
// hace un POST /items que la campaña no haya decidido.
const policy={supplierDiscount:.2,arsPerUyu:40,usdPerUyu:40,freightUsdKg:10,laborUyu:0,margin:.2,mlFee:.15,deliveryUyu:200,minimumContributionUyu:100,minimumSaleUyu:1000,roundUyu:10,availabilityDays:18,additionalPricePct:0,listingTypeId:'gold_special',catalogListing:'required_only'};
const isbn=n=>{const stem='97895023'+String(n).padStart(4,'0');const check=(10-[...stem].reduce((s,c,i)=>s+Number(c)*(i%2?3:1),0)%10)%10;return stem+check;};
const book=(n,extra={})=>({isbn:isbn(n),title:`Libro campaña ${n}`,listArs:10000+n*10,weightKg:.3,stock:'+2',...extra});
const A={mode:'me2',local_pick_up:false,free_shipping:true,free_methods:[]};
const WARN=[{code:'shipping.lost_me1_by_user',message:'User has not mode me1',type:'warning'}];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

// Mercado Libre de prueba con comportamiento por ISBN y medición de concurrencia.
function meliFor({rules={},feeAmount=100}={}){
 const seen=[],created=[],products=new Map(),inflight={prepare:0,create:0},peak={prepare:0,create:0};
 const rule=id=>rules[id]??{};
 const fetcher=async(url,options={})=>{
  const u=new URL(url),p=u.pathname;seen.push({path:p,method:options.method??'GET'});
  if(p==='/users/me')return Response.json({id:440298103,site_id:'MLU',tags:['user_product_seller']});
  if(p==='/users/440298103/items/search')return Response.json({results:[]});
  if(p==='/users/440298103/shipping_preferences')return Response.json({local_pick_up:false,modes:['me2'],logistics:[{mode:'me2',types:[{type:'xd_drop_off',default:true,status:'active'}]}],mandatory_settings:{mode:'me2'}});
  if(p==='/products/search'){
   const id=u.searchParams.get('product_identifier'),r=rule(id);
   inflight.prepare++;peak.prepare=Math.max(peak.prepare,inflight.prepare);await sleep(8);inflight.prepare--;
   if(r.identity==='ambiguous')return Response.json({paging:{total:2},results:[{id:'MLU1'+id.slice(-5)},{id:'MLU2'+id.slice(-5)}]});
   if(r.identity==='missing')return Response.json({paging:{total:0},results:[]});
   products.set('MLU1'+id.slice(-5),id);return Response.json({paging:{total:1},results:[{id:'MLU1'+id.slice(-5),attributes:[{id:'GTIN',value_name:id}],settings:{listing_strategy:'catalog_required'}}]});
  }
  const prod=/^\/products\/(MLU1\d{5})$/.exec(p);
  if(prod){const id=products.get(prod[1]),r=rule(id);return Response.json({id:prod[1],status:'active',domain_id:'MLU-BOOKS',...(r.category==='none'?{}:{category_id:'MLU1196'}),settings:{listing_strategy:'catalog_required'},attributes:[{id:'GTIN',value_name:id},{id:'BOOK_COVER',value_name:'Blanda'}],pictures:r.pictures==='none'?[]:[{id:'123456-MLU999999'}]});}
  if(p==='/catalog_domains/MLU-BOOKS/categories')return Response.json([]);
  if(p==='/categories/MLU1196/attributes')return Response.json([{id:'GTIN',tags:{}},{id:'SELLER_SKU',tags:{}},{id:'BOOK_COVER',tags:{}}]);
  if(p==='/categories/MLU1196')return Response.json({settings:{listing_allowed:true,max_title_length:60},children_categories:[]});
  if(p==='/sites/MLU/listing_prices')return Response.json({currency_id:'UYU',listing_type_id:'gold_special',sale_fee_amount:feeAmount,listing_fee_amount:0});
  if(p==='/items/validate'){
   const body=JSON.parse(options.body),id=body.attributes.find(a=>a.id==='GTIN').value_name,r=rule(id);
   if(r.validate==='error')return Response.json({error:'validation_error',status:400,cause:[{code:'item.attribute.missing_required',message:'Falta un atributo',type:'error'}]},{status:400});
   if(r.validate==='warnings')return Response.json({error:'validation_error',status:400,cause:WARN},{status:400});
   if(r.validate==='500')return Response.json({error:'internal'},{status:500});
   return new Response(null,{status:204});
  }
  if(p==='/items'&&options.method==='POST'){
   const body=JSON.parse(options.body),id=body.attributes.find(a=>a.id==='GTIN').value_name,r=rule(id);
   inflight.create++;peak.create=Math.max(peak.create,inflight.create);await sleep(8);inflight.create--;
   if(r.create==='429')return Response.json({error:'too_many_requests'},{status:429,headers:{'retry-after':'90'}});
   created.push(body);return Response.json({id:'MLU77'+id.slice(-6),seller_id:440298103});
  }
  if(p==='/sites/MLU/domain_discovery/search')return Response.json([]);
  throw Error('Unexpected endpoint '+p);
 };
 return {fetcher,seen,created,peak,api:createPublicationMeli({fetcher,tokenProvider:async()=>'token'})};
}
const posts=seen=>seen.filter(x=>x.path==='/items'&&x.method==='POST').length;

async function campaign(t,meli,{books,target=null,env:envExtra={},publishing=true,receipts=[]}={}){
 const dir=await mkdtemp(join(tmpdir(),'amado-campaign-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const db=sqliteD1(join(dir,'queue.sqlite')),store=new PublicationStore(db),now=Date.now(),feedId=crypto.randomUUID(),runId=crypto.randomUUID(),hash=await policyHash(policy);
 const env={ORDERS_DB:db,USER_ID:'440298103',APP_ID:'4741021817925208',ML_PUBLISHER_MODE:'enabled',...envExtra};
 await store.initialize();await store.beginFeed(feedId,new Date(now).toISOString(),books.length,now);await store.importRows(feedId,books);await store.commitFeed(feedId);
 for(const r of receipts)await db.prepare("INSERT INTO ml_pub_receipts(seller_id,isbn,state,item_id,run_id,created_at,updated_at) VALUES('440298103',?,?,?,'old',?,?)").bind(r.isbn,r.state,r.item_id??null,now-86400000*2,now-86400000*2).run();
 await store.createRun({id:runId,feedId,policy,policyHash:hash,now,dailyCap:10000,preflightLimit:20});
 if(target!==null)await store.setTarget(runId,target);
 await store.saveIndex(runId,{status:'paused',scroll:null,pending:[],done:true,seen:0,completedAt:new Date(now).toISOString()},[]);
 if(publishing)await db.prepare("UPDATE ml_pub_runs SET state='publishing',approved_hash=policy_hash WHERE id=?").bind(runId).run();
 const clock={value:now},service=createPublicationService({api:meli.api,storeFactory:()=>store,now:()=>clock.value});
 const counts=async()=>Object.fromEntries((await store.counts(runId)).map(x=>[x.state,x.n]));
 const jobs=async()=>(await db.prepare('SELECT isbn,state,error_code,attempts FROM ml_pub_jobs WHERE run_id=? ORDER BY isbn').bind(runId).all()).results;
 return {service,env,store,db,runId,feedId,hash,clock,counts,jobs};
}

test('classifyError separa el problema del libro de lo técnico y lo sistémico',()=>{
 const ml=(status,extra={})=>Object.assign(new MercadoLibreError(`ml_http_${status}`,status),extra);
 assert.equal(classifyError(ml(401)),'auth');assert.equal(classifyError(ml(403)),'auth');assert.equal(classifyError(ml(429)),'backoff');
 assert.equal(classifyError(ml(503)),'retry');assert.equal(classifyError(new MercadoLibreError('ml_transport',503)),'retry');
 assert.equal(classifyError(ml(400,{stage:'item_validation'})),'skipped_ml_requirement');assert.equal(classifyError(ml(404,{stage:'metadata'})),'skipped_identity');assert.equal(classifyError(ml(400,{stage:'metadata'})),'retry');
 assert.equal(classifyError(new PublicationError('ambiguous_product_metadata',422)),'skipped_identity');assert.equal(classifyError(new PublicationError('missing_book_category',422)),'skipped_category');
 assert.equal(classifyError(new PublicationError('shipping_not_validated',422)),'skipped_ml_requirement');assert.equal(classifyError(new PublicationError('supplier_stock_conflict',422)),'skipped_stock_uncertain');
 for(const code of ['listing_fee_exceeds_or_missing_policy','payload_policy_mismatch','catalog_payload_not_approved','me2_not_available','seller_mismatch','never_seen_before'])assert.equal(classifyError(new PublicationError(code,422)),'systemic',code);
 assert.equal(classifyError(new Error('boom')),'systemic');
});

test('target_published es exacto: publica 3 de un pool de 8, el resto queda skipped_target_reached y el lote completa',async t=>{
 const meli=meliFor();const c=await campaign(t,meli,{books:[1,2,3,4,5,6,7,8].map(n=>book(n)),target:3});
 const result=await c.service.tick(c.env,c.runId);
 assert.equal(result.state,'complete');assert.equal(result.published,3);assert.equal(result.target_published,3);
 assert.deepEqual(await c.counts(),{published:3,skipped_target_reached:5});
 assert.equal(posts(meli.seen),3);assert.equal(meli.created.length,3);
 // Nunca se prepararon más candidatos que los que faltaban: 3 preparaciones + 3 revalidaciones.
 assert.equal(meli.seen.filter(x=>x.path==='/items/validate').length,6);
 for(const body of meli.created){assert.deepEqual(body.shipping,A);assert.deepEqual(body.sale_terms,[{id:'MANUFACTURING_TIME',value_name:'18 días'}]);assert.equal(body.catalog_listing,true);assert.equal(body.diagnostic,undefined);}
 // Repetir el tick no publica nada más.
 const again=await c.service.tick(c.env,c.runId);assert.equal(again.state,'complete');assert.equal(posts(meli.seen),3);
});

test('preparación en paralelo (3) y creación serializada (1), respetando los knobs del Worker',async t=>{
 const meli=meliFor();const c=await campaign(t,meli,{books:[1,2,3,4,5,6].map(n=>book(n)),target:6});
 const result=await c.service.tick(c.env,c.runId);
 assert.equal(result.state,'complete');assert.equal(result.published,6);
 assert.equal(meli.peak.prepare,3,'tres preparaciones simultáneas');assert.equal(meli.peak.create,1,'un solo POST /items a la vez');
 const meli2=meliFor();const c2=await campaign(t,meli2,{books:[1,2,3,4,5,6].map(n=>book(n)),target:6,env:{ML_PUBLISHER_PREPARE_CONCURRENCY:'2',ML_PUBLISHER_CREATE_CONCURRENCY:'2'}});
 await c2.service.tick(c2.env,c2.runId);
 assert.equal(meli2.peak.prepare,2);assert.equal(meli2.peak.create,2);assert.equal(posts(meli2.seen),6);
 const meli3=meliFor();const c3=await campaign(t,meli3,{books:[1,2,3].map(n=>book(n)),target:3,env:{ML_PUBLISHER_PREPARE_CONCURRENCY:'99',ML_PUBLISHER_CREATE_CONCURRENCY:'0'}});
 await c3.service.tick(c3.env,c3.runId);
 assert.equal(meli3.peak.prepare,3,'valores fuera de rango vuelven al default');assert.equal(meli3.peak.create,1);
});

test('un 429 en el POST deja ese libro uncertain, hace backoff y no dispara más creates en el tick',async t=>{
 const books=[1,2,3,4].map(n=>book(n));const meli=meliFor({rules:{[books[1].isbn]:{create:'429'}}});
 const c=await campaign(t,meli,{books,target:4});
 const result=await c.service.tick(c.env,c.runId);
 assert.equal(result.state,'backoff');assert.ok(Date.parse(result.resume_at)>=c.clock.value+90000);
 const jobs=await c.jobs();
 assert.equal(jobs[0].state,'published');assert.equal(jobs[1].state,'uncertain');assert.equal(jobs[1].error_code,'ml_http_429');
 assert.ok(['pending','validated'].includes(jobs[2].state));assert.equal(jobs[3].state,'pending');
 assert.equal(posts(meli.seen),2,'el tercer candidato preparado no llegó a POST');
 assert.equal((await c.store.receipt('440298103',books[1].isbn)).state,'uncertain');
 // Durante el backoff el tick no hace nada.
 const during=await c.service.tick(c.env,c.runId);assert.equal(during.state,'backoff');assert.equal(posts(meli.seen),2);
});

test('problemas propios del libro → skipped_* y siguiente; ninguno queda en review ni consume POST',async t=>{
 const books=[1,2,3,4,5,6].map(n=>book(n));
 books[4]=book(5,{stock:'0'});
 const meli=meliFor({rules:{[books[0].isbn]:{validate:'error'},[books[1].isbn]:{identity:'ambiguous'},[books[2].isbn]:{category:'none'},[books[3].isbn]:{identity:'missing'}}});
 const c=await campaign(t,meli,{books,target:1});
 const result=await c.service.tick(c.env,c.runId);
 const jobs=await c.jobs();
 assert.equal(jobs[0].state,'skipped_ml_requirement');assert.equal(jobs[0].error_code,'ml_http_400');
 assert.equal(jobs[1].state,'skipped_identity');assert.equal(jobs[1].error_code,'ambiguous_product_metadata');
 assert.equal(jobs[2].state,'skipped_category');assert.equal(jobs[2].error_code,'missing_book_category');
 assert.equal(jobs[3].state,'skipped_identity');assert.equal(jobs[3].error_code,'missing_verified_book_metadata');
 assert.equal(jobs[4].state,'skipped_stock_uncertain');
 assert.equal(jobs[5].state,'published');
 assert.equal(result.state,'complete');assert.equal(result.published,1);assert.equal(posts(meli.seen),1);
 assert.ok(!jobs.some(j=>j.state==='review'));
});

test('warnings-only de /items/validate publica y guarda los warnings sin mandarlos a Mercado Libre',async t=>{
 const books=[1,2].map(n=>book(n));const meli=meliFor({rules:{[books[0].isbn]:{validate:'warnings'},[books[1].isbn]:{validate:'warnings'}}});
 const c=await campaign(t,meli,{books,target:2});
 const result=await c.service.tick(c.env,c.runId);
 assert.equal(result.published,2);assert.equal(meli.created[0].diagnostic,undefined);
 const stored=JSON.parse((await c.db.prepare('SELECT payload_json FROM ml_pub_jobs WHERE run_id=? ORDER BY isbn LIMIT 1').bind(c.runId).first()).payload_json);
 assert.deepEqual(stored.diagnostic.warnings.map(w=>w.code),['shipping.lost_me1_by_user']);
});

test('un error sistémico repetido (fee fuera de política) pausa el lote sin gastar pool',async t=>{
 const books=[1,2,3,4,5,6].map(n=>book(n));const meli=meliFor({feeAmount:999999});
 const c=await campaign(t,meli,{books,target:6});
 const result=await c.service.tick(c.env,c.runId);
 assert.equal(result.state,'paused');assert.equal(result.breaker,'listing_fee_exceeds_or_missing_policy');
 assert.equal((await c.store.run(c.runId)).state,'paused');
 const counts=await c.counts();assert.equal(counts.retry,3);assert.equal(counts.pending,3);assert.equal(posts(meli.seen),0);
 // Reanudar exige approve del mismo hash; mientras tanto el tick no toca nada.
 assert.equal((await c.service.tick(c.env,c.runId)).state,'paused');
 await c.store.approve(c.runId,c.hash);assert.equal((await c.store.run(c.runId)).state,'publishing');
});

test('errores técnicos 5xx reintentan con backoff del libro, no descartan, y auth detiene el lote',async t=>{
 const books=[1,2,3].map(n=>book(n));const meli=meliFor({rules:{[books[0].isbn]:{validate:'500'}}});
 const c=await campaign(t,meli,{books,target:3});
 await c.service.tick(c.env,c.runId);
 const jobs=await c.jobs();
 assert.equal(jobs[0].state,'retry');assert.equal(jobs[0].error_code,'ml_http_500');assert.equal(jobs[0].attempts,1);
 assert.equal(jobs[1].state,'published');assert.equal(jobs[2].state,'published');
 const authMeli=meliFor();const authApi=createPublicationMeli({fetcher:authMeli.fetcher,tokenProvider:async()=>{throw new MeliAuthError('auth_revoked',{status:401,retryable:false});}});
 const c2=await campaign(t,{api:authApi,seen:authMeli.seen},{books:[book(1)],target:1});
 const r2=await c2.service.tick(c2.env,c2.runId);
 assert.equal(r2.state,'auth_error');assert.equal(posts(authMeli.seen),0);
});

test('veinte descartes seguidos por el mismo motivo pausan el lote: pool malo, no libros malos',async t=>{
 const books=Array.from({length:30},(_,i)=>book(i+1));const rules={};for(const b of books)rules[b.isbn]={validate:'error'};
 const meli=meliFor({rules});const c=await campaign(t,meli,{books,target:5});
 const result=await c.service.tick(c.env,c.runId);
 assert.equal(result.state,'paused');assert.equal(result.breaker,'ml_http_400');
 const counts=await c.counts();assert.ok(counts.skipped_ml_requirement>=20&&counts.skipped_ml_requirement<=22);assert.ok(counts.pending>=8);assert.equal(posts(meli.seen),0);
});

test('un libro ya publicado por el vendedor entra como skipped_duplicate y un receipt uncertain se reconcilia por SKU',async t=>{
 const books=[1,2,3].map(n=>book(n));
 const meli=meliFor();const c=await campaign(t,meli,{books,target:3,receipts:[{isbn:books[0].isbn,state:'published',item_id:'MLU1'},{isbn:books[1].isbn,state:'uncertain'}]});
 assert.equal((await c.jobs())[0].state,'skipped_duplicate');
 const result=await c.service.tick(c.env,c.runId);
 const jobs=await c.jobs();
 assert.equal(jobs[1].state,'uncertain');assert.equal(jobs[1].error_code,'existing_create_receipt');
 assert.equal(jobs[2].state,'published');assert.equal(posts(meli.seen),1);
 assert.equal(result.state,'complete_with_review');
});

test('el snapshot vencido corta el tick y attach_feed con los ISBN pendientes vuelve a publishing sin nueva aprobación',async t=>{
 const books=[1,2,3,4].map(n=>book(n));const meli=meliFor();const c=await campaign(t,meli,{books,target:4});
 c.clock.value+=25*3600000;
 assert.equal((await c.service.tick(c.env,c.runId)).state,'stock_stale');assert.equal(posts(meli.seen),0);
 const fresh=crypto.randomUUID(),at=c.clock.value;
 await c.store.beginFeed(fresh,new Date(at).toISOString(),books.length,at);await c.store.importRows(fresh,books);await c.store.commitFeed(fresh);
 await c.service.command(c.env,'attach_feed',{run_id:c.runId,feed_id:fresh});
 const run=await c.store.run(c.runId);assert.equal(run.state,'publishing');assert.equal(run.feed_id,fresh);assert.equal(run.approved_hash,run.policy_hash);
 const result=await c.service.tick(c.env,c.runId);
 assert.equal(result.state,'complete');assert.equal(result.published,4);
});

test('metadata opcional: se envía lo verificado, se omite lo que falta y nunca se inventa',async t=>{
 const row=book(1,{author:'',publisher:''});
 const product={ISBN:[row.isbn],Autor:[],items:[{isKit:false,ean:row.isbn,images:[],sellers:[{sellerId:'1',commertialOffer:{IsAvailable:true,AvailableQuantity:3}}]}]};
 const meta=await supplierBookMetadata(row,{fetcher:async()=>Response.json([product])});
 assert.deepEqual(meta.attributes.map(a=>a.id),['GTIN','BOOK_TITLE']);assert.deepEqual(meta.pictures,[]);
 const rich={...product,Idioma:['Inglés'],Tapa:['Rústica'],Autor:['AUTORA'],Editorial:['EDITORIAL'],items:[{...product.items[0],images:[{imageUrl:'https://sbslibreria.vteximg.com.br/arquivos/ids/123/x.jpg'}]}]};
 const full=await supplierBookMetadata(row,{fetcher:async()=>Response.json([rich])});
 assert.deepEqual(full.attributes.map(a=>a.id),['GTIN','BOOK_TITLE','AUTHOR','BOOK_PUBLISHER','LANGUAGE','BOOK_COVER']);assert.equal(full.pictures.length,1);
 // La identidad sigue siendo requisito nuestro.
 await assert.rejects(()=>supplierBookMetadata(row,{fetcher:async()=>Response.json([{...product,ISBN:['9789502300023']}])}),/missing_verified_book_metadata/);
 // Un producto de Catálogo sin fotos se valida igual: /items/validate decide.
 const books=[book(1)];const meli=meliFor({rules:{[books[0].isbn]:{pictures:'none'}}});
 const c=await campaign(t,meli,{books,target:1});
 const result=await c.service.tick(c.env,c.runId);
 assert.equal(result.published,1);assert.equal('pictures' in meli.created[0],false);
});

test('record_audit guarda una sola auditoría válida y status la muestra',async t=>{
 const meli=meliFor();const c=await campaign(t,meli,{books:[book(1)],target:1});
 await c.service.tick(c.env,c.runId);
 const ok={total_published:1,expected_days:18,ok:1,missing:0,wrong:0,mismatches:[]};
 const stored=await c.service.command(c.env,'record_audit',{run_id:c.runId,result:ok});
 assert.equal(stored.audit.ok,1);assert.equal(typeof stored.audit.audited_at,'number');
 const status=await c.service.command(c.env,'status',{run_id:c.runId});
 assert.equal(status.audit.ok,1);assert.equal(status.target_published,1);assert.equal(status.published,1);
 await assert.rejects(()=>c.service.command(c.env,'record_audit',{run_id:c.runId,result:{...ok,ok:0}}),/invalid_audit_result/);
 await assert.rejects(()=>c.service.command(c.env,'record_audit',{run_id:c.runId,result:ok},{id:crypto.randomUUID(),expires:Date.now()+60000}),/admin_only_action/);
});

test('create_run_from_source con target_published: id determinístico distinto, target guardado y sin aprobación',async t=>{
 const meli=meliFor();const c=await campaign(t,meli,{books:[1,2,3].map(n=>book(n)),publishing:false});
 const sourcePolicy={...policy,catalogListing:false};const sourceId=crypto.randomUUID();
 await c.store.createRun({id:sourceId,feedId:c.feedId,policy:sourcePolicy,policyHash:await policyHash(sourcePolicy),now:c.clock.value,dailyCap:10000,preflightLimit:10});
 const plain=await c.service.command(c.env,'create_run_from_source',{source_run_id:sourceId,feed_id:c.feedId,availability_days:18});
 const camp=await c.service.command(c.env,'create_run_from_source',{source_run_id:sourceId,feed_id:c.feedId,availability_days:18,target_published:2});
 assert.notEqual(plain.new_run_id,camp.new_run_id);assert.equal(camp.target_published,2);assert.equal(plain.target_published,null);assert.equal(camp.approved,false);assert.equal(camp.state,'preflight');
 const again=await c.service.command(c.env,'create_run_from_source',{source_run_id:sourceId,feed_id:c.feedId,availability_days:18,target_published:2});
 assert.equal(again.new_run_id,camp.new_run_id);assert.equal(again.created,false);
 await assert.rejects(()=>c.service.command(c.env,'create_run_from_source',{source_run_id:sourceId,feed_id:c.feedId,availability_days:18,target_published:0}),/invalid_target_published/);
 assert.equal(posts(meli.seen),0);
});
