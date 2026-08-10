import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOrdersHandler } from '../_orders_handler.js';
import { consolidateItems, dateInTimeZone, generateFingerprint, validateBody } from '../_orders_logic.js';
import { verifyTurnstile } from '../_turnstile.js';

const NOW = new Date('2026-07-19T16:00:00.000Z');

const PREVIEW_CONFIG = {
  APP_ENV:          'preview',
  MP_COLLECTOR_ID:  '3559407834',
  CHECKOUT_ENABLED: 'true',
  CANONICAL_ORIGIN: 'https://preview.amadolibros-web.pages.dev',
};
const CATALOG = { items: [
  { id:'A', title:'Alpha', price:1000, available_quantity:5, status:'active', thumbnail:null },
  { id:'B', title:'Beta', price:1250, available_quantity:3, status:'active', thumbnail:null },
  { id:'G', title:'Gamma', price:800, available_quantity:5, status:'active', thumbnail:null },
  { id:'P', title:'Pausado', price:300, available_quantity:10, status:'paused', thumbnail:null },
  { id:'X', title:'Precio roto', price:'NaN', available_quantity:2, status:'active', thumbnail:null },
] };

function dbMock({ existing=null, batchError=null, race=null, lookupError=null, strict=false }={}) {
  let lookups=0; const committed=[]; const updates=[];
  return {
    committed, updates, lookups:()=>lookups,
    prepare(sql){
      if (strict) throw new Error('D1 must not be accessed before Turnstile approval');
      return { bind(...args){ const stmt={sql,args}; return {
        async first(){
          if (sql.includes('idempotency_key')) { lookups++; if(lookupError) throw lookupError; return existing || (lookups>1 ? race : null); }
          if (sql.includes('public_code')) return null;
          return null;
        },
        async run(){ updates.push(stmt); return {success:true}; },
        stmt,
      }; } };
    },
    async batch(stmts){ if(batchError) throw batchError; committed.push(...stmts); return stmts.map(()=>({success:true})); },
  };
}

const TS_OK = async () => ({ ok: true });

function ctx(body, db, opts={}) {
  const method=opts.method||'POST'; const headers={'Content-Type':opts.type||'application/json'};
  if(opts.length!==undefined) headers['Content-Length']=String(opts.length);
  // Fail-closed: incluye TURNSTILE_SECRET_KEY cuando ORDERS_DB está presente; permite override vía opts.env.
  const env = opts.env !== undefined ? opts.env : (db ? { ...PREVIEW_CONFIG, ORDERS_DB:db, TURNSTILE_SECRET_KEY:'ts-test-secret' } : { ...PREVIEW_CONFIG });
  return { request:new Request('https://x/api/orders',{method,headers,body:method==='POST'?(typeof body==='string'?body:JSON.stringify(body)):undefined}), env, waitUntil(){} };
}
function pickup(key='k'){ return { idempotency_key:key, cf_turnstile_response:'ok-token', items:[{product_id:'A',quantity:2},{product_id:'B',quantity:1}], delivery_type:'pickup', pickup_ack:true, buyer:{name:'Ana',phone:'099'} }; }
function shipping(key='s', patch={}) { const base={ idempotency_key:key, cf_turnstile_response:'ok-token', items:[{product_id:'G',quantity:1},{product_id:'A',quantity:1}], delivery_type:'shipping', buyer:{name:'Carlos',phone:'098'}, shipping:{address:'Calle 1',locality:'Centro',department:'Montevideo',requested_date:'2026-07-20',requested_from:'09:00',requested_to:'12:00',notes:'2B'} }; return {...base,...patch,shipping:{...base.shipping,...(patch.shipping||{})}}; }
function stored(body, patch={}) { return { id:'uuid', idempotency_key:body.idempotency_key, request_fingerprint:generateFingerprint(body,consolidateItems(body.items)), public_code:'AL-TEST', status:'open', payment_status:'not_started', delivery_type:body.delivery_type, products_total_uyu:3250, pickup_discount_uyu:150, shipping_cost_uyu:0, payable_total_uyu:3100, currency:'UYU', expires_at:'2026-07-19T17:00:00.000Z', ...patch }; }
function handler(fetchCatalog=async()=>CATALOG, now=NOW, verifyTurnstileToken=TS_OK){ return createOrdersHandler({fetchCatalog,getNow:()=>new Date(now),verifyTurnstileToken}); }

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
  const body={idempotency_key:'price',cf_turnstile_response:'ok-token',items:[{product_id:'A',quantity:1,price:99999,title:'falso'}],delivery_type:'pickup', pickup_ack:true,buyer:{name:'T',phone:'099'}}; const r=await call(body); assert.equal(r.data.order.products_total_uyu,1000); assert.equal(r.data.order.payable_total_uyu,850);
});

