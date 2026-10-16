import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicationMeli,domainCategoryIds} from '../publication-meli.js';
import {PublicationError} from '../publication-policy.js';

// Catálogo obligatorio necesita category_id. Cuando el producto de Catálogo no
// lo trae, el dominio ya verificado lo convierte. Estas pruebas fijan que la
// conversión nunca adivine: una sola candidata válida se usa, varias sólo se
// desempatan con una predicción del mismo dominio, y cualquier duda es review.
// Ninguna prueba admite un POST /items: el alta real no entra en este alcance.
const policy={supplierDiscount:.2,arsPerUyu:40,usdPerUyu:40,freightUsdKg:10,laborUyu:0,margin:.2,mlFee:.15,deliveryUyu:200,minimumContributionUyu:100,minimumSaleUyu:1000,roundUyu:10,availabilityDays:10,additionalPricePct:0,listingTypeId:'gold_special'};
const catalogPolicy={...policy,catalogListing:'required_only'};
const row={isbn:'9789502323060',title:'Libro de prueba uno',listArs:10000,weightKg:.2,stock:'+2'};
const LEAF={settings:{listing_allowed:true,max_title_length:60},children_categories:[]};

// Fetcher de Catálogo obligatorio cuyo producto NO trae category_id: es el
// escenario exacto del preflight que dejó los diez ISBN en missing_book_category.
function fetcherFor({domainCategories,categories={},prediction=[],detail={},domainId='MLU-BOOKS'}={}){
 const seen=[];
 const fetcher=async(url,options={})=>{
  const p=new URL(url).pathname;seen.push({path:p,method:options.method??'GET'});
  if(p==='/users/me')return Response.json({id:440298103,site_id:'MLU',tags:[]});
  if(p==='/users/440298103/shipping_preferences')return Response.json({modes:['me2'],logistics:[{mode:'me2',types:[{type:'xd_drop_off',default:true,status:'active'}]}]});
  if(p==='/products/search')return Response.json({paging:{total:1},results:[{id:'MLU123456',attributes:[{id:'GTIN',value_name:row.isbn}],settings:{listing_strategy:'catalog_required'}}]});
  if(p==='/products/MLU123456')return Response.json({id:'MLU123456',status:'active',domain_id:domainId,settings:{listing_strategy:'catalog_required'},attributes:[{id:'GTIN',value_name:row.isbn},{id:'BOOK_COVER',value_name:'Blanda'}],pictures:[{id:'123456-MLU999999'}],...detail});
  if(p===`/catalog_domains/${domainId}/categories`){if(domainCategories===undefined)throw Error('domain categories not stubbed');return Response.json(domainCategories);}
  if(p==='/sites/MLU/domain_discovery/search')return Response.json(prediction);
  const attrs=/^\/categories\/(MLU\d+)\/attributes$/.exec(p);
  if(attrs)return Response.json([{id:'GTIN',tags:{}},{id:'SELLER_SKU',tags:{}},{id:'BOOK_COVER',tags:{}}]);
  const cat=/^\/categories\/(MLU\d+)$/.exec(p);
  if(cat){const found=categories[cat[1]];if(!found)throw Error('Unexpected category '+cat[1]);return Response.json(found);}
  if(p==='/sites/MLU/listing_prices')return Response.json({currency_id:'UYU',listing_type_id:'gold_special',sale_fee_amount:100,listing_fee_amount:0});
  if(p==='/items/validate')return new Response(null,{status:204});
  throw Error('Unexpected endpoint '+p);
 };
 return {fetcher,seen,api:createPublicationMeli({fetcher,tokenProvider:async()=>'token'})};
}
const noCreate=seen=>assert.ok(!seen.some(x=>x.path==='/items'&&x.method==='POST'),'ninguna prueba puede crear un ítem real');

