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
test('palanca: si perdemos por envío gratis, envío gratis siempre (Seba 08/11); el costo se informa', async () => {
  const conCosto = costo => ({ async get(p) {
    if (p.startsWith('/products/')) return { results: [{ item_id: 'MLU2', price: 890, seller_id: 5 }], paging: { total: 1 } };
    if (p.includes('/shipping_options/free')) return { coverage: { all_country: { list_cost: costo } } };
    return { seller_reputation: { power_seller_status: 'gold' } };
  } });
  const comp = { ganadorItem: 'MLU2', ganador: 631, boosts: { free_shipping: 'opportunity' } };
  const r = await porQuePierde(conCosto(189), item(651), comp, { sellerId: YO });
  assert.deepEqual([r.causa, r.palanca, r.costo_envio_gratis, r.nuestro_nivel], ['envio_gratis', 'envio_gratis', 189, 'gold']);
  const p = await porQuePierde(conCosto(25), item(651), { ganadorItem: 'MLU2', ganador: 600, boosts: {} }, { sellerId: YO });
  assert.equal(p.palanca, 'bajar');   // no hay oportunidad de envío gratis: se baja como siempre
});
test('días del ganador: más de 5 = a demanda (para publicar fuera de catálogo)', async () => {
  const conPlazo = horas => ({ async get(p) {
    if (p.startsWith('/products/')) return { results: [{ item_id: 'MLU2', price: 900, seller_id: 5 }], paging: { total: 1 } };
    if (p.includes('/shipping_options?')) return { options: [{ display: 'recommended', estimated_delivery_time: { schedule: horas, unit: 'hour' } }] };
    return { seller_reputation: { power_seller_status: 'gold' } };
  } });
  const comp = { ganadorItem: 'MLU2', ganador: 850, boosts: {} };
  const lento = await porQuePierde(conPlazo(480), item(1000), comp, { sellerId: YO });
  assert.deepEqual([lento.ganador_dias, lento.contra_demanda], [20, true]);
  const rapido = await porQuePierde(conPlazo(48), item(1000), comp, { sellerId: YO });
  assert.deepEqual([rapido.ganador_dias, rapido.contra_demanda], [2, false]);
});
