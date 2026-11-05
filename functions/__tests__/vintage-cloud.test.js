import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {cloudRun,cloudSettings,batchSize,markdown,HARD_MAX_PER_RUN} from '../../scripts/vintage-cloud/run.mjs';
import {campaignNumbers} from '../../scripts/vintage-cloud/numbers.mjs';
import {saveStockState,loadStockState,CLOUD_STOCK_TABLE} from '../../scripts/vintage-cloud/d1.mjs';
import {BULK_RUN} from '../_shared/meli-vintage-bulk.js';
import {policyHash} from '../../worker-sync/publication-policy.js';

const policy={supplierDiscount:.25,arsPerUyu:40,usdPerUyu:42,freightUsdKg:15,laborUyu:0,margin:.23,mlFee:.17,deliveryUyu:270,minimumContributionUyu:200,minimumSaleUyu:1600,roundUyu:10,availabilityDays:18,additionalPricePct:0,listingTypeId:'gold_special',catalogListing:'required_only'};
const campaign=(ejecutor,modo,extra={})=>({target_total:80000,ejecutor,nube:{modo,tanda:50,tope_diario:300,...extra}});

test('only "ejecutor": "nube" plus "modo": "real" lets the cloud publish, and overrides are capped',()=>{
 assert.equal(cloudSettings(campaign('pc','real')).real,false);
 assert.equal(cloudSettings(campaign('nube','prueba')).real,false);
 assert.equal(cloudSettings(campaign('nube','real')).real,true);
 assert.equal(cloudSettings({}).modo,'prueba');
 const s=cloudSettings(campaign('nube','real'),{tanda:'99999',tope:''});
 assert.equal(s.tanda,HARD_MAX_PER_RUN);assert.equal(s.tope_diario,300);
 assert.equal(batchSize({tanda:50,tope_diario:300},280),20);
 assert.equal(batchSize({tanda:50,tope_diario:300},300),0);
 assert.equal(batchSize({tanda:50,tope_diario:300},0),50);
});

test('the numbers compare the list with the receipts without calling Mercado Libre',()=>{
 const rows=[{isbn:'1',listArs:40000,weightKg:.5,stock:'3'},{isbn:'2',listArs:40000,weightKg:.5,stock:'0'},{isbn:'3',listArs:80000,weightKg:.5,stock:'2'},{isbn:'4',listArs:40000,weightKg:.5,stock:'1'}];
 const n=campaignNumbers(rows,[{isbn:'1',state:'published'},{isbn:'2',state:'published'},{isbn:'4',state:'uncertain'}],policy);
 assert.equal(n.con_stock,3);assert.equal(n.publicados,2);assert.equal(n.sin_confirmar,1);
 assert.equal(n.publicados_sin_stock_hoy,1);assert.equal(n.candidatos_nuevos,1);
 assert.ok(n.precio_lista_completo.minimo>=1600);
});

async function harness(t,{campaignValue,daily=[10,12]}={}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'vintage-cloud-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const calls=[],connection={version:1,endpoint:'https://www.amadolibros.com/operations/vintage-local',key:'b'.repeat(64),expires_at:Date.now()+86400000,seller_id:'2341378249',app_id:'4741021817925208',run_id:BULK_RUN,policy,policy_hash:await policyHash(policy),receipts:[{isbn:'1',state:'published'}]};
 const statuses=[...daily];
 const deps={
  renewClient:()=>async action=>{calls.push('post:'+action);return action==='keepalive'?{refreshed:false,expires_at:Date.now()+5*3600000}:{};},
  renew:async({connection:file})=>{calls.push('renew');await fs.writeFile(file,JSON.stringify(connection));return {state:'renewed',source_date:'2026-11-05T03:00:00Z',rows:2};},
  inspect:async()=>({rows:[{isbn:'1',listArs:40000,weightKg:.5,stock:'3'},{isbn:'9',listArs:40000,weightKg:.5,stock:'3'}]}),
  sync:async({mode})=>{calls.push('sync:'+mode);return {mode,published:1};},
  engine:async opts=>{calls.push({engine:opts.validateOnly?'validate':'publish',limitNew:opts.limitNew,raise:opts.raiseTargetTo});return {state:'ready',published_total:1};},
  broker:()=>async()=>({daily_created:statuses.shift()??0}),
 };
 const env={VINTAGE_RENEW_SECRET:'r'.repeat(40),SBS_EMAIL:'a@b.c',SBS_PASSWORD:'clave'};
 const go=action=>cloudRun({action,directory:dir,campaign:campaignValue??campaign('pc','prueba'),env,query:async()=>[],deps});
 return {dir,calls,go};
}

test('prueba never publishes: stock in report mode and five validations only, then the connection is revoked and deleted',async t=>{
 const h=await harness(t);
 const r=await h.go('prueba');
 assert.equal(r.estado,'prueba_lista');
 assert.deepEqual(h.calls,['post:keepalive','renew','sync:report',{engine:'validate',limitNew:undefined,raise:undefined},'post:revoke']);
 await assert.rejects(()=>fs.access(path.join(h.dir,'connection.json')));
 assert.equal(r.numeros.candidatos_nuevos,1);
 assert.ok(!JSON.stringify(r).includes('b'.repeat(64)),'the connection key never reaches the report');
 assert.match(markdown(r),/Candidatos a publicar/);
});

