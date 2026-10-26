import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sqliteD1} from './helpers/sqlite-d1.js';
import {PublicationStore} from '../publication-store.js';
import {createPublicationService} from '../publication-engine.js';
import {quoteMercadoLibre,validPolicy,policyHash,normalizeSupplierRow,PublicationError} from '../publication-policy.js';
import {createPublicationMeli} from '../publication-meli.js';

const base={supplierDiscount:.2,arsPerUyu:40,usdPerUyu:40,freightUsdKg:10,laborUyu:0,margin:.4,mlFee:.15,deliveryUyu:200,minimumContributionUyu:100,minimumSaleUyu:100,roundUyu:10,availabilityDays:20,additionalPricePct:0,listingTypeId:'gold_special'};
const comp={...base,competitive:true,competitiveFloorMargin:.1};
const book={isbn:'9789502323060',title:'Libro de prueba',listArs:10000,weightKg:.2,stock:'1'};
// Con estos números: precio de margen completo 860, piso (margen 10%) 690.

test('las políticas viejas conservan exactamente el mismo hash',async()=>{
 const p=validPolicy(base);assert.equal('competitive' in p,false);assert.equal('competitiveFloorMargin' in p,false);
 assert.equal(await policyHash(base),await policyHash({...base,competitive:false}));
 assert.notEqual(await policyHash(base),await policyHash(comp));
});
test('la política competitiva exige un piso de margen válido, definido por Seba',()=>{
 for(const bad of [undefined,-.1,.41,'0.1',NaN])assert.throws(()=>validPolicy({...base,competitive:true,competitiveFloorMargin:bad}),/invalid_policy/);
 assert.throws(()=>validPolicy({...base,competitive:'si'}),/invalid_policy/);
 assert.equal(validPolicy(comp).competitiveFloorMargin,.1);
});
test('sin competidor o con competidor más caro el precio es el de margen completo',()=>{
 assert.equal(quoteMercadoLibre(book,base).price,860);
 const none=quoteMercadoLibre(book,comp);assert.equal(none.price,860);assert.equal(none.competitive.mode,'no_competitor');assert.equal(none.competitive.floor,690);
 const alone=quoteMercadoLibre({...book,competitor:{price:null,at:1}},comp);assert.equal(alone.price,860);assert.equal(alone.competitive.mode,'no_competitor');
 const dear=quoteMercadoLibre({...book,competitor:{price:2000,at:1}},comp);assert.equal(dear.price,860);assert.equal(dear.competitive.mode,'kept');
});
test('baja a ganador menos 1% redondeado hacia abajo, pero nunca bajo el piso',()=>{
 const a=quoteMercadoLibre({...book,competitor:{price:800,at:1}},comp);assert.equal(a.price,790);assert.equal(a.competitive.mode,'matched');assert.ok(a.contribution>0);
 const edge=quoteMercadoLibre({...book,competitor:{price:700,at:1}},comp);assert.equal(edge.price,690);assert.equal(edge.skip,undefined);
 const below=quoteMercadoLibre({...book,competitor:{price:690,at:1}},comp);assert.equal(below.skip,'not_competitive');assert.equal(below.competitive.mode,'below_floor');
 // La contribución nunca queda debajo de la mínima en ningún precio publicable.
 for(const rival of [700,720,760,800,820,850,860,900]){const q=quoteMercadoLibre({...book,competitor:{price:rival,at:1}},comp);if(!q.skip)assert.ok(q.contribution>=comp.minimumContributionUyu,`rival ${rival}`);}
});
test('con la política vieja el competidor guardado no cambia el precio',()=>{
 assert.equal(quoteMercadoLibre({...book,competitor:{price:300,at:1}},base).price,860);
});
test('el renglón del proveedor valida la foto del competidor',()=>{
 assert.deepEqual(normalizeSupplierRow({...book,competitor:{price:900,at:5}}).competitor,{price:900,at:5});
 assert.deepEqual(normalizeSupplierRow({...book,competitor:{price:null,at:5}}).competitor,{price:null,at:5});
 assert.equal(normalizeSupplierRow(book).competitor,undefined);
 for(const bad of [{price:-1,at:1},{price:'9',at:1},{price:5}])assert.throws(()=>normalizeSupplierRow({...book,competitor:bad}),/invalid_competitor/);
});

