import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOrdersHandler } from '../_orders_handler.js';
import { consolidateItems, dateInTimeZone, generateFingerprint, validateBody } from '../_orders_logic.js';

const NOW = new Date('2026-07-19T16:00:00.000Z');
const CATALOG = { items: [
  { id:'A', title:'Alpha', price:1000, available_quantity:5, status:'active', thumbnail:null },
  { id:'B', title:'Beta', price:1250, available_quantity:3, status:'active', thumbnail:null },
  { id:'G', title:'Gamma', price:800, available_quantity:5, status:'active', thumbnail:null },
  { id:'P', title:'Pausado', price:300, available_quantity:10, status:'paused', thumbnail:null },
  { id:'X', title:'Precio roto', price:'NaN', available_quantity:2, status:'active', thumbnail:null },
] };

function dbMock({ existing=null, batchError=null, race=null, lookupError=null }={}) {
  let lookups=0; const committed=[]; const updates=[];
  return {
    committed, updates, lookups:()=>lookups,
    prepare(sql){ return { bind(...args){ const stmt={sql,args}; return {
      async first(){
        if (sql.includes('idempotency_key')) { lookups++; if(lookupError) throw lookupError; return existing || (lookups>1 ? race : null); }
        if (sql.includes('public_code')) return null;
        return null;
      },
      async run(){ updates.push(stmt); return {success:true}; },
      stmt,
    }; } }; },
    async batch(stmts){ if(batchError) throw batchError; committed.push(...stmts); return stmts.map(()=>({success:true})); },
  };
}

function ctx(body, db, opts={}) {
  const method=opts.method||'POST'; const headers={'Content-Type':opts.type||'application/json'};
  if(opts.length!==undefined) headers['Content-Length']=String(opts.length);
  return { request:new Request('https://x/api/orders',{method,headers,body:method==='POST'?(typeof body==='string'?body:JSON.stringify(body)):undefined}), env:db?{ORDERS_DB:db}:{}, waitUntil(){} };
}
function pickup(key='k'){ return { idempotency_key:key, items:[{product_id:'A',quantity:2},{product_id:'B',quantity:1}], delivery_type:'pickup', buyer:{name:'Ana',phone:'099'} }; }
function shipping(key='s', patch={}) { const base={ idempotency_key:key, items:[{product_id:'G',quantity:1},{product_id:'A',quantity:1}], delivery_type:'shipping', buyer:{name:'Carlos',phone:'098'}, shipping:{address:'Calle 1',locality:'Centro',department:'Montevideo',requested_date:'2026-07-20',requested_from:'09:00',requested_to:'12:00',notes:'2B'} }; return {...base,...patch,shipping:{...base.shipping,...(patch.shipping||{})}}; }
function stored(body, patch={}) { return { id:'uuid', idempotency_key:body.idempotency_key, request_fingerprint:generateFingerprint(body,consolidateItems(body.items)), public_code:'AL-TEST', status:'open', payment_status:'not_started', delivery_type:body.delivery_type, products_total_uyu:3250, pickup_discount_uyu:150, shipping_cost_uyu:0, payable_total_uyu:3100, currency:'UYU', expires_at:'2026-07-19T17:00:00.000Z', ...patch }; }
function handler(fetchCatalog=async()=>CATALOG, now=NOW){ return createOrdersHandler({fetchCatalog,getNow:()=>new Date(now)}); }

async function call(body, db=dbMock(), opts={}, h=handler()){ const response=await h(ctx(body,db,opts)); return {response,data:await response.json(),db}; }

test('reglas comerciales: retiro, envío pago y umbral inclusivo', async()=>{
  let r=await call(pickup()); assert.equal(r.data.order.payable_total_uyu,3100);
  r=await call(shipping()); assert.equal(r.data.order.payable_total_uyu,2050);
  r=await call(shipping('t',{items:[{product_id:'A',quantity:2}]})); assert.equal(r.data.order.shipping_cost_uyu,0); assert.equal(r.data.order.payable_total_uyu,2000);
});

test('expira exactamente en 60 minutos y no expone UUID', async()=>{
  const {response,data}=await call(pickup('exp')); assert.equal(response.status,201); assert.equal(data.order.expires_at,'2026-07-19T17:00:00.000Z'); assert.equal(Object.hasOwn(data.order,'id'),false);
});

test('idempotencia idéntica responde antes de R2', async()=>{
  const body=pickup('same'); let calls=0; const d=dbMock({existing:stored(body)});
  const r=await call(body,d,{},handler(async()=>{calls++; throw Error('R2');})); assert.equal(r.response.status,200); assert.equal(calls,0);
});

