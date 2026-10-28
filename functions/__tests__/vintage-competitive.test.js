import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {syncStock} from '../../scripts/vintage-local/stock-sync.mjs';
import {amendmentChain} from '../../scripts/vintage-local/engine.mjs';
import {BULK_RUN} from '../_shared/meli-vintage-bulk.js';
import {policyHash,quoteMercadoLibre} from '../../worker-sync/publication-policy.js';
import {vintagePolicy,vintageCompetitivePolicy,vintageMinimumFor,requireVintagePrice} from '../../worker-sync/vintage-pricing.js';

const SELLER='2341378249';
const base={supplierDiscount:.25,arsPerUyu:40,usdPerUyu:42,freightUsdKg:15,laborUyu:0,margin:.35,mlFee:.17,deliveryUyu:270,minimumContributionUyu:200,minimumSaleUyu:1600,roundUyu:10,availabilityDays:18,additionalPricePct:0,listingTypeId:'gold_special',catalogListing:'required_only'};
const policy=vintageCompetitivePolicy(base);
const book={listArs:80000,weightKg:.5};
const full=quoteMercadoLibre(book,base).price;
function isbn13(n){const stem='978'+String(n).padStart(9,'0');const sum=[...stem].reduce((t,c,i)=>t+Number(c)*(i%2?3:1),0);return stem+((10-sum%10)%10);}

test('Vintage competitive policy: 18 % floor, never below UYU 1.500, ganador -1 %, and below the floor the book keeps its full price',()=>{
 assert.equal(policy.competitive,true);assert.equal(policy.competitiveFloorMargin,.18);assert.equal(policy.competitiveMinimumSaleUyu,1500);assert.equal(policy.competitiveBelowFloor,'full');assert.equal(policy.minimumSaleUyu,1600);
 const q=rival=>quoteMercadoLibre({...book,competitor:{price:rival,at:1,days:20}},policy);
 // un rival un poco más barato: se iguala a -1 %
 const matched=q(full-100);assert.equal(matched.competitive.mode,'matched');assert.equal(matched.price,Math.floor((full-100)*.99/10)*10);
 assert.ok(matched.price>=matched.competitive.floor);
 // el piso del 18 % se respeta: un rival regalado no arrastra el precio, se publica a precio completo
 const cheap=q(500);assert.equal(cheap.competitive.mode,'below_floor_full_price');assert.equal(cheap.price,full);assert.equal(cheap.skip,undefined);
 // un vendedor local que entrega antes (Flex): no se baja, se queda el precio completo
 const flex=quoteMercadoLibre({...book,competitor:{price:full-300,at:1,days:0}},policy);assert.equal(flex.competitive.mode,'rival_faster_delivery');assert.equal(flex.price,full);
 // nadie más lo vende: precio completo
 assert.equal(quoteMercadoLibre({...book,competitor:{price:null,at:1,days:null}},policy).price,full);
 // un libro barato puede igualarse hasta 1.500, nunca menos
 const small={listArs:20000,weightKg:.3},smallFull=quoteMercadoLibre(small,base).price;
 assert.equal(smallFull,1600);
 const s=quoteMercadoLibre({...small,competitor:{price:1400,at:1,days:30}},policy);assert.ok(s.price>=1500);
 assert.equal(quoteMercadoLibre({...small,competitor:{price:1530,at:1,days:30}},policy).price,1510);
});
test('the optional competitive fields only enter the hash when set, so earlier approved policies keep their hash',async()=>{
 const old={...base,competitive:true,competitiveFloorMargin:.18};
 const {validPolicy}=await import('../../worker-sync/publication-policy.js');
 assert.equal('competitiveMinimumSaleUyu' in validPolicy(old),false);assert.equal('competitiveBelowFloor' in validPolicy(old),false);
 assert.notEqual(await policyHash(old),await policyHash(policy));
 assert.throws(()=>validPolicy({...old,competitiveMinimumSaleUyu:1700}),/invalid_policy/);
 assert.throws(()=>validPolicy({...old,competitiveBelowFloor:'maybe'}),/invalid_policy/);
 // la política de Vintage no deja bajar el mínimo competitivo de 1.500
 assert.equal(vintagePolicy({...base,...old,competitiveMinimumSaleUyu:900}).competitiveMinimumSaleUyu,1500);
});
test('the minimum for a new listing is 1.600 at full price and 1.500 with the competitive policy',()=>{
 assert.equal(vintageMinimumFor(base),1600);assert.equal(vintageMinimumFor(policy),1500);
 assert.throws(()=>requireVintagePrice({currency_id:'UYU',price:1599}),/vintage_price_below_1600/);
 assert.doesNotThrow(()=>requireVintagePrice({currency_id:'UYU',price:1500},vintageMinimumFor(policy)));
 assert.throws(()=>requireVintagePrice({currency_id:'UYU',price:1499},vintageMinimumFor(policy)),/vintage_price_below_1500/);
 // aunque alguien pida menos, el piso absoluto es 1.500
 assert.throws(()=>requireVintagePrice({currency_id:'UYU',price:1200},100),/vintage_price_below_1500/);
});
test('a local run accepts a new policy only through the recorded amendment chain',()=>{
 const h=c=>c.repeat(64),chain=[{old_hash:h('a'),new_hash:h('b')},{old_hash:h('b'),new_hash:h('c')}];
 assert.equal(amendmentChain(chain,h('a'),h('b')),true);assert.equal(amendmentChain(chain,h('a'),h('c')),true);
 assert.equal(amendmentChain(chain,h('a'),h('d')),false);assert.equal(amendmentChain(chain,h('c'),h('a')),false);
 assert.equal(amendmentChain([{old_hash:h('a'),new_hash:h('a')}],h('a'),h('b')),false);assert.equal(amendmentChain(null,h('a'),h('b')),false);
});

