import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sqliteD1} from './helpers/sqlite-d1.js';
import {PublicationStore} from '../publication-store.js';
import {createPublicationService} from '../publication-engine.js';
import {competitiveDecision,estimatedBaseFromPrice,priceFromBase,policyHash,validPolicy} from '../publication-policy.js';
import {saleTermDays,createPublicationMeli} from '../publication-meli.js';
import {PublicationError} from '../publication-policy.js';

const base={supplierDiscount:.25,arsPerUyu:40,usdPerUyu:40,freightUsdKg:16,laborUyu:0,margin:.30,mlFee:.15,deliveryUyu:250,minimumContributionUyu:400,minimumSaleUyu:100,roundUyu:10,availabilityDays:21,additionalPricePct:0,listingTypeId:'gold_special'};
const comp={...base,competitive:true,competitiveFloorMargin:.15};

test('el costo estimado de una publicación activa nunca queda por debajo del real',()=>{
 // Cuando manda el margen, la vuelta es exacta salvo redondeo.
 for(const b of [1200,2600,5000]){
  const price=priceFromBase(b,base,base.margin);
  const back=estimatedBaseFromPrice(price,base);
  assert.ok(Math.abs(back-b)<=base.roundUyu,`base ${b} -> ${price} -> ${back}`);
 }
 // Cuando manda la contribución mínima, el precio publicado es más alto que el que
 // pediría el margen, así que el costo estimado sale por encima del real: el piso
 // queda más alto y la regla se vuelve más conservadora, nunca más agresiva.
 for(const b of [100,300,500]){
  const price=priceFromBase(b,base,base.margin);
  const back=estimatedBaseFromPrice(price,base);
  assert.ok(back>=b,`base ${b} -> ${price} -> ${back}`);
 }
 // Sobre el piso: estimar de más sube el piso, nunca lo baja.
 const real=priceFromBase(500,base,comp.competitiveFloorMargin);
 const estimado=priceFromBase(estimatedBaseFromPrice(priceFromBase(500,base,base.margin),base),base,comp.competitiveFloorMargin);
 assert.ok(estimado>=real);
 assert.equal(estimatedBaseFromPrice(100,base),null);   // precio imposible para ese costo
 assert.equal(estimatedBaseFromPrice(0,base),null);
 assert.equal(estimatedBaseFromPrice('1600',base),null);
});
test('la decisión sobre una publicación activa respeta piso, plazo y "ya soy más barato"',()=>{
 const price=3270;
 const piso=competitiveDecision({price,rivalPrice:null,rivalDays:null},comp).floor;
 assert.ok(piso<price&&piso>0);
 assert.equal(competitiveDecision({price,rivalPrice:null,rivalDays:null},comp).mode,'no_competitor');
 assert.equal(competitiveDecision({price,rivalPrice:3000,rivalDays:null},comp).mode,'rival_delivery_unknown');
 assert.equal(competitiveDecision({price,rivalPrice:3000,rivalDays:5},comp).mode,'rival_faster_delivery');
 assert.equal(competitiveDecision({price,rivalPrice:9000,rivalDays:21},comp).mode,'already_cheaper');
 const low=competitiveDecision({price,rivalPrice:piso,rivalDays:21},comp);
 assert.equal(low.mode,'below_floor');assert.equal(low.newPrice,price);
 const ok=competitiveDecision({price,rivalPrice:3200,rivalDays:21},comp);
 assert.equal(ok.mode,'lower');assert.equal(ok.newPrice,3160);assert.ok(ok.newPrice>=ok.floor);
 // Nuestro propio plazo manda sobre el de la política cuando el item lo declara.
 assert.equal(competitiveDecision({price,rivalPrice:3200,rivalDays:10,ownDays:10},comp).mode,'lower');
 assert.equal(competitiveDecision({price,rivalPrice:3200,rivalDays:10,ownDays:21},comp).mode,'rival_faster_delivery');
 // Nunca decide con una política que no sea competitiva.
 assert.throws(()=>competitiveDecision({price,rivalPrice:3200,rivalDays:21},base),/invalid_policy/);
});
test('saleTermDays lee los plazos como los informa Mercado Libre',()=>{
 assert.equal(saleTermDays([]),0);
 assert.equal(saleTermDays(null),null);
 assert.equal(saleTermDays([{id:'WARRANTY_TYPE'}]),0);
 assert.equal(saleTermDays([{id:'MANUFACTURING_TIME',value_struct:{number:21,unit:'días'}}]),21);
 assert.equal(saleTermDays([{id:'MANUFACTURING_TIME',values:[{struct:{number:3,unit:'semanas'}}]}]),21);
 assert.equal(saleTermDays([{id:'MANUFACTURING_TIME',value_struct:{number:48,unit:'horas'}}]),2);
 assert.equal(saleTermDays([{id:'MANUFACTURING_TIME',value_name:'18 días'}]),18);
 assert.equal(saleTermDays([{id:'MANUFACTURING_TIME',value_name:'inmediata'}]),null);
});

