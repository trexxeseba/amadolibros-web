import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPublicationMeli} from '../publication-meli.js';

const isbn='9789502323060';
const policy={supplierDiscount:.25,arsPerUyu:40,usdPerUyu:42,freightUsdKg:15,laborUyu:0,margin:.35,mlFee:.17,deliveryUyu:270,minimumContributionUyu:200,minimumSaleUyu:1600,roundUyu:10,availabilityDays:18,additionalPricePct:0,listingTypeId:'gold_special',catalogListing:'required_only'};
const row={isbn,title:'Libro sin ficha',author:'Autor',publisher:'Editorial',listArs:40000,weightKg:.5,stock:'2'};
function fake(){
 const seen=[];
 const fetcher=async(url,o={})=>{
  const u=new URL(String(url)),p=u.pathname;seen.push(p);
  if(u.hostname==='www.sbs.com.ar')return Response.json([{ISBN:[isbn],Idioma:['Español'],Tapa:['Rústica'],items:[{ean:isbn,isKit:false,images:[{imageUrl:'https://sbslibreria.vteximg.com.br/arquivos/ids/5707257/cover.jpg'}],sellers:[{sellerId:'1',commertialOffer:{IsAvailable:true,AvailableQuantity:3}}]}]}]);
  if(p==='/users/me')return Response.json({id:2341378249,site_id:'MLU'});
  if(p==='/users/2341378249/shipping_preferences')return Response.json({modes:['me2'],logistics:[{mode:'me2',types:[{type:'xd_drop_off',default:true,status:'active'}]}]});
  if(p==='/products/search')return Response.json({paging:{total:1},results:[{id:'MLU12345',attributes:[{id:'GTIN',value_name:isbn}],settings:{listing_strategy:'catalog_required'}}]});
  if(p==='/products/MLU12345')return Response.json({message:'not found',error:'not_found',status:404},{status:404});
  if(p==='/sites/MLU/domain_discovery/search')return Response.json([{domain_id:'MLU-BOOKS',category_id:'MLU1196'}]);
  if(p==='/categories/MLU1196')return Response.json({settings:{listing_allowed:true,max_title_length:60},children_categories:[]});
  if(p==='/categories/MLU1196/attributes')return Response.json([{id:'GTIN',tags:{}},{id:'BOOK_TITLE',tags:{}},{id:'AUTHOR',tags:{}},{id:'LANGUAGE',tags:{}},{id:'BOOK_COVER',tags:{}}]);
  if(p==='/sites/MLU/listing_prices')return Response.json({currency_id:'UYU',listing_type_id:'gold_special',sale_fee_amount:100,listing_fee_amount:0});
  if(p==='/items/validate')return new Response(null,{status:204});
  throw new Error('unexpected '+p);
 };
 return {seen,fetcher};
}
const mk=(f,extra={})=>createPublicationMeli({sellerId:'2341378249',fetcher:f.fetcher,tokenProvider:async()=>'tok',tokenInvalidator:async()=>{},...extra});

test('without the option a catalog sheet that answers 404 still fails as before',async()=>{
 const f=fake();
 await assert.rejects(()=>mk(f).prepare({},row,policy,1990),e=>e.status===404);
 await assert.rejects(()=>mk(f).competitorPrice({},isbn),e=>e.status===404);
});

test('with productNotFoundAsMissing it becomes a traditional listing with verified supplier data and no competitor',async()=>{
 const f=fake(),api=mk(f,{productNotFoundAsMissing:true});
 const payload=await api.prepare({},row,policy,1990);
 assert.equal(payload.catalog_listing,false);assert.equal(payload.catalog_product_id,undefined);
 assert.equal(payload.category_id,'MLU1196');assert.equal(payload.price,1990);
 assert.ok(payload.attributes.some(a=>a.id==='GTIN'&&a.value_name===isbn));
 assert.ok(f.seen.includes('/sites/MLU/domain_discovery/search'));
 const competitor=await api.competitorPrice({},isbn);
 assert.equal(competitor.price,null);assert.equal(competitor.days,null);
});

test('with the option a sheet nobody sells (items 404) means no competitor, so the book is not sent to review',async()=>{
 const seen=[];
 const fetcher=async url=>{const p=new URL(String(url)).pathname;seen.push(p);
  if(p==='/products/search')return Response.json({paging:{total:1},results:[{id:'MLU777',attributes:[{id:'GTIN',value_name:isbn}]}]});
  if(p==='/products/MLU777')return Response.json({id:'MLU777',domain_id:'MLU-BOOKS',buy_box_winner:null});
  if(p==='/products/MLU777/items')return Response.json({message:'No winners found',status:404},{status:404});
  throw new Error('unexpected '+p);};
 const off=createPublicationMeli({sellerId:'2341378249',fetcher,tokenProvider:async()=>'tok',tokenInvalidator:async()=>{}});
 await assert.rejects(()=>off.competitorPrice({},isbn),e=>e.status===404);
 const on=createPublicationMeli({sellerId:'2341378249',fetcher,tokenProvider:async()=>'tok',tokenInvalidator:async()=>{},productNotFoundAsMissing:true});
 const c=await on.competitorPrice({},isbn);
 assert.equal(c.price,null);assert.equal(c.days,null);
});

test('with catalogOnly a book without a catalog sheet is never prepared as a traditional listing',async()=>{
 const noSheet=async url=>{const p=new URL(String(url)).pathname;if(p==='/users/me')return Response.json({id:2341378249,site_id:'MLU'});if(p==='/products/search')return Response.json({paging:{total:0},results:[]});throw new Error('unexpected '+p);};
 const on=createPublicationMeli({sellerId:'2341378249',fetcher:noSheet,tokenProvider:async()=>'tok',tokenInvalidator:async()=>{},catalogOnly:true});
 await assert.rejects(()=>on.prepare({},row,policy,1990),e=>e.code==='catalog_required_no_product');
 const {candidateSkipState}=await import('../publication-engine.js');
 const {PublicationError}=await import('../publication-policy.js');
 assert.equal(candidateSkipState(new PublicationError('catalog_required_no_product',422)),'skipped_identity');
});