// ── pasada 'correct' (30 % del día) ──
const ISBNS=Array.from({length:6},(_,i)=>isbn13(700+i));
async function fixture(t,{connectionPolicy=policy,competitor}={}){
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'vintage-correct-'));t.after(()=>fs.rm(temp,{recursive:true,force:true}));
 const clock={value:Date.parse('2026-10-26T12:00:00Z')},sha='a'.repeat(64),source_date=new Date(clock.value-3600000).toISOString();
 const receipts=ISBNS.map((isbn,i)=>({seller_id:SELLER,isbn,state:'published',item_id:'MLU'+(800+i),run_id:BULK_RUN,created_at:1,updated_at:1}));
 const c={version:1,endpoint:'https://www.amadolibros.com/operations/vintage-local',key:'b'.repeat(64),expires_at:clock.value+86400000,seller_id:SELLER,app_id:'4741021817925208',run_id:BULK_RUN,policy:connectionPolicy,policy_hash:await policyHash(connectionPolicy),feed_id:'feed-1',source_date,source_sha256:sha,receipts};
 const connection=path.join(temp,'connection.json');await fs.writeFile(connection,JSON.stringify(c));
 const items=new Map(receipts.map(r=>[r.item_id,{id:r.item_id,seller_id:SELLER,status:'active',available_quantity:1,seller_custom_field:'AMADO-AR-'+r.isbn,price:full,currency_id:'UYU'}]));
 const puts=[],looked=[];
 const api={
  async competitorPrice(env,isbn){looked.push(isbn);clock.value+=60000;return competitor(isbn);},
  async call(env,p,{method='GET',body}={}){
   if(p.startsWith('/items/bulk?')){const ids=new URL('https://x'+p).searchParams.get('ids').split(',');return ids.map(id=>items.has(id)?{status_code:200,body:items.get(id)}:{status_code:404,body:null});}
   const m=p.match(/^\/items\/(MLU\d+)$/);assert.ok(m&&method==='PUT');puts.push({id:m[1],body});Object.assign(items.get(m[1]),body);return items.get(m[1]);
  }};
 const broker=async()=>({access_token:'tok',expires_at:clock.value+86400000});
 const readWorkbook=async()=>({source_date,source_sha256:sha,rows:ISBNS.map((isbn,i)=>({isbn,title:'x',...book,stock:i===5?'0':'3'}))});
 const run=extra=>syncStock({connection,excel:path.join(temp,'stock.xlsx'),directory:temp,apiFactory:()=>api,brokerFactory:()=>broker,readWorkbook,now:()=>clock.value,mode:'correct',...extra});
 return {clock,items,puts,looked,run};
}

