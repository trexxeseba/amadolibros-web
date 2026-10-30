import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MAX_PCT, discountPct, uyDate, inExceptionWindow, couponAmountUyu,
  classifyEntry, planRemovals, planLightning,
} from '../mercadolibre/promos-policy.mjs';

const entry = (over = {}) => ({
  item_id: 'MLU1', promotion_id: 'P-1', promotion_type: 'DEAL', promotion_name: 'Semana del libro',
  status: 'started', price: 840, original_price: 1000, ...over,
});

test('el tope por defecto es 16 y 16 exacto no lo supera', () => {
  assert.equal(DEFAULT_MAX_PCT, 16);
  assert.equal(discountPct(entry({ price: 840 })), 16);
  assert.equal(classifyEntry(entry({ price: 840 }), { date: '2026-11-05' }).decision, 'dentro_del_tope');
  assert.equal(classifyEntry(entry({ price: 839 }), { date: '2026-11-05' }).decision, 'quitar');
});

test('el descuento sale de precio y precio original; si faltan, de los porcentajes de ML', () => {
  assert.equal(discountPct(entry({ price: 750 })), 25);
  assert.equal(discountPct({ meli_percentage: 6, seller_percentage: 10 }), 16);
  assert.equal(discountPct({ meli_percentage: 5 }), 5);
  assert.equal(discountPct({}), null);
  assert.equal(discountPct(entry({ price: 1200 })), null);
});

test('un descuento que no se puede medir no se quita: queda para revisar', () => {
  assert.equal(classifyEntry({ item_id: 'MLU9', promotion_id: 'P', promotion_type: 'DEAL', status: 'started' }, { date: '2026-11-05' }).decision, 'revisar');
});

test('la ventana de la excepción es del 29 al 31/10/2026 en hora de Uruguay', () => {
  assert.equal(uyDate(new Date('2026-10-30T02:30:00Z')), '2026-10-29');
  assert.equal(uyDate(new Date('2026-10-29T02:59:00Z')), '2026-10-28');
  for (const d of ['2026-10-29', '2026-10-30', '2026-10-31']) assert.equal(inExceptionWindow(d), true, d);
  for (const d of ['2026-10-28', '2026-11-01']) assert.equal(inExceptionWindow(d), false, d);
});

test('excepción: hasta 20 % con promo + cupón <= 750 y stock 3 o más', () => {
  const e = entry({ price: 820, original_price: 1000 }); // 18 %, promo = 180
  const base = { date: '2026-10-30', coupon_uyu: 100, available_quantity: 3 };
  assert.equal(classifyEntry(e, base).decision, 'conservar_excepcion');
  assert.equal(classifyEntry(e, { ...base, available_quantity: 2 }).decision, 'quitar');
  assert.equal(classifyEntry(entry({ price: 790 }), base).decision, 'quitar'); // 21 %
  assert.equal(classifyEntry(entry({ price: 800, original_price: 1000 }), { ...base, coupon_uyu: 551 }).decision, 'quitar'); // 200 + 551 > 750
  assert.equal(classifyEntry(entry({ price: 800, original_price: 1000 }), { ...base, coupon_uyu: 550 }).decision, 'conservar_excepcion'); // 200 + 550 = 750
  assert.equal(classifyEntry(e, { ...base, date: '2026-11-01' }).decision, 'quitar');
});

test('excepción: si no se puede saber el cupón o el stock, no se quita: queda para revisar', () => {
  const e = entry({ price: 820 });
  assert.equal(classifyEntry(e, { date: '2026-10-30', coupon_uyu: null, available_quantity: 5 }).decision, 'revisar');
  assert.equal(classifyEntry(e, { date: '2026-10-30', coupon_uyu: 0, available_quantity: null }).decision, 'revisar');
});

test('el monto del cupón sale de las promociones de cupón activas; sin cupón es 0; sin dato es null', () => {
  assert.equal(couponAmountUyu([{ type: 'DEAL', status: 'started' }], 900), 0);
  assert.equal(couponAmountUyu([{ type: 'SELLER_COUPON_CAMPAIGN', status: 'started', fixed_amount: 120 }], 900), 120);
  assert.equal(couponAmountUyu([{ type: 'SELLER_COUPON_CAMPAIGN', status: 'pending', discount_percentage: 10 }], 900), 90);
  assert.equal(couponAmountUyu([{ type: 'SELLER_COUPON_CAMPAIGN', status: 'finished', fixed_amount: 999 }], 900), 0);
  assert.equal(couponAmountUyu([{ type: 'SELLER_COUPON_CAMPAIGN', status: 'started' }], 900), null);
});

