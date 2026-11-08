import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPublicationMeli} from '../publication-meli.js';
import {candidateSkipState} from '../publication-engine.js';
import {ipRisk} from '../ip-risk.js';

const isbn='9788861826885';
const policy={supplierDiscount:.25,arsPerUyu:40,usdPerUyu:42,freightUsdKg:15,laborUyu:0,margin:.35,mlFee:.17,deliveryUyu:270,minimumContributionUyu:200,minimumSaleUyu:1600,roundUyu:10,availabilityDays:18,additionalPricePct:0,listingTypeId:'gold_special',catalogListing:'required_only'};
const fetcherFor=name=>async url=>{const p=new URL(String(url)).pathname;
 if(p==='/users/me')return Response.json({id:2341378249,site_id:'MLU'});
 if(p==='/products/search')return Response.json({paging:{total:1},results:[{id:'MLU555',name,attributes:[{id:'GTIN',value_name:isbn}],settings:{listing_strategy:'catalog_required'}}]});
 if(p==='/products/MLU555')return Response.json({id:'MLU555',name,status:'active',domain_id:'MLU-BOOKS',category_id:'MLU1196',settings:{listing_strategy:'catalog_required'},attributes:[{id:'GTIN',value_name:isbn},{id:'BOOK_PUBLISHER',value_name:'Alma Edizioni'}]});
 throw new Error('stop_after_check '+p);};

test('a clean SBS title on a catalog sheet whose name says Ebook is blocked before associating (Vintage)',async()=>{
 const api=createPublicationMeli({sellerId:'2341378249',fetcher:fetcherFor('Dieci A1 - Libro + Ebook Interattivo'),tokenProvider:async()=>'tok',tokenInvalidator:async()=>{}});
 const row={isbn,title:'Dieci A1',listArs:40000,weightKg:.5,stock:'2'};
 assert.equal(ipRisk(row.title),null,'the SBS title alone looks clean');
 await assert.rejects(()=>api.prepare({},row,policy,1990),e=>e.code==='ip_risk_ebook');
 assert.equal(candidateSkipState(Object.assign(new (await import('../publication-policy.js')).PublicationError('ip_risk_ebook',422))),'skipped_ip_risk');
});

test('the catalog publisher is checked too, and sample copies are blocked',async()=>{
 const api=createPublicationMeli({sellerId:'2341378249',fetcher:fetcherFor('Dieci A1'),tokenProvider:async()=>'tok',tokenInvalidator:async()=>{}});
 await assert.rejects(()=>api.prepare({},{isbn,title:'Dieci A1',listArs:40000,weightKg:.5,stock:'2'},policy,1990),e=>e.code==='ip_risk_editorial_educativa');
 for(const t of ['Copia saggio','Not for resale','Inspection copy','Campione gratuito'])assert.ok(ipRisk(t),t);
 assert.equal(ipRisk('Campione gratuito'),'muestra');
});