test('correct mode prices already published books against the winner, keeps full price against faster local sellers, and skips sold-out books',async t=>{
 const rivals={[ISBNS[0]]:{price:full-200,days:20},[ISBNS[1]]:{price:full-200,days:0},[ISBNS[2]]:{price:null,days:null},[ISBNS[3]]:{price:400,days:25},[ISBNS[4]]:{price:full+500,days:20}};
 const f=await fixture(t,{competitor:isbn=>({...rivals[isbn],at:1})});
 const s=await f.run({budgetMs:3600000});
 assert.equal(s.state,'corrected');assert.equal(s.checked,5);assert.equal(s.remaining,0);
 // el agotado (ISBNS[5]) ni se mira
 assert.equal(f.looked.includes(ISBNS[5]),false);
 // sólo cambia el que tiene un rival más barato con entrega lenta
 assert.deepEqual(f.puts,[{id:'MLU800',body:{price:Math.floor((full-200)*.99/10)*10}}]);
 assert.equal(s.repriced,1);assert.equal(s.price_unchanged,4);
});
test('correct mode stops at its time budget and starts next time with the books it has not looked at',async t=>{
 const f=await fixture(t,{competitor:()=>({price:full-200,days:20,at:1})});
 let s=await f.run({budgetMs:150000});
 assert.ok(s.checked>=1&&s.checked<5);assert.equal(s.remaining,5-s.checked);
 const first=[...f.looked];f.looked.length=0;
 s=await f.run({budgetMs:3600000});
 // la segunda pasada empieza por los que no se miraron
 assert.equal(first.includes(f.looked[0]),false);
});
test('correct mode backs off on 429 without touching prices',async t=>{
 const f=await fixture(t,{competitor:()=>{throw Object.assign(new Error('rate'),{status:429});}});
 const s=await f.run({budgetMs:3600000});
 assert.equal(s.state,'backoff');assert.equal(f.puts.length,0);
});
test('with the competitive policy the daily reprice leaves alone books whose winner has not been looked at',async t=>{
 const f=await fixture(t,{competitor:()=>({price:full-200,days:20,at:1})});
 for(const item of f.items.values())item.price=full+300;
 const s=await f.run({mode:'pause_and_reactivate'});
 // el agotado se pausa como siempre; ningún precio se toca
 assert.equal(s.repriced,0);assert.deepEqual(f.puts,[{id:'MLU805',body:{status:'paused'}}]);
});
test('the winner price is saved apart from the read-only supplier snapshot, once per feed and ISBN, and comes back with the row',async t=>{
 const {openDatabase}=await import('../../scripts/vintage-local/db.mjs');
 const {VintageBulkStore}=await import('../_shared/meli-vintage-bulk.js');
 const {PublicationStore}=await import('../../worker-sync/publication-store.js');
 const {createSbsStock}=await import('../../worker-sync/sbs-supplier-stock.js');
 const db=openDatabase(':memory:');t.after(()=>db.close());
 const env={ORDERS_DB:db},s=new VintageBulkStore(db,{sellerId:SELLER});await new PublicationStore(db).initialize();await s.initialize();
 const feed=crypto.randomUUID(),supplier=createSbsStock({now:()=>Date.now()}),isbn='9789502323060';
 await supplier(env,'begin',{feed_id:feed,source_date:new Date().toISOString(),source_sha256:'e'.repeat(64),expected_rows:1});
 await supplier(env,'import',{feed_id:feed,rows:[{isbn,title:'Test',listArs:40000,weightKg:.5,stock:'2'}]});await supplier(env,'commit',{feed_id:feed});
 assert.equal((await s.stock(feed,isbn)).competitor,undefined);
 assert.equal(await s.setCompetitor(feed,isbn,{price:2000,at:1,days:20}),true);
 assert.equal(await s.setCompetitor(feed,isbn,{price:100,at:2,days:20}),false);
 assert.deepEqual((await s.stock(feed,isbn)).competitor,{price:2000,at:1,days:20});
});