test('planRemovals: solo saca de la promo lo que supera el tope y nunca propone tocar precios', () => {
  const entries = [
    entry({ item_id: 'MLU1', price: 700 }),
    entry({ item_id: 'MLU2', price: 900 }),
    entry({ item_id: 'MLU3', price: 700, promotion_type: 'SELLER_COUPON_CAMPAIGN', promotion_name: 'Cupón' }),
    entry({ item_id: 'MLU4', price: 600, promotion_id: 'P-2', promotion_name: 'Amado Liquidacion 40/30/20' }),
    entry({ item_id: 'MLU5', status: 'pending', price: 750 }),
  ];
  const plan = planRemovals(entries, { date: '2026-11-05', itemInfo: {} });
  assert.deepEqual(plan.removals.map(r => r.item_id), ['MLU1', 'MLU5']);
  assert.deepEqual(plan.removals[0], { item_id: 'MLU1', promotion_id: 'P-1', promotion_type: 'DEAL', discount_pct: 30 });
  assert.deepEqual(plan.skipped.map(s => [s.item_id, s.reason]), [['MLU3', 'cupon_o_publicidad_no_se_toca'], ['MLU4', 'liquidacion_no_se_toca']]);
  assert.ok(plan.removals.every(r => !('price' in r) && !('status' in r)));
});

test('planRemovals: en la ventana, la excepción conserva y lo dudoso va a revisar', () => {
  const entries = [entry({ item_id: 'MLU1', price: 820 }), entry({ item_id: 'MLU2', price: 820 }), entry({ item_id: 'MLU3', price: 600 })];
  const itemInfo = {
    MLU1: { available_quantity: 5, coupon_uyu: 0 },
    MLU2: { available_quantity: 5, coupon_uyu: null },
    MLU3: { available_quantity: 5, coupon_uyu: 0 },
  };
  const plan = planRemovals(entries, { date: '2026-10-31', itemInfo });
  assert.deepEqual(plan.removals.map(r => r.item_id), ['MLU3']);
  assert.deepEqual(plan.kept_by_exception.map(r => r.item_id), ['MLU1']);
  assert.deepEqual(plan.to_review.map(r => r.item_id), ['MLU2']);
});

const lightning = (over = {}) => ({
  id: 'MLU1', promotion_id: 'L-1', promotion_type: 'LIGHTNING', status: 'candidate',
  original_price: 1000, min_discounted_price: 700, max_discounted_price: 860, min_stock: 2, max_stock: 10, ...over,
});
const info = (over = {}) => ({ MLU1: { price: 950, available_quantity: 6, ...over } });

test('planLightning: suma si el mínimo que exige ML es <= al máximo y usa el precio más alto permitido', () => {
  const plan = planLightning(['MLU1'], { promotions: { MLU1: [lightning()] }, itemInfo: info(), maxPct: 16 });
  assert.equal(plan.joins.length, 1);
  assert.deepEqual(plan.joins[0], { item_id: 'MLU1', promotion_id: 'L-1', promotion_type: 'LIGHTNING', deal_price: 860, current_price: 950, stock: 2, available_quantity: 6, discount_pct: 14, required_min_pct: 14 });
});

test('planLightning: no suma si ML exige más descuento que el máximo', () => {
  const plan = planLightning(['MLU1'], { promotions: { MLU1: [lightning({ max_discounted_price: 800 })] }, itemInfo: info(), maxPct: 16 });
  assert.equal(plan.joins.length, 0);
  assert.equal(plan.skipped[0].reason, 'ml_exige_mas_descuento_que_el_maximo');
  assert.equal(plan.skipped[0].required_min_pct, 20);
});

test('planLightning: nunca sube el precio, respeta el stock y ignora lo que no es candidato', () => {
  assert.equal(planLightning(['MLU1'], { promotions: { MLU1: [lightning()] }, itemInfo: info({ price: 800 }), maxPct: 16 }).skipped[0].reason, 'subiria_el_precio');
  assert.equal(planLightning(['MLU1'], { promotions: { MLU1: [lightning()] }, itemInfo: info({ available_quantity: 1 }), maxPct: 16 }).skipped[0].reason, 'stock_insuficiente');
  assert.equal(planLightning(['MLU1'], { promotions: { MLU1: [lightning({ status: 'started' })] }, itemInfo: info(), maxPct: 16 }).skipped[0].reason, 'ya_esta_en_la_oferta');
  assert.equal(planLightning(['MLU1'], { promotions: { MLU1: [] }, itemInfo: info(), maxPct: 16 }).skipped[0].reason, 'sin_oferta_relampago_disponible');
  assert.equal(planLightning(['MLU2'], { promotions: {}, itemInfo: {}, maxPct: 16 }).skipped[0].reason, 'sin_datos');
  assert.equal(planLightning(['MLU1'], { promotions: { MLU1: [lightning({ promotion_name: 'Amado Liquidacion 40/30/20' })] }, itemInfo: info(), maxPct: 16 }).skipped[0].reason, 'liquidacion_no_se_toca');
});