function fetcherFor(map){return async url=>{const path=String(url).replace('https://api.mercadolibre.com','');const hit=Object.entries(map).find(([k])=>path.split('?')[0]===k);if(!hit)return new Response(JSON.stringify({error:'not_found'}),{status:404});return new Response(JSON.stringify(hit[1]),{status:200,headers:{'content-type':'application/json'}});};}
const term=d=>[{id:'MANUFACTURING_TIME',value_struct:{number:d,unit:'días'}}];

test('itemCompetitorPreview sólo lee, exige que la publicación sea nuestra y reporta por qué no hay competidor',async()=>{
 const mk=map=>createPublicationMeli({fetcher:fetcherFor(map),tokenProvider:async()=>'tok',now:()=>1});
 const ours={id:'MLU1',seller_id:440298103,price:3270,currency_id:'UYU',status:'active',title:'Libro',catalog_listing:true,catalog_product_id:'MLU900',sale_terms:term(21)};
 const r=await mk({'/items/MLU1':ours,'/products/MLU900':{buy_box_winner:{price:3000,seller_id:777,currency_id:'UYU',item_id:'MLU55'}},'/items/MLU55':{sale_terms:term(25)}}).itemCompetitorPreview({},'MLU1');
 assert.equal(r.price,3270);assert.equal(r.own_days,21);assert.deepEqual({p:r.competitor.price,d:r.competitor.days},{p:3000,d:25});
 // Publicación fuera de catálogo: no hay ficha que disputar.
 const solo=await mk({'/items/MLU1':{...ours,catalog_listing:false,catalog_product_id:undefined}}).itemCompetitorPreview({},'MLU1');
 assert.equal(solo.competitor,null);assert.equal(solo.reason,'not_in_catalog');
 // Ficha que no se puede leer: queda el motivo, no rompe.
 const broken=await mk({'/items/MLU1':ours}).itemCompetitorPreview({},'MLU1');
 assert.equal(broken.competitor,null);assert.ok(broken.reason);
 // Ganamos nosotros la ficha: no hay rival a vencer.
 const won=await mk({'/items/MLU1':ours,'/products/MLU900':{buy_box_winner:{price:3000,seller_id:440298103}}}).itemCompetitorPreview({},'MLU1');
 assert.equal(won.competitor.price,null);
 await assert.rejects(()=>mk({'/items/MLU1':{...ours,seller_id:999}}).itemCompetitorPreview({},'MLU1'),/item_seller_mismatch/);
 await assert.rejects(()=>mk({}).itemCompetitorPreview({},'nope'),/invalid_item_id/);
});

test('preview_competitor devuelve la decisión por publicación y no escribe nada',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'amado-preview-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const db=sqliteD1(join(dir,'q.sqlite')),store=new PublicationStore(db),now=Date.now();
 await store.initialize();
 const runId=crypto.randomUUID(),feedId=crypto.randomUUID();
 await store.beginFeed(feedId,new Date(now).toISOString(),1,now);
 await store.importRows(feedId,[{isbn:'9789502323060',title:'x',listArs:28000,weightKg:.3,stock:'1'}]);
 await store.commitFeed(feedId);
 await store.createRun({id:runId,feedId,policy:base,policyHash:await policyHash(base),now,dailyCap:10,preflightLimit:10});
 const before=JSON.stringify(await store.run(runId));
 const reads=[];
 const api={async itemCompetitorPreview(env,id){reads.push(id);
  if(id==='MLU3')throw new PublicationError('item_seller_mismatch',403);
  const price=id==='MLU1'?3270:1600;
  return {item_id:id,title:'Libro '+id,price,status:'active',catalog_listing:true,catalog_product_id:'MLU9',own_days:21,
   competitor:{price:id==='MLU1'?3200:1000,days:21,at:now}};}};
 const service=createPublicationService({api,storeFactory:()=>store,now:()=>now});
 const env={ORDERS_DB:db,USER_ID:'440298103',APP_ID:'4741021817925208'};
 const out=await service.command(env,'preview_competitor',
  {item_ids:['MLU1','MLU2','MLU3'],run_id:runId,competitive_floor_margin:.15,minimum_contribution_uyu:400,availability_days:21});
 assert.deepEqual(reads,['MLU1','MLU2','MLU3']);
 assert.equal(out.writes,false);assert.equal(out.cost_is_estimated,true);
 assert.equal(out.competitive_floor_margin,.15);assert.equal(out.minimum_contribution_uyu,400);assert.equal(out.availability_days,21);
 const byId=Object.fromEntries(out.items.map(r=>[r.item_id,r]));
 assert.equal(byId.MLU1.decision,'lower');assert.equal(byId.MLU1.new_price,3160);assert.equal(byId.MLU1.drop,110);
 assert.equal(byId.MLU2.decision,'below_floor');assert.equal(byId.MLU2.new_price,1600);
 assert.equal(byId.MLU3.error,'item_seller_mismatch');
 assert.equal(JSON.stringify(await store.run(runId)),before,'el lote de origen no se toca');
 await assert.rejects(()=>service.command(env,'preview_competitor',{item_ids:[]}),/invalid_item_ids/);
 await assert.rejects(()=>service.command(env,'preview_competitor',{item_ids:['x']}),/invalid_item_ids/);
 await assert.rejects(()=>service.command(env,'preview_competitor',{item_ids:Array(26).fill('MLU1')}),/invalid_item_ids/);
});