test('misma clave con pedido distinto devuelve 409', async()=>{
  const body=pickup('conflict'); const r=await call(body,dbMock({existing:stored(body,{request_fingerprint:'otro'})})); assert.equal(r.response.status,409);
});

test('orden vencida devuelve 410 y se marca expired', async()=>{
  const body=pickup('old'); const d=dbMock({existing:stored(body,{expires_at:'2026-07-19T15:00:00.000Z'})}); const r=await call(body,d); assert.equal(r.response.status,410); assert.equal(r.data.code,'ORDER_EXPIRED'); assert.equal(d.updates.length,1);
});

test('notas integran fingerprint', async()=>{
  const a=shipping('n'), b=shipping('n',{shipping:{notes:'otra'}}); assert.notEqual(generateFingerprint(a,consolidateItems(a.items)),generateFingerprint(b,consolidateItems(b.items)));
  const r=await call(b,dbMock({existing:stored(a)})); assert.equal(r.response.status,409);
});

test('precio del navegador se ignora y manda catálogo', async()=>{
  const body={idempotency_key:'price',items:[{product_id:'A',quantity:1,price:99999,title:'falso'}],delivery_type:'pickup',buyer:{name:'T',phone:'099'}}; const r=await call(body); assert.equal(r.data.order.products_total_uyu,1000); assert.equal(r.data.order.payable_total_uyu,850);
});

test('stock, producto, estado y precio inválidos devuelven 422', async()=>{
  for(const id of ['NOPE','P','X']) { const b=pickup(id); b.items=[{product_id:id,quantity:1}]; assert.equal((await call(b)).response.status,422); }
  const b=pickup('stock'); b.items=[{product_id:'A',quantity:6}]; assert.equal((await call(b)).response.status,422);
});

test('tipos JSON incorrectos devuelven 400 sin excepción', async()=>{
  const bodies=[{...pickup('null'),items:[null]},{...pickup('name'),buyer:{name:123,phone:'099'}},shipping('address',{shipping:{address:123}}),shipping('notes',{shipping:{notes:123}})];
  for(const b of bodies) assert.equal((await call(b)).response.status,400);
});

test('fecha de Uruguay no se adelanta por UTC', async()=>{
  const late=new Date('2026-07-20T01:30:00.000Z'); assert.equal(dateInTimeZone(late),'2026-07-19'); const b=shipping('uy',{shipping:{requested_date:'2026-07-19'}}); assert.equal((await call(b,dbMock(),{},handler(async()=>CATALOG,late))).response.status,201);
});

test('fecha y horas imposibles o desordenadas devuelven 400', async()=>{
  const cases=[shipping('d',{shipping:{requested_date:'2026-02-31'}}),shipping('h',{shipping:{requested_from:'28:75'}}),shipping('o',{shipping:{requested_from:'14:00',requested_to:'14:00'}})];
  for(const b of cases) assert.equal((await call(b)).response.status,400);
});

test('batch fallido devuelve 500 sin commit', async()=>{
  const d=dbMock({batchError:Error('D1')}); const r=await call(pickup('fail'),d); assert.equal(r.response.status,500); assert.equal(d.committed.length,0);
});

test('carrera idempotente recupera orden sin depender del texto del error', async()=>{
  const b=pickup('race'), race=stored(b), d=dbMock({batchError:Error('opaque'),race}); const r=await call(b,d); assert.equal(r.response.status,200); assert.equal(r.data.order.public_code,'AL-TEST'); assert.equal(d.lookups(),2);
});

test('servicio D1 ausente o lookup fallido devuelve 503', async()=>{
  assert.equal((await call(pickup('none'),null)).response.status,503); assert.equal((await call(pickup('lookup'),dbMock({lookupError:Error('D1')}))).response.status,503);
});

test('límites HTTP y método', async()=>{
  assert.equal((await call('{}',dbMock(),{length:33*1024})).response.status,413); assert.equal((await call('{}',dbMock(),{type:'text/plain'})).response.status,415); const r=await call(null,dbMock(),{method:'GET'}); assert.equal(r.response.status,405); assert.equal(r.response.headers.get('Allow'),'POST');
});

test('límites de contrato y consolidación', ()=>{
  assert.equal(validateBody([]),'Body inválido.'); const b=pickup('x'.repeat(129)); assert.match(validateBody(b),/demasiado largo/); b.idempotency_key='q'; b.items=[{product_id:'A',quantity:100}]; assert.equal(validateBody(b),'Cantidad inválida.'); assert.deepEqual(consolidateItems([{product_id:'B',quantity:1},{product_id:'A',quantity:2},{product_id:'B',quantity:3}]),[{product_id:'A',quantity:2},{product_id:'B',quantity:4}]);
});
