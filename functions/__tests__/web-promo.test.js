import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WEB_PROMO,
  applyPromoToPrice,
  applyWebPromoToCatalog,
  applyWebPromoToItems,
  webPromoActive,
} from '../_shared/web-promo.js';
import { validateCartAgainstCatalog } from '../api/_orders_logic.js';

const DENTRO = new Date('2026-11-02T12:00:00-03:00');
const ANTES = new Date('2026-10-31T23:59:59-03:00');
const DESPUES = new Date('2026-11-03T00:00:00-03:00');

const items = () => [
  { id: 'MLU1', title: 'Uno', price: 1234, status: 'active', available_quantity: 3 },
  { id: 'MLU2', title: 'Dos', price: 65, status: 'active', available_quantity: 1 },
  { id: 'MLU3', title: 'Pausado', price: 900, status: 'paused', available_quantity: 0 },
  { id: 'MLU4', title: 'Sin precio', price: null, status: 'active', available_quantity: 1 },
];

test('la promo vale 15 % y solo dentro de su ventana de fechas', () => {
  assert.equal(WEB_PROMO.percent, 15);
  assert.equal(webPromoActive(DENTRO), true);
  assert.equal(webPromoActive(ANTES), false);
  assert.equal(webPromoActive(DESPUES), false);
  assert.equal(webPromoActive(new Date(WEB_PROMO.startsAt)), true);
  assert.equal(webPromoActive(new Date(WEB_PROMO.endsAt)), true);
});

test('WEB_PROMO_OFF=1 corta la promo aunque la ventana esté vigente', () => {
  assert.equal(webPromoActive(DENTRO, { WEB_PROMO_OFF: '1' }), false);
  assert.equal(webPromoActive(DENTRO, { WEB_PROMO_OFF: '0' }), true);
});

test('porcentaje o fechas inválidos dejan la promo apagada', () => {
  const base = { percent: 15, startsAt: WEB_PROMO.startsAt, endsAt: WEB_PROMO.endsAt };
  assert.equal(webPromoActive(DENTRO, {}, { ...base, percent: 0 }), false);
  assert.equal(webPromoActive(DENTRO, {}, { ...base, percent: 100 }), false);
  assert.equal(webPromoActive(DENTRO, {}, { ...base, percent: 'x' }), false);
  assert.equal(webPromoActive(DENTRO, {}, { ...base, startsAt: 'no-es-fecha' }), false);
});

test('el precio rebajado se redondea a entero y nunca baja de 1', () => {
  assert.equal(applyPromoToPrice(1234), 1049);
  assert.equal(applyPromoToPrice(1000), 850);
  assert.equal(applyPromoToPrice(1), 1);
  assert.equal(applyPromoToPrice(0), 0);
  assert.equal(applyPromoToPrice(null), null);
});

test('rebaja solo activas con precio válido y conserva el precio original', () => {
  const out = applyWebPromoToItems(items(), { now: DENTRO });
  assert.equal(out[0].price, 1049);
  assert.equal(out[0].original_price, 1234);
  assert.equal(out[1].price, 55);
  assert.equal(out[2].price, 900);
  assert.equal(out[2].original_price, undefined);
  assert.equal(out[3].price, null);
});

test('no muta la lista original y fuera de ventana devuelve la misma referencia', () => {
  const original = items();
  applyWebPromoToItems(original, { now: DENTRO });
  assert.equal(original[0].price, 1234);
  assert.equal(applyWebPromoToItems(original, { now: DESPUES }), original);
  assert.equal(applyWebPromoToItems(original, { now: DENTRO, env: { WEB_PROMO_OFF: '1' } }), original);
});

test('applyWebPromoToCatalog respeta la forma { items } y entradas inválidas', () => {
  const catalog = { updated_at: 'x', items: items() };
  const out = applyWebPromoToCatalog(catalog, { now: DENTRO });
  assert.equal(out.updated_at, 'x');
  assert.equal(out.items[0].price, 1049);
  assert.equal(applyWebPromoToCatalog(null, { now: DENTRO }), null);
  assert.deepEqual(applyWebPromoToCatalog({ foo: 1 }, { now: DENTRO }), { foo: 1 });
});

test('el carrito valida contra el precio rebajado y avisa del cambio al cliente con precio viejo', () => {
  const catalogo = applyWebPromoToItems(items(), { now: DENTRO });
  const [conPrecioViejo] = validateCartAgainstCatalog(
    [{ product_id: 'MLU1', quantity: 1, unit_price_uyu: 1234 }],
    catalogo,
  );
  assert.equal(conPrecioViejo.price_uyu, 1049);
  assert.equal(conPrecioViejo.status, 'precio_cambiado');
  const [conPrecioNuevo] = validateCartAgainstCatalog(
    [{ product_id: 'MLU1', quantity: 1, unit_price_uyu: 1049 }],
    catalogo,
  );
  assert.equal(conPrecioNuevo.status, 'ok');
});
