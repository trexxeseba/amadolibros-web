import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicationMeli,sellerPackageAttributes,SELLER_PACKAGE_IDS} from '../publication-meli.js';

// Mercado Libre rechazó el preflight con item.attribute.missing.seller.package.dimensions.
// El paquete se estima desde el peso del libro y siempre llega a /items/validate,
// aunque la categoría no lo marque como requerido. Ninguna prueba admite POST /items.
const policy={supplierDiscount:.2,arsPerUyu:40,usdPerUyu:40,freightUsdKg:10,laborUyu:0,margin:.2,mlFee:.15,deliveryUyu:200,minimumContributionUyu:100,minimumSaleUyu:1000,roundUyu:10,availabilityDays:10,additionalPricePct:0,listingTypeId:'gold_special',catalogListing:'required_only'};
const row={isbn:'9780008623210',title:'5 TYPES OF WEALTH, THE - PB',listArs:39519.634501,weightKg:.495,stock:'1'};
const pack=weightKg=>Object.fromEntries(sellerPackageAttributes(weightKg).map(a=>[a.id,a.value_name]));

test('las cuatro franjas de peso dan alto, largo y ancho enteros en cm',()=>{
 assert.deepEqual(pack(.4),{SELLER_PACKAGE_HEIGHT:'4 cm',SELLER_PACKAGE_LENGTH:'25 cm',SELLER_PACKAGE_WIDTH:'18 cm',SELLER_PACKAGE_WEIGHT:'600 g'});
 assert.deepEqual(pack(.495),{SELLER_PACKAGE_HEIGHT:'6 cm',SELLER_PACKAGE_LENGTH:'30 cm',SELLER_PACKAGE_WIDTH:'22 cm',SELLER_PACKAGE_WEIGHT:'700 g'});
 assert.deepEqual(pack(1.158),{SELLER_PACKAGE_HEIGHT:'10 cm',SELLER_PACKAGE_LENGTH:'35 cm',SELLER_PACKAGE_WIDTH:'25 cm',SELLER_PACKAGE_WEIGHT:'1400 g'});
 assert.deepEqual(pack(1.51),{SELLER_PACKAGE_HEIGHT:'15 cm',SELLER_PACKAGE_LENGTH:'40 cm',SELLER_PACKAGE_WIDTH:'30 cm',SELLER_PACKAGE_WEIGHT:'1700 g'});
 // Bordes de cada franja.
 assert.equal(pack(.41).SELLER_PACKAGE_LENGTH,'30 cm');assert.equal(pack(.8).SELLER_PACKAGE_LENGTH,'30 cm');
 assert.equal(pack(.81).SELLER_PACKAGE_LENGTH,'35 cm');assert.equal(pack(1.5).SELLER_PACKAGE_LENGTH,'35 cm');
});

test('el peso del paquete suma 150 g y redondea hacia arriba a gramos enteros múltiplos de 100',()=>{
 assert.equal(pack(.225).SELLER_PACKAGE_WEIGHT,'400 g');
 assert.equal(pack(.351).SELLER_PACKAGE_WEIGHT,'600 g');
 assert.equal(pack(.45).SELLER_PACKAGE_WEIGHT,'600 g');
 // Los decimales binarios no suben una franja de 100 g (0,55 kg * 1000 = 550,0000000000001).
 assert.equal(pack(.55).SELLER_PACKAGE_WEIGHT,'700 g');
 assert.equal(pack(.647).SELLER_PACKAGE_WEIGHT,'800 g');
 for(const w of [.05,.2,.399,.73,1.2,2.5,30])for(const a of sellerPackageAttributes(w))assert.match(a.value_name,/^\d+ (cm|g)$/);
 assert.throws(()=>sellerPackageAttributes(0),/invalid_weight/);assert.throws(()=>sellerPackageAttributes(NaN),/invalid_weight/);
});

test('los cuatro atributos llegan a /items/validate aunque la categoría no los liste y nunca hay POST /items',async()=>{
 const seen=[];let validated=null;
 const fetcher=async(url,options={})=>{
  const p=new URL(url).pathname;seen.push({path:p,method:options.method??'GET'});
  if(p==='/users/me')return Response.json({id:440298103,site_id:'MLU',tags:[]});
  if(p==='/products/search')return Response.json({paging:{total:1},results:[{id:'MLU123456',attributes:[{id:'GTIN',value_name:row.isbn}],settings:{listing_strategy:'catalog_required'}}]});
  // El producto trae un peso de paquete propio: lo reemplaza la estimación.
  if(p==='/products/MLU123456')return Response.json({id:'MLU123456',status:'active',domain_id:'MLU-BOOKS',category_id:'MLU12345',settings:{listing_strategy:'catalog_required'},attributes:[{id:'GTIN',value_name:row.isbn},{id:'BOOK_COVER',value_name:'Blanda'},{id:'SELLER_PACKAGE_WEIGHT',value_name:'1 g'}],pictures:[{id:'123456-MLU999999'}]});
  if(p==='/categories/MLU12345/attributes')return Response.json([{id:'GTIN',tags:{}},{id:'SELLER_SKU',tags:{}},{id:'BOOK_COVER',tags:{}},{id:'SELLER_PACKAGE_WEIGHT',tags:{}}]);
  if(p==='/categories/MLU12345')return Response.json({settings:{listing_allowed:true,max_title_length:60},children_categories:[]});
  if(p==='/sites/MLU/listing_prices')return Response.json({currency_id:'UYU',listing_type_id:'gold_special',sale_fee_amount:100,listing_fee_amount:0});
  if(p==='/items/validate'){validated=JSON.parse(options.body);return new Response(null,{status:204});}
  throw Error('Unexpected endpoint '+p);
 };
 const api=createPublicationMeli({fetcher,tokenProvider:async()=>'token'});
 const payload=await api.prepare({},row,policy,1200);
 assert.ok(validated,'/items/validate recibió el payload');
 const sent=validated.attributes.filter(a=>SELLER_PACKAGE_IDS.includes(a.id));
 assert.deepEqual(sent,[{id:'SELLER_PACKAGE_HEIGHT',value_name:'6 cm'},{id:'SELLER_PACKAGE_LENGTH',value_name:'30 cm'},{id:'SELLER_PACKAGE_WIDTH',value_name:'22 cm'},{id:'SELLER_PACKAGE_WEIGHT',value_name:'700 g'}]);
 assert.deepEqual(payload.attributes,validated.attributes);
 // Nada más cambia: precio, Catálogo e identificadores siguen iguales.
 assert.equal(validated.price,1200);assert.equal(validated.catalog_listing,true);assert.equal(validated.catalog_product_id,'MLU123456');
 assert.ok(validated.attributes.some(a=>a.id==='GTIN'&&a.value_name===row.isbn));
 assert.ok(!seen.some(x=>x.path==='/items'&&x.method==='POST'),'ninguna prueba puede crear un ítem real');
});
