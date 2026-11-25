import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearCliente, MlError } from '../src/ml.mjs';

const fuente = () => { const f = { tokens: ['t1', 't2'], invalidados: 0, getToken: async () => f.tokens[0], invalidate() { f.invalidados++; f.tokens.shift(); } }; return f; };
const respuesta = (status, json = {}, headers = {}) => ({ status, ok: status >= 200 && status < 300, json: async () => json, headers: { get: k => headers[k.toLowerCase()] ?? null } });
const sinEspera = { sleep: async () => {}, random: () => 0 };

test('solo lectura: ninguna escritura sale a la red', async () => {
  let llamadas = 0;
  const ml = crearCliente(fuente(), { fetcher: async () => { llamadas++; return respuesta(200); }, ...sinEspera });
  await assert.rejects(ml.post('/seller-promotions/items/MLU1', {}), e => e instanceof MlError && e.code === 'solo_lectura');
  await assert.rejects(ml.delete('/seller-promotions/items/MLU1?promotion_type=DEAL'), e => e.code === 'solo_lectura');
  await assert.rejects(ml.put('/items/MLU1', {}), e => e.code === 'solo_lectura');
  assert.equal(llamadas, 0);
  assert.equal(ml.stats.escrituras, 0);
});

test('con soloLectura apagado las escrituras salen y se cuentan', async () => {
  const vistos = [];
  const ml = crearCliente(fuente(), { soloLectura: false, fetcher: async (url, init) => { vistos.push([init.method, url]); return respuesta(200, { ok: true }); }, ...sinEspera });
  assert.deepEqual(await ml.delete('/seller-promotions/items/MLU1?promotion_type=DEAL&app_version=v2'), { ok: true });
  assert.equal(vistos[0][0], 'DELETE');
  assert.equal(ml.stats.escrituras, 1);
});

test('429: espera con pausa común y reintenta; respeta retry-after', async () => {
  const esperas = []; let n = 0;
  const ml = crearCliente(fuente(), { fetcher: async () => (++n === 1 ? respuesta(429, {}, { 'retry-after': '2' }) : respuesta(200, { n })), sleep: async ms => { esperas.push(ms); }, random: () => 0.5 });
  assert.deepEqual(await ml.get('/x'), { n: 2 });
  assert.equal(esperas.length, 1);
  assert.ok(esperas[0] >= 2000 && esperas[0] < 2500, `jitter sobre retry-after: ${esperas[0]}`);
  assert.equal(ml.stats.reintentos, 1);
});

test('tope de reintentos: después de agotarlos tira http_429', async () => {
  const ml = crearCliente(fuente(), { intentos: 3, fetcher: async () => respuesta(429), ...sinEspera });
  await assert.rejects(ml.get('/x'), e => e.code === 'http_429' && e.status === 429);
  assert.equal(ml.stats.llamadas, 3);
});

test('5xx se reintenta en GET pero nunca en una escritura', async () => {
  let n = 0;
  const lectura = crearCliente(fuente(), { fetcher: async () => (++n < 3 ? respuesta(502) : respuesta(200, { ok: 1 })), ...sinEspera });
  assert.deepEqual(await lectura.get('/x'), { ok: 1 });
  let m = 0;
  const escritura = crearCliente(fuente(), { soloLectura: false, fetcher: async () => { m++; return respuesta(502, { message: 'boom' }); }, ...sinEspera });
  await assert.rejects(escritura.post('/x', {}), e => e.code === 'http_502' && e.detalle.message === 'boom');
  assert.equal(m, 1);
});

test('401: invalida el token y reintenta una sola vez', async () => {
  const f = fuente(); const tokens = [];
  const ml = crearCliente(f, { fetcher: async (url, init) => { tokens.push(init.headers.Authorization); return tokens.length === 1 ? respuesta(401) : respuesta(200, { ok: 1 }); }, ...sinEspera });
  assert.deepEqual(await ml.get('/x'), { ok: 1 });
  assert.deepEqual(tokens, ['Bearer t1', 'Bearer t2']);
  assert.equal(f.invalidados, 1);
  const siempre401 = crearCliente(fuente(), { fetcher: async () => respuesta(401), ...sinEspera });
  await assert.rejects(siempre401.get('/x'), e => e.code === 'http_401');
});

test('sonda devuelve el código sin tirar y manda los headers extra', async () => {
  let headers;
  const ml = crearCliente(fuente(), { intentos: 1, fetcher: async (url, init) => { headers = init.headers; return respuesta(404, { message: 'No permissions found for user_id' }); }, ...sinEspera });
  const r = await ml.sonda('/advertising/advertisers?product_id=PADS', { headers: { 'Api-Version': '1' } });
  assert.equal(r.status, 404); assert.equal(r.ok, false); assert.equal(r.json.message, 'No permissions found for user_id');
  assert.equal(headers['Api-Version'], '1');
});

test('un corte de red en una escritura no se repite', async () => {
  let n = 0;
  const ml = crearCliente(fuente(), { soloLectura: false, fetcher: async () => { n++; throw new Error('reset'); }, ...sinEspera });
  await assert.rejects(ml.post('/x', {}), e => e.code === 'transporte');
  assert.equal(n, 1);
});
