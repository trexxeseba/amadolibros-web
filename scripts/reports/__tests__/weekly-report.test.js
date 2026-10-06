// INFORME-ANALITICO: el informe semanal respeta sus reglas aunque falten datos.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACTION_RULES,
  buildWeeklyReport,
  compare,
  ctrOpportunities,
  pendingTransfers,
  ratio,
} from '../weekly/build-report.mjs';
import { weeklyQueries } from '../weekly/fetch-d1.mjs';
import { weeklyPeriods } from '../weekly/periods.mjs';

// Lunes 12/10/2026, 09:05 en Montevideo.
const NOW = new Date('2026-10-12T12:05:00.000Z');
const periods = weeklyPeriods(NOW);

test('la semana del informe es la última completa, de lunes a domingo en Montevideo', () => {
  assert.equal(periods.current.startDate, '2026-10-05');
  assert.equal(periods.current.endDate, '2026-10-11');
  assert.equal(periods.current.startIso, '2026-10-05T03:00:00.000Z');
  assert.equal(periods.current.endIso, '2026-10-12T03:00:00.000Z');
  assert.equal(periods.previous.startDate, '2026-09-28');
  assert.equal(periods.previous.endDate, '2026-10-04');
  // Search Console: siete días que terminan tres antes de hoy.
  assert.equal(periods.gsc.current.endDate, '2026-10-09');
  assert.equal(periods.gsc.current.startDate, '2026-10-03');
  assert.equal(periods.gsc.previous.endDate, '2026-10-02');
});

test('un domingo a la noche en Montevideo todavía no cerró la semana', () => {
  const p = weeklyPeriods(new Date('2026-10-12T02:00:00.000Z')); // domingo 11, 23:00 UY
  assert.equal(p.current.startDate, '2026-09-28');
});

test('con menos de 30 casos no hay porcentajes', () => {
  assert.equal(ratio(4, 9), '4 de 9');
  assert.equal(ratio(29, 29), '29 de 29');
  assert.match(ratio(15, 300), /^5,0 % \(15 de 300\)$/);
  assert.equal(ratio(null, 10), 'sin dato');
});

test('toda métrica va con la semana anterior, y sin dato no es cero', () => {
  assert.equal(compare(12, 9), '12 (semana anterior: 9, +3)');
  assert.equal(compare(2, 5), '2 (semana anterior: 5, −3)');
  assert.equal(compare(3, 3), '3 (semana anterior: 3, igual)');
  assert.equal(compare(3, null), '3 (semana anterior: sin dato)');
  assert.equal(compare(null, 3), 'sin dato');
});

test('las consultas no leen datos personales', () => {
  const queries = Object.values(weeklyQueries(periods, NOW)).join('\n');
  for (const column of ['buyer_name', 'buyer_phone', 'buyer_email', 'address', 'email', 'locality']) {
    assert.doesNotMatch(queries, new RegExp(`\\b${column}\\b`), column);
  }
  assert.match(queries, /'2026-09-28T03:00:00\.000Z'/);
});

// ── datos de ejemplo ───────────────────────────────────────────────────────

const order = (id, patch) => ({
  id, public_code: `AL-${id}`, status: 'open', payment_status: 'not_started', payment_provider: null,
  delivery_type: 'pickup', products_total_uyu: 1000, pickup_discount_uyu: 0, shipping_cost_uyu: 0,
  payable_total_uyu: 1000, paid_amount_uyu: null, created_at: '2026-10-06T15:00:00.000Z', paid_at: null,
  expires_at: '2026-10-06T16:00:00.000Z', ...patch,
});
const event = (orderId, type, createdAt, payload = null) => ({
  order_id: orderId, event_type: type, created_at: createdAt, payload_json: payload ? JSON.stringify(payload) : null,
});

