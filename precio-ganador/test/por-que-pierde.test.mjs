// Por qué pierde (sólo informe). Casos reales del 07-08/11/2026.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { porQuePierde } from '../src/competencia.mjs';

const YO = '440298103';
const ml = (ofertas, usuarios = {}) => ({ async get(p) {
  if (p.startsWith('/products/')) return { results: ofertas, paging: { total: ofertas.length } };
  const m = p.match(/^\/users\/(\d+)$/); if (m) return { id: m[1], seller_reputation: { power_seller_status: usuarios[m[1]] ?? null } };
  throw Object.assign(new Error('no'), { status: 404 });
} });
const item = (price, o = {}) => ({ id: 'MLU1', price, catalog_product_id: 'MLU999', ...o });

test('Óscar: nadie más barato y ML marca envío gratis como oportunidad → por envío gratis', async () => {
  const r = await porQuePierde(ml([{ item_id: 'MLU2', price: 890, seller_id: 5 }, { item_id: 'MLU1', price: 651, seller_id: YO }]), item(651),
    { ganadorItem: 'MLU2', boosts: { free_shipping: 'opportunity', fulfillment: 'opportunity' } }, { sellerId: YO });
  assert.equal(r.causa, 'envio_gratis'); assert.equal(r.mas_barato, 890); assert.equal(r.envio_gratis_propio, false);
});
test('Gestión del Talento Humano: somos un peso más baratos y gana un Platinum → por reputación o entrega', async () => {
  const r = await porQuePierde(ml([{ item_id: 'MLU7', price: 3516, seller_id: 77 }], { 77: 'platinum' }), item(3515),
    { ganadorItem: 'MLU7', boosts: { free_shipping: 'boosted', fulfillment: 'opportunity' } }, { sellerId: YO });
  assert.equal(r.causa, 'reputacion_entrega'); assert.equal(r.ganador_nivel, 'platinum'); assert.deepEqual(r.le_falta, ['fulfillment']);
});
test('hay otro vendedor más barato → por precio', async () => {
  const r = await porQuePierde(ml([{ item_id: 'MLU3', price: 600, seller_id: 9 }]), item(651), { ganadorItem: 'MLU3', boosts: {} }, { sellerId: YO });
  assert.equal(r.causa, 'precio'); assert.equal(r.mas_barato, 600);
});
test('nuestras propias publicaciones no cuentan como competencia', async () => {
  const r = await porQuePierde(ml([{ item_id: 'MLU8', price: 500, seller_id: YO }]), item(651), { boosts: {} }, { sellerId: YO });
  assert.equal(r.mas_barato, null); assert.equal(r.causa, 'otro');
});
test('un error al leer la ficha no corta nada', async () => {
  const roto = { async get() { throw Object.assign(new Error('x'), { status: 500, code: 'http_500' }); } };
  assert.equal((await porQuePierde(roto, item(651), {}, { sellerId: YO })).causa, 'error');
});
