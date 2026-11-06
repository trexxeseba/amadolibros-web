import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPublicationMeli} from '../publication-meli.js';

const policy={supplierDiscount:.25,arsPerUyu:40,usdPerUyu:42,freightUsdKg:15,laborUyu:0,margin:.35,mlFee:.17,deliveryUyu:270,minimumContributionUyu:200,minimumSaleUyu:1600,roundUyu:10,availabilityDays:18,additionalPricePct:0,listingTypeId:'gold_special',catalogListing:'required_only'};
const payload=extra=>({site_id:'MLU',category_id:'MLU1196',price:1990,currency_id:'UYU',available_quantity:1,buying_mode:'buy_it_now',listing_type_id:'gold_special',condition:'new',catalog_listing:false,seller_custom_field:'AMADO-AR-9789502323060',title:'Libro',sale_terms:[{id:'MANUFACTURING_TIME',value_name:'18 días'}],...extra});
function fake(){
 const calls=[];let n=0;
 const fetcher=async(url,o={})=>{const u=new URL(String(url)),key=`${o.method??'GET'} ${u.pathname}`;calls.push(key);
  const J=b=>new Response(JSON.stringify(b),{status:200,headers:{'content-type':'application/json'}});
  if(u.pathname==='/users/me')return J({id:2341378249,site_id:'MLU'});
  if(u.pathname==='/sites/MLU/listing_prices')return J([{listing_type_id:'gold_special',currency_id:'UYU',sale_fee_amount:300,listing_fee_amount:0}]);
  if(u.pathname==='/items/validate')return new Response(null,{status:204});
  if(u.pathname==='/items'&&o.method==='POST')return J({id:'MLU'+(++n),seller_id:2341378249});
  throw new Error('unexpected '+key);};
 return {calls,fetcher};
}
const count=(calls,key)=>calls.filter(c=>c===key).length;

test('without trustPreparedMs create revalidates fees, the item and the account every time (as always)',async()=>{
 const f=fake(),api=createPublicationMeli({sellerId:'2341378249',fetcher:f.fetcher,tokenProvider:async()=>'tok',tokenInvalidator:async()=>{}});
 await api.create({},payload({prepared_at:Date.now()}),policy);await api.create({},payload(),policy);
 assert.equal(count(f.calls,'GET /sites/MLU/listing_prices'),2);assert.equal(count(f.calls,'POST /items/validate'),2);assert.equal(count(f.calls,'GET /users/me'),2);assert.equal(count(f.calls,'POST /items'),2);
});

test('with trustPreparedMs a recently prepared payload skips the repeated checks and the account is verified once per token',async()=>{
 const f=fake(),api=createPublicationMeli({sellerId:'2341378249',fetcher:f.fetcher,tokenProvider:async()=>'tok',tokenInvalidator:async()=>{},trustPreparedMs:7200000});
 await api.create({},payload({prepared_at:Date.now()}),policy);await api.create({},payload({prepared_at:Date.now()}),policy);
 assert.equal(count(f.calls,'GET /sites/MLU/listing_prices'),0);assert.equal(count(f.calls,'POST /items/validate'),0);assert.equal(count(f.calls,'GET /users/me'),1);assert.equal(count(f.calls,'POST /items'),2);
 // Vieja o sin fecha: se revalida como siempre.
 await api.create({},payload({prepared_at:Date.now()-3*3600000}),policy);await api.create({},payload(),policy);
 assert.equal(count(f.calls,'GET /sites/MLU/listing_prices'),2);assert.equal(count(f.calls,'POST /items/validate'),2);
 // prepared_at nunca viaja a Mercado Libre.
});