function d1Fixture({ since = '2026-09-30T07:20:00.000Z' } = {}) {
  return {
    orders: [
      order('1', { status: 'paid', payment_status: 'approved', payment_provider: 'mercadopago', paid_at: '2026-10-06T15:05:00.000Z', delivery_type: 'shipping', payable_total_uyu: 1250 }),
      order('2', { status: 'paid', payment_status: 'approved', payment_provider: 'bank_transfer', paid_amount_uyu: 880, paid_at: '2026-10-08T12:00:00.000Z' }),
      order('3', { payment_status: 'rejected', payment_provider: 'mercadopago' }),
      order('4', { payment_provider: 'mercadopago' }),
      order('5', { created_at: '2026-10-07T12:00:00.000Z' }),
      order('6', { status: 'paid', payment_status: 'approved', payment_provider: 'mercadopago', created_at: '2026-09-29T12:00:00.000Z', paid_at: '2026-09-29T12:10:00.000Z' }),
    ],
    events: [
      event('1', 'preference_created', '2026-10-06T15:01:00.000Z'),
      event('1', 'payment_approved', '2026-10-06T15:05:00.000Z'),
      event('2', 'transfer_payment_info_viewed', '2026-10-06T10:00:00.000Z', { transfer_total_uyu: 880 }),
      event('2', 'transfer_confirmed', '2026-10-08T12:00:00.000Z', { amount_uyu: 880 }),
      event('3', 'preference_created', '2026-10-06T15:01:00.000Z'),
      event('3', 'payment_rejected', '2026-10-06T15:03:00.000Z', { payment_id: 9, status_detail: 'cc_rejected_insufficient_amount' }),
      event('3', 'payment_rejected', '2026-10-06T15:04:00.000Z', { payment_id: 10, status_detail: 'cc_rejected_insufficient_amount' }),
      event('4', 'preference_created', '2026-10-06T15:01:00.000Z'),
      event('5', 'transfer_payment_info_viewed', '2026-10-07T12:05:00.000Z', { transfer_total_uyu: 880 }),
      event('6', 'preference_created', '2026-09-29T12:01:00.000Z'),
    ],
    items: [
      { order_id: '1', product_id: 'MLU1', title: 'Rayuela', quantity: 2, line_total_uyu: 1000 },
      { order_id: '2', product_id: 'MLU2', title: 'Ficciones', quantity: 1, line_total_uyu: 1000 },
      { order_id: '6', product_id: 'MLU1', title: 'Rayuela', quantity: 1, line_total_uyu: 1000 },
    ],
    waitlist: [
      { product_id: 'MLU9', product_title: 'El Aleph', status: 'waiting', created_at: '2026-10-06T10:00:00.000Z', notified_at: null },
      { product_id: 'MLU9', product_title: 'El Aleph', status: 'waiting', created_at: '2026-10-07T10:00:00.000Z', notified_at: null },
    ],
    search_misses: [
      { date: '2026-10-06', query: 'harry potter y la orden', count: 2 },
      { date: '2026-10-08', query: 'harry potter y la orden', count: 2 },
      { date: '2026-10-08', query: 'kafka en la orilla', count: 1 },
    ],
    sync_log: [
      { synced_at: '2026-10-06T07:20:00.000Z', total_items: 7000, available_items: 6500, added: 12, removed: 4, price_up: 3, price_down: 1, out_of_stock: 2, back_in_stock: 1, baseline: 1, samples_json: JSON.stringify({ price_changes: [{ id: 'MLU1', title: 'Rayuela', from: 900, to: 1100 }] }) },
      { synced_at: '2026-10-01T07:20:00.000Z', total_items: 6990, available_items: 6490, added: 5, removed: 5, price_up: 0, price_down: 0, out_of_stock: 0, back_in_stock: 0, baseline: 1, samples_json: '{}' },
    ],
    sync_latest: [{ synced_at: '2026-10-12T07:20:00.000Z', total_items: 7043, available_items: 6512 }],
    sync_first: [{ first: since }],
  };
}