test('stock, producto, estado y precio inválidos devuelven 422', async()=>{
  for(const id of ['NOPE','P','X']) {
    const b=pickup(id); b.items=[{product_id:id,quantity:1}];
    const result=await call(b);
    assert.equal(result.response.status,422);
    assert.equal(result.data.code,'CART_CHANGED');
    assert.notEqual(result.data.error,'Productos con problemas.');
    assert.equal(Array.isArray(result.data.issues),true);
  }
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

test('envío admite coordinar fecha y horario después del pago', async()=>{
  const b=shipping('later');
  delete b.shipping.requested_date;
  delete b.shipping.requested_from;
  delete b.shipping.requested_to;
  const r=await call(b);
  assert.equal(r.response.status,201);
  assert.equal(r.data.order.delivery_type,'shipping');
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

// ── Turnstile ─────────────────────────────────────────────────────────────────

test('ts-1: ORDERS_DB presente y TURNSTILE_SECRET_KEY ausente → 503, D1 intacta', async()=>{
  const db=dbMock({strict:true});
  const r=await call({...pickup(),cf_turnstile_response:'any'}, db, {env:{...PREVIEW_CONFIG, ORDERS_DB:db}});
  assert.equal(r.response.status,503);
  assert.equal(r.data.code,'TS_NOT_CONFIGURED');
});

test('ts-2: token ausente → 403 TOKEN_MISSING, D1 intacta', async()=>{
  const body={...pickup()}; delete body.cf_turnstile_response;
  const db=dbMock({strict:true});
  const r=await call(body,db);
  assert.equal(r.response.status,403);
  assert.equal(r.data.code,'TOKEN_MISSING');
});

test('ts-3: token demasiado largo → 403 TOKEN_INVALID, D1 intacta', async()=>{
  const db=dbMock({strict:true});
  const r=await call({...pickup(),cf_turnstile_response:'x'.repeat(2049)},db);
  assert.equal(r.response.status,403);
  assert.equal(r.data.code,'TOKEN_INVALID');
});

test('ts-4: token inválido (siteverify rechaza) → 403 TOKEN_INVALID, D1 intacta', async()=>{
  const db=dbMock({strict:true});
  const r=await call({...pickup(),cf_turnstile_response:'bad'},db,{},handler(async()=>CATALOG,NOW,async()=>({ok:false,code:'TOKEN_INVALID'})));
  assert.equal(r.response.status,403);
  assert.equal(r.data.code,'TOKEN_INVALID');
});

test('ts-5: token reutilizado/vencido → 403 TOKEN_EXPIRED, D1 intacta', async()=>{
  const db=dbMock({strict:true});
  const r=await call({...pickup(),cf_turnstile_response:'old'},db,{},handler(async()=>CATALOG,NOW,async()=>({ok:false,code:'TOKEN_EXPIRED'})));
  assert.equal(r.response.status,403);
  assert.equal(r.data.code,'TOKEN_EXPIRED');
});

test('ts-6: error interno de siteverify → 503 SITEVERIFY_ERROR, D1 intacta', async()=>{
  const db=dbMock({strict:true});
  const r=await call({...pickup(),cf_turnstile_response:'any'},db,{},handler(async()=>CATALOG,NOW,async()=>({ok:false,code:'SITEVERIFY_ERROR'})));
  assert.equal(r.response.status,503);
  assert.equal(r.data.code,'SITEVERIFY_ERROR');
});

test('ts-7: timeout de siteverify → 503 SITEVERIFY_TIMEOUT, D1 intacta', async()=>{
  const db=dbMock({strict:true});
  const r=await call({...pickup(),cf_turnstile_response:'any'},db,{},handler(async()=>CATALOG,NOW,async()=>({ok:false,code:'SITEVERIFY_TIMEOUT'})));
  assert.equal(r.response.status,503);
  assert.equal(r.data.code,'SITEVERIFY_TIMEOUT');
});

test('ts-8: action incorrecta → 403 ACTION_INVALID, D1 intacta', async()=>{
  const db=dbMock({strict:true});
  const r=await call({...pickup(),cf_turnstile_response:'any'},db,{},handler(async()=>CATALOG,NOW,async()=>({ok:false,code:'ACTION_INVALID'})));
  assert.equal(r.response.status,403);
  assert.equal(r.data.code,'ACTION_INVALID');
});

test('ts-9: hostname incorrecto → 403 HOSTNAME_INVALID, D1 intacta', async()=>{
  const db=dbMock({strict:true});
  const r=await call({...pickup(),cf_turnstile_response:'any'},db,{},handler(async()=>CATALOG,NOW,async()=>({ok:false,code:'HOSTNAME_INVALID'})));
  assert.equal(r.response.status,403);
  assert.equal(r.data.code,'HOSTNAME_INVALID');
});

test('ts-10: token válido → 201 y D1 escrita', async()=>{
  const db=dbMock();
  const r=await call({...pickup(),cf_turnstile_response:'valid'},db);
  assert.equal(r.response.status,201);
  assert.equal(db.committed.length>0,true);
});

test('ts-11: cf_turnstile_response cadena vacía o espacios → 403 TOKEN_MISSING, D1 intacta', async()=>{
  const db=dbMock({strict:true});
  const r=await call({...pickup(),cf_turnstile_response:'   '},db);
  assert.equal(r.response.status,403);
  assert.equal(r.data.code,'TOKEN_MISSING');
});

// ── Tests unitarios de _turnstile.js con fetch inyectable ────────────────────

function fakeFetch(body, ok=true) {
  return async () => ({ ok, json: async () => body });
}

test('ts-12: siteverify HTTP 500 → SITEVERIFY_ERROR', async()=>{
  const res=await verifyTurnstile('tok','sec','',{fetch:fakeFetch(null,false)});
  assert.equal(res.ok,false);
  assert.equal(res.code,'SITEVERIFY_ERROR');
});

test('ts-13: siteverify JSON inválido → SITEVERIFY_ERROR', async()=>{
  const badFetch=async()=>({ok:true,json:async()=>{throw new SyntaxError('bad json');}});
  const res=await verifyTurnstile('tok','sec','',{fetch:badFetch});
  assert.equal(res.ok,false);
  assert.equal(res.code,'SITEVERIFY_ERROR');
});

const PAGES_PREVIEW_HOSTNAME_RE = /^[^.]+\.amadolibros-web\.pages\.dev$/;
const isPreviewHostnameForTest  = (h) => PAGES_PREVIEW_HOSTNAME_RE.test(h);

test('ts-14: hostname commit-hash Preview → ok: true', async()=>{
  const f=fakeFetch({success:true,action:'prepare_order',hostname:'abc123def456.amadolibros-web.pages.dev'});
  const res=await verifyTurnstile('tok','sec','',{fetch:f, isAllowedHostname:isPreviewHostnameForTest});
  assert.equal(res.ok,true);
});

test('ts-15: hostname alias de rama Preview → ok: true', async()=>{
  const f=fakeFetch({success:true,action:'prepare_order',hostname:'feature-turnstile.amadolibros-web.pages.dev'});
  const res=await verifyTurnstile('tok','sec','',{fetch:f, isAllowedHostname:isPreviewHostnameForTest});
  assert.equal(res.ok,true);
});

test('ts-14b: isAllowedHostname ausente → HOSTNAME_INVALID (fail-closed, no default hardcodeado)', async()=>{
  const f=fakeFetch({success:true,action:'prepare_order',hostname:'abc123def456.amadolibros-web.pages.dev'});
  const res=await verifyTurnstile('tok','sec','',{fetch:f});
  assert.equal(res.ok,false);
  assert.equal(res.code,'HOSTNAME_INVALID');
});

test('ts-16: token y secret nunca expuestos en respuesta al cliente', async()=>{
  const r=await call({...pickup()});
  const text=JSON.stringify(r.data);
  assert.ok(!text.includes('ok-token'),'token leaked in response');
  assert.ok(!text.includes('ts-test-secret'),'secret leaked in response');
});

// ── 2-N-E1: config centralizada, kill switch, Turnstile por hostname ────────

test('cfg-1: APP_ENV ausente → 503 fail-closed', async()=>{
  const db=dbMock({strict:true});
  const r=await call(pickup(),db,{env:{ORDERS_DB:db, TURNSTILE_SECRET_KEY:'ts-test-secret'}});
  assert.equal(r.response.status,503);
});

test('cfg-2: MP_COLLECTOR_ID inválido (no decimal) → 503 fail-closed', async()=>{
  const db=dbMock({strict:true});
  const r=await call(pickup(),db,{env:{...PREVIEW_CONFIG, MP_COLLECTOR_ID:'no-es-numero', ORDERS_DB:db, TURNSTILE_SECRET_KEY:'ts-test-secret'}});
  assert.equal(r.response.status,503);
});

test('kill-1: CHECKOUT_ENABLED ausente → 503 checkout_temporarily_unavailable, D1 intacta', async()=>{
  const db=dbMock({strict:true});
  const r=await call(pickup(),db,{env:{...PREVIEW_CONFIG, CHECKOUT_ENABLED:undefined, ORDERS_DB:db, TURNSTILE_SECRET_KEY:'ts-test-secret'}});
  assert.equal(r.response.status,503);
  assert.equal(r.data.code,'checkout_temporarily_unavailable');
  assert.equal(r.response.headers.get('Cache-Control'),'no-store');
});

test('kill-2: CHECKOUT_ENABLED="false" → 503 checkout_temporarily_unavailable', async()=>{
  const db=dbMock({strict:true});
  const r=await call(pickup(),db,{env:{...PREVIEW_CONFIG, CHECKOUT_ENABLED:'false', ORDERS_DB:db, TURNSTILE_SECRET_KEY:'ts-test-secret'}});
  assert.equal(r.response.status,503);
  assert.equal(r.data.code,'checkout_temporarily_unavailable');
});

test('kill-3: CHECKOUT_ENABLED="TRUE" (mayúsculas) → deshabilitado, exige el string exacto "true"', async()=>{
  const db=dbMock({strict:true});
  const r=await call(pickup(),db,{env:{...PREVIEW_CONFIG, CHECKOUT_ENABLED:'TRUE', ORDERS_DB:db, TURNSTILE_SECRET_KEY:'ts-test-secret'}});
  assert.equal(r.response.status,503);
  assert.equal(r.data.code,'checkout_temporarily_unavailable');
});

test('kill-4: CHECKOUT_ENABLED="true" → checkout normal, D1 escrita', async()=>{
  const db=dbMock();
  const r=await call({...pickup(),cf_turnstile_response:'valid'},db,{env:{...PREVIEW_CONFIG, ORDERS_DB:db, TURNSTILE_SECRET_KEY:'ts-test-secret'}});
  assert.equal(r.response.status,201);
  assert.equal(db.committed.length>0,true);
});

test('ts-17: verifyTurnstile real con hostname de Preview válido (vía config) → pedido creado', async()=>{
  const db=dbMock();
  const f=fakeFetch({success:true,action:'prepare_order',hostname:'feature-2-n-e1-production-ready-code.amadolibros-web.pages.dev'});
  const r=await call(
    {...pickup(),cf_turnstile_response:'valid'},
    db,
    {},
    handler(async()=>CATALOG,NOW,(token,secret,ip,opts)=>verifyTurnstile(token,secret,ip,{...opts,fetch:f}))
  );
  assert.equal(r.response.status,201);
});

test('ts-18: verifyTurnstile real con hostname engañoso (no pertenece al proyecto) → 403 HOSTNAME_INVALID', async()=>{
  const db=dbMock({strict:true});
  const f=fakeFetch({success:true,action:'prepare_order',hostname:'amadolibros-web.pages.dev.evil.com'});
  const r=await call(
    {...pickup(),cf_turnstile_response:'bad-host'},
    db,
    {},
    handler(async()=>CATALOG,NOW,(token,secret,ip,opts)=>verifyTurnstile(token,secret,ip,{...opts,fetch:f}))
  );
  assert.equal(r.response.status,403);
  assert.equal(r.data.code,'HOSTNAME_INVALID');
});