test('el listado de categorías del dominio se normaliza sin adivinar formas desconocidas',()=>{
 assert.deepEqual(domainCategoryIds([{category_id:'MLU1234'},{id:'MLU5678'},'MLU9012']),['MLU1234','MLU5678','MLU9012']);
 assert.deepEqual(domainCategoryIds({categories:[{category_id:'MLU1234'},{category_id:'MLU1234'}]}),['MLU1234']);
 for(const payload of [null,undefined,'MLU1234',{},{categories:'x'},[{category_id:'MLA1234'}],[{category_id:'1234'}],[{name:'Libros'}],[{category_id:42}]])assert.deepEqual(domainCategoryIds(payload),[],JSON.stringify(payload));
});

test('un producto con category_id conserva el comportamiento actual y no consulta el dominio',async()=>{
 const {api,seen}=fetcherFor({detail:{category_id:'MLU12345'},categories:{MLU12345:LEAF}});
 const payload=await api.prepare({},row,catalogPolicy,1200);
 assert.equal(payload.category_id,'MLU12345');assert.equal(payload.catalog_listing,true);assert.equal(payload.catalog_product_id,'MLU123456');
 assert.ok(!seen.some(x=>x.path.startsWith('/catalog_domains/')),'no debe consultar el dominio si ya hay category_id');
 assert.ok(!seen.some(x=>x.path==='/sites/MLU/domain_discovery/search'),'no debe predecir si ya hay category_id');
 assert.ok(seen.some(x=>x.path==='/items/validate'),'/items/validate sigue siendo la validación final');noCreate(seen);
});

test('sin category_id, un dominio con una sola categoría válida la usa sin predecir por título',async()=>{
 const {api,seen}=fetcherFor({domainCategories:[{domain_id:'MLU-BOOKS',category_id:'MLU3025'}],categories:{MLU3025:LEAF}});
 const payload=await api.prepare({},row,catalogPolicy,1200);
 assert.equal(payload.category_id,'MLU3025');assert.equal(payload.catalog_listing,true);
 assert.ok(seen.some(x=>x.path==='/catalog_domains/MLU-BOOKS/categories'));
 assert.ok(!seen.some(x=>x.path==='/sites/MLU/domain_discovery/search'),'una sola candidata no necesita desempate');
 assert.ok(seen.some(x=>x.path==='/items/validate'));noCreate(seen);
});

test('las candidatas no listables, no hoja o de otro sitio se descartan antes de elegir',async()=>{
 const {api,seen}=fetcherFor({
  domainCategories:[{category_id:'MLU1111'},{category_id:'MLU2222'},{category_id:'MLU3025'},{category_id:'MLA4444'}],
  categories:{MLU1111:{settings:{listing_allowed:false},children_categories:[]},MLU2222:{...LEAF,children_categories:[{id:'MLU9999'}]},MLU3025:LEAF},
 });
 const payload=await api.prepare({},row,catalogPolicy,1200);
 assert.equal(payload.category_id,'MLU3025','queda exactamente una candidata válida');
 assert.ok(!seen.some(x=>x.path==='/categories/MLA4444'),'una categoría de otro sitio no se consulta');
 assert.ok(!seen.some(x=>x.path==='/sites/MLU/domain_discovery/search'));noCreate(seen);
});

test('con varias candidatas válidas, una predicción del mismo dominio y dentro de las candidatas desempata',async()=>{
 const {api,seen}=fetcherFor({
  domainCategories:[{category_id:'MLU3025'},{category_id:'MLU3026'}],
  categories:{MLU3025:LEAF,MLU3026:LEAF},
  prediction:[{domain_id:'MLU-BOOKS',category_id:'MLU3026'}],
 });
 const payload=await api.prepare({},row,catalogPolicy,1200);
 assert.equal(payload.category_id,'MLU3026');
 assert.ok(seen.some(x=>x.path==='/sites/MLU/domain_discovery/search'),'el desempate sí consulta la predicción');
 assert.ok(seen.some(x=>x.path==='/items/validate'));noCreate(seen);
});