const ga4Fixture = {
  current: {
    events: [
      { eventName: 'view_item', deviceCategory: 'mobile', sessionDefaultChannelGroup: 'Organic Search', eventCount: 400 },
      { eventName: 'add_to_cart', deviceCategory: 'mobile', sessionDefaultChannelGroup: 'Organic Search', eventCount: 20 },
      { eventName: 'whatsapp_click', deviceCategory: 'desktop', sessionDefaultChannelGroup: 'Direct', eventCount: 7 },
    ],
    sessions: [
      { deviceCategory: 'mobile', sessionDefaultChannelGroup: 'Organic Search', sessions: 900 },
      { deviceCategory: 'desktop', sessionDefaultChannelGroup: 'Direct', sessions: 300 },
    ],
  },
  previous: {
    events: [{ eventName: 'whatsapp_click', deviceCategory: 'desktop', sessionDefaultChannelGroup: 'Direct', eventCount: 5 }],
    sessions: [{ deviceCategory: 'mobile', sessionDefaultChannelGroup: 'Organic Search', sessions: 1000 }],
  },
};

const gscFixture = {
  current: {
    totals: [{ clicks: 120, impressions: 9000, position: 14.2 }],
    pages: [
      { page: 'https://www.amadolibros.com/libro/MLU1/rayuela', clicks: 1, impressions: 450, position: 6.1 },
      { page: 'https://www.amadolibros.com/catalogo', clicks: 40, impressions: 1000, position: 3 },
    ],
    queries: [{ query: 'amado libros', clicks: 30, impressions: 60, position: 1 }],
  },
  previous: {
    totals: [{ clicks: 100, impressions: 8000, position: 15 }],
    pages: [{ page: 'https://www.amadolibros.com/catalogo', clicks: 30, impressions: 900, position: 3 }],
    queries: [{ query: 'amado libros', clicks: 25, impressions: 50, position: 1 }],
  },
};

test('arma ventas, pagos, demanda, SEO y catálogo con la semana anterior al lado', () => {
  const md = buildWeeklyReport({ periods, d1: d1Fixture(), ga4: ga4Fixture, gsc: gscFixture, now: NOW });

  assert.match(md, /Semana del lunes 05\/10 al domingo 11\/10/);
  // Ventas: MP cobra el total; la transferencia, su monto con descuento.
  assert.match(md, /Pedidos pagados: \*\*2 \(semana anterior: 1, \+1\)\*\*/);
  assert.match(md, /Cobrado: \$ 2\.130 \(semana anterior: \$ 1\.000, \+\$ 1\.130\)/);
  assert.match(md, /Libros vendidos: 3 \(semana anterior: 1, \+2\)/);
  assert.match(md, /Por transferencia confirmada: 1 \(semana anterior: 0, \+1\)/);
  // Pagos: menos de 30 intentos → sin porcentaje.
  assert.match(md, /Intentos: 3 \(semana anterior: 1, \+2\)/);
  assert.match(md, /Aprobados: 1 de 3 \(semana anterior: 1 de 1\)/);
  assert.match(md, /motivos por intento: cc_rejected_insufficient_amount \(2\)/);
  assert.match(md, /Abandonados \(abrió el pago, no pagó y venció\): 1/);
  assert.match(md, /Pendientes hace más de 48 h \(últimos 14 días\): 1 — AL-5/);
  // Demanda.
  assert.match(md, /Pedidos de aviso de stock: 2 \(semana anterior: 0, \+2\), de 1 libro distinto/);
  assert.match(md, /\| harry potter y la orden \| 4 \|/);
  assert.match(md, /Clics a WhatsApp \(GA4\): 7 \(semana anterior: 5, \+2\)/);
  // SEO: con miles de impresiones sí hay porcentaje.
  assert.match(md, /CTR: 1,3 % \(120 de 9\.000\)/);
  assert.match(md, /Bing: sin dato/);
  // Catálogo.
  assert.match(md, /Hoy: 7\.043 publicaciones activas, 6\.512 con stock/);
  assert.match(md, /Altas: 12 \(semana anterior: 5, \+7\)/);
  // Embudo por dispositivo.
  assert.match(md, /\| mobile \| 900 \(1\.000\) \| 400 \| 20 \|/);
});