test('publicar is refused without both keys, and with them it publishes a capped batch with stock_only',async t=>{
 const blocked=await harness(t);
 await assert.rejects(()=>blocked.go('publicar'),/publicar_no_habilitado/);
 assert.deepEqual(blocked.calls,[]);
 const h=await harness(t,{campaignValue:campaign('nube','real'),daily:[280,295]});
 const r=await h.go('publicar');
 assert.deepEqual(h.calls,['post:keepalive','renew','sync:stock_only',{engine:'publish',limitNew:20,raise:80000},'post:revoke']);
 assert.equal(r.publicacion.altas_de_esta_corrida,15);
 const full=await harness(t,{campaignValue:campaign('nube','real'),daily:[300]});
 assert.equal((await full.go('publicar')).estado,'tope_diario_alcanzado');
 assert.ok(!full.calls.some(c=>c.engine));
});

test('apagado still keeps the token alive and does nothing else',async t=>{
 const h=await harness(t,{campaignValue:campaign('nube','apagado')});
 assert.equal((await h.go('prueba')).estado,'apagado');
 assert.deepEqual(h.calls,['post:keepalive']);
});

test('the pause state goes to D1 in chunks under the 100-parameter limit',async()=>{
 const sent=[];const query=async(sql,params=[])=>{sent.push({sql,params});return sql.startsWith('SELECT')?[{isbn:'1',item_id:'MLU1'}]:[];};
 const rows=Array.from({length:15},(_,i)=>({isbn:String(i),item_id:'MLU'+i,desired_status:'paused',applied_status:'paused',missing_since:1,updated_at:2}));
 assert.equal(await saveStockState(query,rows),15);
 assert.equal(sent.length,3);assert.ok(sent.every(s=>s.params.length<=100));
 assert.ok(sent[0].sql.includes(CLOUD_STOCK_TABLE));
 sent.length=0;assert.deepEqual(await loadStockState(query),[{isbn:'1',item_id:'MLU1'}]);assert.match(sent[0].sql,/CREATE TABLE IF NOT EXISTS/);
});

test('a fresh engine database seeds receipts whose book left today\'s list (cloud runs start empty)',async t=>{
 const {run}=await import('../../scripts/vintage-local/engine.mjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'vintage-fresh-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const now=Date.now(),source_date=new Date(now-3600000).toISOString(),sha='c'.repeat(64);
 const isbn=n=>{const stem='978'+String(n).padStart(9,'0');const sum=[...stem].reduce((t,c,i)=>t+Number(c)*(i%2?3:1),0);return stem+((10-sum%10)%10);};
 const rows=[{isbn:isbn(1),title:'Hoy',listArs:40000,weightKg:.5,stock:'2'}];
 const receipts=[{seller_id:'2341378249',isbn:isbn(1),state:'published',item_id:'MLU1',run_id:BULK_RUN,created_at:1,updated_at:1},{seller_id:'2341378249',isbn:isbn(2),state:'published',item_id:'MLU2',run_id:BULK_RUN,created_at:1,updated_at:1},{seller_id:'2341378249',isbn:isbn(3),state:'uncertain',item_id:null,run_id:BULK_RUN,created_at:1,updated_at:1}];
 const c={version:1,endpoint:'https://www.amadolibros.com/operations/vintage-local',key:'b'.repeat(64),expires_at:now+86400000,seller_id:'2341378249',app_id:'4741021817925208',run_id:BULK_RUN,policy,policy_hash:await policyHash(policy),feed_id:crypto.randomUUID(),source_date,source_sha256:sha,receipts,inventory:[],identifiers:[],amendments:[],inventory_checkpoint:{status:'all',scroll:null,pending:[],done:true,seen:0}};
 const connection=path.join(dir,'connection.json');await fs.writeFile(connection,JSON.stringify(c));
 const stop=Object.assign(new Error('stop_here'),{code:'stop_here'});
 await assert.rejects(()=>run({excel:'x',connection,directory:dir,validateOnly:5,readWorkbook:async()=>({source_date,source_sha256:sha,rows}),apiFactory:()=>({async account(){throw stop;}}),brokerFactory:()=>async()=>({})}),/stop_here/);
});

test('an authorization cut during the test is retried and resumes from the saved database',async t=>{
 const h=await harness(t);
 const states=['auth_error','ready'];
 const r=await cloudRun({action:'prueba',directory:h.dir,campaign:campaign('pc','prueba'),env:{VINTAGE_RENEW_SECRET:'r'.repeat(40),SBS_EMAIL:'a@b.c',SBS_PASSWORD:'x'},query:async()=>[],deps:{
  renewClient:()=>async a=>a==='keepalive'?{refreshed:false,expires_at:Date.now()+5*3600000}:{},
  renew:async({connection:file})=>{await fs.writeFile(file,JSON.stringify({version:1,endpoint:'https://www.amadolibros.com/operations/vintage-local',key:'b'.repeat(64),expires_at:Date.now()+86400000,seller_id:'2341378249',app_id:'4741021817925208',run_id:BULK_RUN,policy,receipts:[]}));return {state:'renewed'};},
  inspect:async()=>({rows:[]}),sync:async()=>({}),
  engine:async()=>({state:states.shift()}),
 }});
 assert.equal(r.prueba.estado,'ready');assert.equal(r.reintentos_autorizacion,1);
});