test('una predicción de otro dominio o ajena a las candidatas se rechaza y queda en review',async()=>{
 const rechazadas=[
  [{domain_id:'MLU-TEXTBOOKS',category_id:'MLU3026'}],
  [{domain_id:'MLU-BOOKS',category_id:'MLU7777'}],
  [{domain_id:'MLU-BOOKS'}],
  [{category_id:'MLU3026'}],
  [],
  {results:[{domain_id:'MLU-BOOKS',category_id:'MLU3026'}]},
 ];
 for(const prediction of rechazadas){
  const {api,seen}=fetcherFor({domainCategories:[{category_id:'MLU3025'},{category_id:'MLU3026'}],categories:{MLU3025:LEAF,MLU3026:LEAF},prediction});
  await assert.rejects(()=>api.prepare({},row,catalogPolicy,1200),error=>{assert.ok(error instanceof PublicationError);assert.equal(error.code,'ambiguous_book_category');return true;},JSON.stringify(prediction));
  assert.ok(!seen.some(x=>x.path==='/items/validate'),'nada ambiguo llega a validación');noCreate(seen);
 }
});

test('múltiples candidatas sin desempate posible dejan review explícito y nunca eligen la primera',async()=>{
 const {api,seen}=fetcherFor({
  domainCategories:Array.from({length:21},(_,i)=>({category_id:`MLU40${String(i).padStart(2,'0')}`})),
  categories:{},
 });
 await assert.rejects(()=>api.prepare({},row,catalogPolicy,1200),/ambiguous_book_category/,'un listado desmedido no se recorre entero');
 assert.ok(!seen.some(x=>x.path.startsWith('/categories/')),'no consulta detalle de un listado desmedido');noCreate(seen);
});

// El dominio en sí ya viene verificado como MLU-BOOKS antes de resolver la
// categoría, así que la guarda de domain_id de resolveDomainCategory es defensa
// en profundidad y no es alcanzable desde prepare: no se afirma aquí.
test('un dominio sin categorías o sin candidatas válidas sigue siendo missing_book_category',async()=>{
 const escenarios=[
  {domainCategories:[]},
  {domainCategories:{categories:[]}},
  {domainCategories:[{category_id:'MLU1111'}],categories:{MLU1111:{settings:{listing_allowed:false},children_categories:[]}}},
  {domainCategories:[{category_id:'MLU1111'}],categories:{MLU1111:{id:'MLU9999',...LEAF}}},
 ];
 for(const escenario of escenarios){
  const {api,seen}=fetcherFor(escenario);
  await assert.rejects(()=>api.prepare({},row,catalogPolicy,1200),error=>{assert.equal(error.code,'missing_book_category');return true;},JSON.stringify(escenario));
  assert.ok(!seen.some(x=>x.path==='/items/validate'));noCreate(seen);
 }
});

test('/items/validate conserva la última palabra sobre la categoría resuelta por dominio',async()=>{
 const {fetcher,seen}=fetcherFor({domainCategories:[{category_id:'MLU3025'}],categories:{MLU3025:LEAF}});
 const api=createPublicationMeli({tokenProvider:async()=>'token',fetcher:async(url,options)=>{
  if(new URL(url).pathname==='/items/validate')return Response.json({cause:[{code:'item.category_id.invalid',message:'x'}]},{status:400});
  return fetcher(url,options);
 }});
 await assert.rejects(()=>api.prepare({},row,catalogPolicy,1200),error=>{assert.equal(error.code,'ml_http_400');assert.equal(error.stage,'item_validation');assert.deepEqual(error.validationCodes,['item.category_id.invalid']);return true;});
 noCreate(seen);
});

test('un alta tradicional sin category_id conserva su predicción por título y no consulta el dominio',async()=>{
 // Límite de alcance: la conversión por dominio es sólo de Catálogo obligatorio.
 const {api,seen}=fetcherFor({
  detail:{settings:{listing_strategy:'catalog_optional'}},
  categories:{MLU12345:LEAF},
  prediction:[{domain_id:'MLU-BOOKS',category_id:'MLU12345'}],
 });
 const payload=await api.prepare({},row,catalogPolicy,1200);
 assert.equal(payload.catalog_listing,false,'sigue siendo un alta tradicional');
 assert.equal(payload.category_id,'MLU12345');
 assert.ok(seen.some(x=>x.path==='/sites/MLU/domain_discovery/search'));
 assert.ok(!seen.some(x=>x.path.startsWith('/catalog_domains/')),'el camino tradicional no toca el endpoint de dominio');noCreate(seen);
});