test('las tres acciones salen de las reglas, en su orden', () => {
  const md = buildWeeklyReport({ periods, d1: d1Fixture(), ga4: ga4Fixture, gsc: gscFixture, now: NOW });
  const block = md.split('## Tres acciones para esta semana')[1].split('## Ventas')[0];
  const lines = block.trim().split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^1\. Escribirle a quien hizo el pedido por transferencia sin confirmar: AL-5/);
  assert.match(lines[1], /^2\. Reponer o conseguir: «El Aleph» \(2 pedidos\)/);
  assert.match(lines[2], /^3\. Cargar el libro o agregar un sinónimo para: «harry potter y la orden» \(4\)/);
  assert.equal(ACTION_RULES.length, 5);
});

test('lo que todavía no se medía dice sin dato, no cero', () => {
  // Las mediciones nuevas arrancaron el miércoles de la semana del informe.
  const d1 = d1Fixture({ since: '2026-10-07T07:20:00.000Z' });
  const md = buildWeeklyReport({ periods, d1, ga4: ga4Fixture, gsc: gscFixture, now: NOW });
  assert.match(md, /Por transferencia confirmada: 1 \(semana anterior: sin dato\) _\(medido desde el 07\/10\)_/);
  assert.match(md, /Búsquedas sin resultados: 5 \(semana anterior: sin dato\)/);

  const none = buildWeeklyReport({ periods, d1: { ...d1Fixture(), sync_first: [{ first: null }] }, ga4: ga4Fixture, gsc: gscFixture, now: NOW });
  assert.match(none, /Búsquedas sin resultados: sin dato \(todavía no se medía\)/);
  assert.match(none, /Cambios de la semana: sin dato/);
  assert.match(none, /Por transferencia confirmada: sin dato/);
});

test('si se caen GA4, Search Console o una tabla, el informe sale igual y lo dice', () => {
  const d1 = { ...d1Fixture(), search_misses: { error: 'no such table: search_misses' } };
  const md = buildWeeklyReport({ periods, d1, ga4: { error: 'GA4 HTTP 403: sin permiso' }, gsc: { error: 'Search Console HTTP 500' }, now: NOW });
  assert.match(md, /GA4: sin dato \(GA4 HTTP 403: sin permiso\)/);
  assert.match(md, /Google: sin dato \(Search Console HTTP 500\)/);
  assert.match(md, /Búsquedas sin resultados: sin dato \(no such table: search_misses\)/);
  assert.match(md, /Clics a WhatsApp \(GA4\): sin dato/);
  assert.match(md, /Pedidos pagados: \*\*2/);

  const empty = buildWeeklyReport({ periods, d1: {}, ga4: null, gsc: null, now: NOW });
  assert.match(empty, /## Ventas\n\nSin dato/);
  assert.match(empty, /Ninguna regla se disparó esta semana\./);
});

test('una transferencia vieja sin monto anotado deja el cobrado en sin dato', () => {
  const d1 = d1Fixture();
  d1.orders[1] = { ...d1.orders[1], paid_amount_uyu: null };
  const md = buildWeeklyReport({ periods, d1, ga4: ga4Fixture, gsc: gscFixture, now: NOW });
  assert.match(md, /Cobrado: sin dato/);
});

test('reglas sueltas: transferencias pendientes y CTR bajo', () => {
  const byOrder = new Map([['a', [event('a', 'transfer_payment_info_viewed', '2026-10-11T12:00:00.000Z', { transfer_total_uyu: 500 })]]]);
  // Hace menos de 48 h: todavía no es pendiente.
  assert.equal(pendingTransfers([order('a', {})], byOrder, NOW).length, 0);
  assert.equal(pendingTransfers([order('a', {})], byOrder, new Date('2026-10-14T12:00:00.000Z')).length, 1);
  assert.deepEqual(ctrOpportunities(gscFixture.current.pages).map(p => p.page), ['https://www.amadolibros.com/libro/MLU1/rayuela']);
});