function mlFetcher(map){return async url=>{const path=String(url).replace('https://api.mercadolibre.com','');const hit=Object.entries(map).find(([k])=>path.startsWith(k));if(!hit)return new Response('{}',{status:404});return new Response(JSON.stringify(hit[1]),{status:200,headers:{'content-type':'application/json'}});};}
test('competitorPrice lee el ganador de la ficha y nunca nuestro propio precio',async()=>{
 const at=()=>1234;
 const mk=map=>createPublicationMeli({fetcher:mlFetcher(map),tokenProvider:async()=>'tok',now:at});
 const search={results:[{id:'MLU111'}],paging:{total:1}};
 assert.deepEqual(await mk({'/products/search':search,'/products/MLU111':{buy_box_winner:{price:3890,seller_id:555,currency_id:'UYU'}}}).competitorPrice({},'9789502323060'),{price:3890,at:1234});
 assert.deepEqual(await mk({'/products/search':search,'/products/MLU111':{buy_box_winner:{price:3000,seller_id:440298103,currency_id:'UYU'}}}).competitorPrice({},'9789502323060'),{price:null,at:1234});
 assert.deepEqual(await mk({'/products/search':search,'/products/MLU111/items':{results:[{seller_id:440298103,price:2000,currency_id:'UYU'},{seller_id:7,price:3500,currency_id:'UYU'},{seller_id:8,price:3300,currency_id:'UYU'},{seller_id:9,price:10,currency_id:'USD'}]},'/products/MLU111':{}}).competitorPrice({},'9789502323060'),{price:3300,at:1234});
 assert.deepEqual(await mk({'/products/search':{results:[],paging:{total:0}}}).competitorPrice({},'9789502323060'),{price:null,at:1234});
 await assert.rejects(()=>mk({'/products/search':{results:[{id:'MLU1'},{id:'MLU2'}],paging:{total:2}}}).competitorPrice({},'9789502323060'),/ambiguous_product_metadata/);
});

async function fixture(t,rows,{competitorPrices={}}={}){
 const dir=await mkdtemp(join(tmpdir(),'amado-comp-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const db=sqliteD1(join(dir,'queue.sqlite')),store=new PublicationStore(db),now=Date.now(),feedId=crypto.randomUUID(),runId=crypto.randomUUID();
 const env={ORDERS_DB:db,USER_ID:'440298103',APP_ID:'4741021817925208',ML_PUBLISHER_MODE:'enabled'};
 await store.initialize();await store.beginFeed(feedId,new Date(now).toISOString(),rows.length,now);await store.importRows(feedId,rows);await store.commitFeed(feedId);
 await store.createRun({id:runId,feedId,policy:comp,policyHash:await policyHash(comp),now,dailyCap:100,preflightLimit:10});
 await store.saveIndex(runId,{status:'paused',scroll:null,pending:[],done:true,seen:0,completedAt:new Date(now).toISOString()});
 const calls={create:0,competitor:0,prepared:[]};
 const api={async skuItems(){return [];},
  async competitorPrice(env,isbn){calls.competitor++;return {price:competitorPrices[isbn]??null,at:now};},
  async prepare(env,row,p,price){calls.prepared.push([row.isbn,price]);return {price,currency_id:'UYU',condition:'new',catalog_listing:false,seller_custom_field:`AMADO-AR-${row.isbn}`};},
  async create(){calls.create++;return {id:`MLU90000000${calls.create}`,seller_id:440298103};}};
 const service=createPublicationService({api,storeFactory:()=>store,now:()=>now});
 return {store,service,env,runId,feedId,calls};
}
const rows=[book,{...book,isbn:'9786075272795',title:'Libro dos'},{...book,isbn:'9780306406157',title:'Libro tres'}];
test('el motor baja al ganador menos 1%, omite lo que no llega al piso y guarda la foto una sola vez',async t=>{
 const f=await fixture(t,rows,{competitorPrices:{'9789502323060':800,'9786075272795':690}});
 const r=await f.service.tick(f.env,f.runId);
 const prices=Object.fromEntries(f.calls.prepared);
 assert.equal(prices['9789502323060'],790);          // ganador 800 -> 790
 assert.equal(prices['9786075272795'],undefined);    // ganador 690 -> bajo el piso, no se prepara ni publica
 assert.equal(prices['9780306406157'],860);          // sin competencia -> margen completo
 assert.equal(r.counts.find(x=>x.state==='skipped_not_competitive').n,1);
 assert.equal(r.counts.find(x=>x.state==='validated').n,2);
 assert.equal(f.calls.competitor,3);
 // La foto queda en el renglón del feed: segunda pasada no vuelve a consultar.
 assert.deepEqual((await f.store.stock(f.feedId,'9789502323060')).competitor.price,800);
 await f.service.tick(f.env,f.runId);assert.equal(f.calls.competitor,3);
});
test('aprobada la corrida, se publica al mismo precio validado y lo omitido no se publica',async t=>{
 const f=await fixture(t,rows,{competitorPrices:{'9789502323060':800,'9786075272795':690}});
 await f.service.tick(f.env,f.runId);
 await f.service.command(f.env,'approve',{run_id:f.runId,policy_hash:await policyHash(comp)});
 const r=await f.service.tick(f.env,f.runId);
 assert.equal(f.calls.create,2);assert.equal(r.state,'complete');
 assert.equal(r.counts.find(x=>x.state==='published').n,2);assert.equal(r.counts.find(x=>x.state==='skipped_not_competitive').n,1);
});
