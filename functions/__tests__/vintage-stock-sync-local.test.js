import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {syncStock} from '../../scripts/vintage-local/stock-sync.mjs';
import {BULK_RUN} from '../_shared/meli-vintage-bulk.js';
import {policyHash} from '../../worker-sync/publication-policy.js';
import {openDatabase} from '../../scripts/vintage-local/db.mjs';

const SELLER='2341378249';
const policy={supplierDiscount:.25,arsPerUyu:40,usdPerUyu:42,freightUsdKg:15,laborUyu:0,margin:.23,mlFee:.17,deliveryUyu:270,minimumContributionUyu:200,minimumSaleUyu:1600,roundUyu:10,availabilityDays:18,additionalPricePct:0,listingTypeId:'gold_special',catalogListing:'required_only'};
function isbn13(n){const stem='978'+String(n).padStart(9,'0');const sum=[...stem].reduce((t,c,i)=>t+Number(c)*(i%2?3:1),0);return stem+((10-sum%10)%10);}
const ISBNS=Array.from({length:10},(_,i)=>isbn13(500+i));

async function fixture(t){
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'vintage-stock-'));t.after(()=>fs.rm(temp,{recursive:true,force:true}));
 const clock={value:Date.parse('2026-10-21T12:00:00Z')},sha='a'.repeat(64),source_date=new Date(clock.value-3600000).toISOString();
 const receipts=ISBNS.map((isbn,i)=>({seller_id:SELLER,isbn,state:'published',item_id:'MLU'+(900+i),run_id:BULK_RUN,created_at:1,updated_at:1}));
 const c={version:1,endpoint:'https://www.amadolibros.com/operations/vintage-local',key:'b'.repeat(64),expires_at:clock.value+86400000,seller_id:SELLER,app_id:'4741021817925208',run_id:BULK_RUN,policy,policy_hash:await policyHash(policy),feed_id:'feed-1',source_date,source_sha256:sha,receipts};
 const connection=path.join(temp,'connection.json');await fs.writeFile(connection,JSON.stringify(c));
 // Mercado Libre falso: estado por ítem y registro de cada PUT
 const items=new Map(receipts.map(r=>[r.item_id,{id:r.item_id,seller_id:SELLER,status:'active',available_quantity:1,seller_custom_field:'AMADO-AR-'+r.isbn}]));
 const puts=[],tokens=[];
 const api={async call(env,p,{method='GET',body}={}){
  if(p.startsWith('/items/bulk?')){const ids=new URL('https://x'+p).searchParams.get('ids').split(',');return ids.map(id=>items.has(id)?{status_code:200,body:items.get(id)}:{status_code:404,body:null});}
  const m=p.match(/^\/items\/(MLU\d+)$/);assert.ok(m&&method==='PUT');puts.push({id:m[1],body});Object.assign(items.get(m[1]),body);return items.get(m[1]);
 }};
 const broker=async action=>{tokens.push(action);return {access_token:'tok',expires_at:clock.value+300000};};
 const workbook=stocked=>async()=>({source_date,source_sha256:sha,rows:ISBNS.map(isbn=>({isbn,title:'x',listArs:40000,weightKg:.5,stock:stocked.has(isbn)?'3':'0'}))});
 const run=(stocked,extra={})=>syncStock({connection,excel:path.join(temp,'stock.xlsx'),directory:temp,apiFactory:()=>api,brokerFactory:()=>broker,readWorkbook:workbook(stocked),now:()=>clock.value,...extra});
 return {temp,clock,items,puts,run,c};
}

