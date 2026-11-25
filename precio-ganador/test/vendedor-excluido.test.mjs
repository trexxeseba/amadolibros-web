import { test } from 'node:test';
import assert from 'node:assert/strict';
import { competencia, nuevoCacheVendedores } from '../src/competencia.mjs';
import { decidir } from '../src/decision.mjs';

const J = (f, calls) => async path => { calls?.push(path); const v = f(path); if (v instanceof Error) throw v; return v; };
const item = { id: 'MLU1', price: 2000, currency_id: 'UYU', catalog_listing: true, catalog_product_id: 'MLU99', demanda: true, available_quantity: 1 };

// price_to_win: pierde contra MLU500 a 1500. Las ofertas del producto: MLU500 es del vendedor 777 (POCHOLIB).
const base = path => {
  if (path.includes('/price_to_win')) return { status: 'competing', price_to_win: 1500, winner: { item_id: 'MLU500', price: 1500 } };
  if (path.startsWith('/products/MLU99/items')) return { results: [{ item_id: 'MLU500', seller_id: 777, price: 1500 }, { item_id: 'MLU600', seller_id: 888, price: 1900 }], paging: { total: 2 } };
  if (path === '/users/777') return { nickname: 'POCHOLIB' };
  if (path === '/users/888') return { nickname: 'OtroVendedor' };
  if (path.includes('/shipping_options')) return { options: [{ display: 'recommended', estimated_delivery_time: { schedule: 400, unit: 'hours' } }] };
  return new Error('sin mock ' + path);
};
const opciones = () => ({ sellerId: '2341378249', soloContraDemanda: true, descuento: 0.01, excluirVendedores: new Set(['pocholib']), cacheVendedores: nuevoCacheVendedores() });

test('si el ganador es POCHOLIB (sin importar mayúsculas) no se compite', async () => {
  const c = await competencia({ get: J(base) }, item, opciones());
  assert.equal(c.ganadorVendedor, 'POCHOLIB');
  assert.equal(c.bloqueo, 'vendedor_excluido');
  assert.equal(c.marcada, false);
  const d = decidir({ item, comp: c, umbral: 600, umbralInclusivo: true, descuento: 0.01, piso: 1200 });
  assert.equal(d.accion, 'saltear_vendedor_excluido');
  assert.match(d.motivo, /POCHOLIB/);
});

test('si el ganador es otro vendedor, se compite como siempre y se anota quién gana', async () => {
  const get = J(path => path.includes('/price_to_win') ? { status: 'competing', price_to_win: 1500, winner: { item_id: 'MLU600', price: 1500 } } : base(path));
  const c = await competencia({ get }, item, opciones());
  assert.equal(c.ganadorVendedor, 'OtroVendedor');
  assert.equal(c.bloqueo, undefined);
  assert.equal(c.marcada, true);
});

test('el techo para subir no se mide contra POCHOLIB', async () => {
  const get = J(path => path.includes('/price_to_win') ? { status: 'winning', price_to_win: 1950, winner: { item_id: 'MLU1' } } : base(path));
  const c = await competencia({ get }, item, { ...opciones(), necesitaTecho: true });
  assert.equal(c.techo_de, 1900);   // el más barato que no es POCHOLIB
  assert.equal(c.techo, 1881);
});

test('una cuenta sin lista de excluidos no hace llamadas extra de vendedores', async () => {
  const calls = [];
  const get = J(path => path.includes('/price_to_win') ? { status: 'competing', price_to_win: 1500, winner: { item_id: 'MLU500' } } : new Error('x'), calls);
  const c = await competencia({ get }, item, { sellerId: 'x', soloContraDemanda: false });
  assert.equal(c.marcada, true);
  assert.ok(!calls.some(p => p.startsWith('/users') || p.startsWith('/products')));
});