test('a book missing from the fresh supplier list is paused, and reactivated only when it returns and the pause was ours',async t=>{
 const f=await fixture(t);
 const all=new Set(ISBNS);
 // MLU905 fue pausado a mano antes de que la sincronización lo viera: queda como está
 f.items.get('MLU905').status='paused';
 let s=await f.run(all);assert.equal(s.state,'synced');assert.equal(s.paused,0);assert.equal(s.unchanged,9);assert.equal(s.skipped,1);assert.equal(f.puts.length,0);
 // dos títulos se agotan
 const gone=new Set(ISBNS.slice(2));
 s=await f.run(gone);assert.equal(s.missing,2);assert.equal(s.paused,2);
 assert.deepEqual(f.puts.map(p=>p.id).sort(),['MLU900','MLU901']);assert.deepEqual(f.puts[0].body,{status:'paused'});
 assert.equal(f.items.get('MLU900').status,'paused');assert.equal(f.items.get('MLU902').status,'active');
 // uno vuelve: se reactiva con cantidad 1; el otro sigue pausado
 f.puts.length=0;s=await f.run(new Set([...gone,ISBNS[0]]));
 assert.equal(s.activated,1);assert.deepEqual(f.puts,[{id:'MLU900',body:{status:'active',available_quantity:1}}]);assert.equal(f.items.get('MLU901').status,'paused');
 // todo vuelve: se reactiva la pausa nuestra; la pausa manual sigue manual
 f.puts.length=0;s=await f.run(all);
 assert.equal(s.activated,1);assert.deepEqual(f.puts.map(p=>p.id),['MLU901']);assert.equal(f.items.get('MLU905').status,'paused');
 const saved=JSON.parse(await fs.readFile(path.join(f.temp,'stock-sync.json'),'utf8'));assert.equal(saved.state,'synced');
});
test('prices follow the approved policy with today\'s list price, up or down, with a minimum and a jump guard',async t=>{
 const {quoteMercadoLibre}=await import('../../worker-sync/publication-policy.js');
 const f=await fixture(t),all=new Set(ISBNS);
 const list=Object.fromEntries(ISBNS.map((isbn,i)=>[isbn,40000]));
 const workbook=async()=>({source_date:f.c.source_date,source_sha256:f.c.source_sha256,rows:ISBNS.map(isbn=>({isbn,title:'x',listArs:list[isbn],weightKg:.5,stock:'3'}))});
 const want=ars=>quoteMercadoLibre({listArs:ars,weightKg:.5},policy).price;
 for(const item of f.items.values()){item.price=want(40000);item.currency_id='UYU';}
 // ya alineados: se leen una vez y no se escribe nada
 let s=await f.run(all,{readWorkbook:workbook});assert.equal(s.repriced,0);assert.equal(s.price_unchanged,10);assert.equal(f.puts.length,0);
 // segunda pasada sin cambios: ni siquiera se vuelve a leer
 s=await f.run(all,{readWorkbook:workbook});assert.equal(s.price_unchanged,0);assert.equal(s.repriced,0);
 // SBS sube un libro y baja otro; un tercero salta x3 (dato sospechoso) y no se toca
 list[ISBNS[0]]=52000;list[ISBNS[1]]=30000;list[ISBNS[2]]=200000;
 s=await f.run(all,{readWorkbook:workbook});
 assert.equal(s.repriced,2);assert.equal(s.price_skipped,1);
 assert.deepEqual(f.puts,[{id:'MLU900',body:{price:want(52000)}},{id:'MLU901',body:{price:want(30000)}}]);
 assert.ok(want(52000)>want(40000)&&want(30000)<want(40000));assert.equal(f.items.get('MLU902').price,want(40000));
 // nunca por debajo del mínimo de Vintage
 list[ISBNS[3]]=25000;f.puts.length=0;s=await f.run(all,{readWorkbook:workbook});
 assert.ok(f.puts.every(p=>p.body.price>=1600));
 // pause_only y report no tocan precios
 list[ISBNS[4]]=50000;f.puts.length=0;
 await f.run(all,{readWorkbook:workbook,mode:'pause_only'});await f.run(all,{readWorkbook:workbook,mode:'report'});assert.equal(f.puts.length,0);
});
test('a suspiciously incomplete list, report mode, pause_only, grace and identity mismatches never pause the wrong thing',async t=>{
 const f=await fixture(t);
 // 6 de 10 faltan (>30%): lista sospechosa, nada se pausa
 let s=await f.run(new Set(ISBNS.slice(0,4)));assert.equal(s.suspicious_feed,true);assert.equal(s.paused,0);assert.equal(f.puts.length,0);
 // modo report: calcula pero no escribe
 s=await f.run(new Set(ISBNS.slice(1)),{mode:'report',graceHours:20});assert.equal(s.state,'report');assert.equal(s.missing,1);assert.equal(f.puts.length,0);
 // período de gracia: la primera ausencia sólo se anota; a las 20 h de la primera lista se pausa
 s=await f.run(new Set(ISBNS.slice(1)),{graceHours:20});assert.equal(s.paused,0);assert.equal(f.puts.length,0);
 f.clock.value+=21*3600000;const later=new Date(f.clock.value-3600000).toISOString();
 const workbookLater=async()=>({source_date:later,source_sha256:f.c.source_sha256,rows:ISBNS.slice(1).map(isbn=>({isbn,title:'x',listArs:1,weightKg:.5,stock:'1'}))});
 s=await syncStock({connection:path.join(f.temp,'connection.json'),excel:'x',directory:f.temp,apiFactory:()=>({call:(e,p,o)=>f.run.api?null:null}),brokerFactory:()=>async()=>({access_token:'t',expires_at:f.clock.value+1e6}),readWorkbook:workbookLater,now:()=>f.clock.value,graceHours:20,mode:'report'});
 assert.equal(s.state,'report');
 // pause_only nunca reactiva; un ítem de otro vendedor nunca se toca
 f.items.get('MLU903').seller_id='440298103';
 s=await f.run(new Set(ISBNS.filter(x=>x!==ISBNS[3])),{mode:'pause_only',graceHours:0});
 assert.equal(s.skipped,1);assert.equal(s.paused,0);assert.equal(f.items.get('MLU903').status,'active');
 const db=openDatabase(path.join(f.temp,'publisher.sqlite'));
 assert.equal((await db.prepare('SELECT last_error FROM vintage_stock_sync WHERE isbn=?').bind(ISBNS[3]).first()).last_error,'item_identity_mismatch');db.close();
 // un Excel que no es el aprobado en la conexión se rechaza antes de leer Mercado Libre
 await assert.rejects(()=>f.run(new Set(ISBNS),{readWorkbook:async()=>({source_date:f.c.source_date,source_sha256:'f'.repeat(64),rows:[]})}),/workbook_does_not_match_current_approved_stock/);
 await assert.rejects(()=>f.run(new Set(ISBNS),{mode:'close_all'}),/invalid_stock_sync_mode/);
});
