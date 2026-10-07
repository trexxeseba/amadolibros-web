// Informe diario: «Qué pasó ayer en la web».
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildActivityReport } from '../daily/build-activity.mjs';
import { dailyPeriods, dailyQueries } from '../daily/fetch-activity.mjs';

// Lunes 05/10/2026 08:37 en Montevideo: «ayer» es el domingo 04/10.
const NOW = new Date('2026-10-05T11:37:00.000Z');
const periods = dailyPeriods(NOW);

test('ayer y el mismo día de la semana anterior, en hora de Montevideo', () => {
  assert.equal(periods.yesterday.date, '2026-10-04');
  assert.equal(periods.yesterday.startIso, '2026-10-04T03:00:00.000Z');
  assert.equal(periods.yesterday.endIso, '2026-10-05T03:00:00.000Z');
  assert.equal(periods.lastWeek.date, '2026-09-27');
  // A las 01:00 de Montevideo (04:00 UTC) «ayer» ya es el día anterior local.
  assert.equal(dailyPeriods(new Date('2026-10-05T04:00:00.000Z')).yesterday.date, '2026-10-04');
  assert.equal(dailyPeriods(new Date('2026-10-05T02:00:00.000Z')).yesterday.date, '2026-10-03');
});

test('las consultas del día no leen datos personales', () => {
  const sql = Object.values(dailyQueries(periods)).join('\n');
  for (const column of ['buyer_name', 'buyer_phone', 'buyer_email', 'address', 'email', 'locality']) {
    assert.doesNotMatch(sql, new RegExp(`\\b${column}\\b`), column);
  }
});

const day = (overrides = {}) => ({
  totals: [{ sessions: 140, totalUsers: 120, newUsers: 90, screenPageViews: 610 }],
  pages: [
    { pagePath: '/', pageTitle: 'Amado Libros', screenPageViews: 200 },
    { pagePath: '/catalogo', pageTitle: 'Catálogo', screenPageViews: 150 },
    { pagePath: '/catalogo?q=tarot', pageTitle: 'Catálogo', screenPageViews: 50 },
    { pagePath: '/libro/MLU1/rayuela', pageTitle: 'Rayuela — Julio Cortázar | Amado Libros', screenPageViews: 40 },
  ],
  landing: [{ landingPage: '/', sessions: 60 }, { landingPage: '/libro/MLU1/rayuela', sessions: 20 }],
  channels: [{ sessionDefaultChannelGroup: 'Organic Search', sessions: 80 }, { sessionDefaultChannelGroup: 'Direct', sessions: 40 }],
  sources: [{ sessionSource: 'google', sessions: 78 }, { sessionSource: '(direct)', sessions: 40 }, { sessionSource: 'instagram.com', sessions: 9 }],
  devices: [{ deviceCategory: 'mobile', sessions: 100 }, { deviceCategory: 'desktop', sessions: 40 }],
  cities: [{ city: 'Montevideo', sessions: 90 }, { city: '(not set)', sessions: 10 }, { city: 'Salto', sessions: 5 }],
  items: [{ itemName: 'Rayuela', itemsViewed: 40, itemsAddedToCart: 3 }],
  events: [
    { eventName: 'view_item', eventCount: 210 }, { eventName: 'add_to_cart', eventCount: 9 },
    { eventName: 'whatsapp_click', eventCount: 6 }, { eventName: 'checkout_error', eventCount: 2 },
  ],
  ...overrides,
});

const d1 = {
  orders: [
    { id: 'o1', public_code: 'AL-1', status: 'paid', payment_status: 'approved', payment_provider: 'mercadopago', delivery_type: 'shipping', department: 'Canelones', payable_total_uyu: 2160, paid_amount_uyu: 2160, created_at: '2026-10-04T15:00:00.000Z', paid_at: '2026-10-04T15:05:00.000Z' },
    { id: 'o2', public_code: 'AL-2', status: 'open', payment_status: 'not_started', payment_provider: null, delivery_type: 'pickup', department: null, payable_total_uyu: 1000, paid_amount_uyu: null, created_at: '2026-10-04T18:00:00.000Z', paid_at: null },
  ],
  items: [{ order_id: 'o1', title: 'Rayuela', quantity: 2 }, { order_id: 'o2', title: 'Ficciones', quantity: 1 }],
  events: [{ order_id: 'o2', event_type: 'transfer_payment_info_viewed' }],
  waitlist: [{ product_title: 'El Aleph', created_at: '2026-10-04T12:00:00.000Z' }],
  search_misses: [{ query: 'harry potter', count: 3 }],
};

test('cuenta visitas, qué miraron, de dónde vinieron, qué hicieron y los pedidos', () => {
  const md = buildActivityReport({ periods, ga4: { yesterday: day(), lastWeek: day({ totals: [{ sessions: 100, totalUsers: 90, newUsers: 70, screenPageViews: 500 }], channels: [{ sessionDefaultChannelGroup: 'Organic Search', sessions: 60 }] }) }, d1 });
  assert.match(md, /Ayer, \*\*domingo 04\/10\*\*\. Entre paréntesis, la diferencia con el domingo 27\/09/);
  assert.match(md, /Visitas: \*\*140 \(\+40\)\*\*/);
  assert.match(md, /de las cuales 90 llegaron por primera vez/);
  // El catálogo con distintos filtros se junta en una fila.
  assert.match(md, /\| Catálogo \| 200 \|/);
  assert.match(md, /\| Portada \| 200 \|/);
  assert.match(md, /\| Rayuela — Julio Cortázar \| 40 \|/);
  assert.match(md, /\| Rayuela \| 40 \| 3 \|/);
  assert.match(md, /\| Página de entrada \| Visitas \|\n\| --- \| --- \|\n\| Portada \| 60 \|\n\| Rayuela — Julio Cortázar \| 20 \|/);
  assert.match(md, /\| Google y otros buscadores \| 80 \| 60 \|/);
  assert.match(md, /Sitios concretos: google \(78\), instagram\.com \(9\)/);
  assert.match(md, /Dispositivo: Celular 100 · Computadora 40/);
  assert.match(md, /Ciudades: Montevideo 90 · Salto 5/);
  assert.match(md, /Clics a WhatsApp: 6 \(igual\)/);
  assert.match(md, /Errores en el checkout: 2 ⚠️/);
  assert.match(md, /Pidieron aviso de stock: 1 — El Aleph/);
  assert.match(md, /Buscaron y no encontraron: «harry potter» \(3\)/);
  assert.match(md, /Pedidos creados: 2 · Pagados ayer: 1 · Cobrado: \$ 2\.160/);
  assert.match(md, /\| AL-1 \| 2× Rayuela \| \$ 2\.160 \| Mercado Pago \| pagado · envío a Canelones \|/);
  assert.match(md, /\| AL-2 \| Ficciones \| \$ 1\.000 \| Transferencia \(eligió\) \| sin pagar · retiro \|/);
});

test('sin GA4 ni base, el correo sale igual y dice sin dato', () => {
  const md = buildActivityReport({ periods, ga4: { error: 'GA4 HTTP 403: sin permiso' }, d1: { orders: { error: 'no such table: orders' } } });
  assert.match(md, /Sin dato de GA4 \(GA4 HTTP 403: sin permiso\)/);
  assert.match(md, /Clics a WhatsApp: sin dato/);
  assert.match(md, /## Pedidos de ayer\n\nSin dato \(no such table: orders\)/);
});

test('un día sin pedidos lo dice en vez de mostrar una tabla vacía', () => {
  const md = buildActivityReport({ periods, ga4: { yesterday: day(), lastWeek: day() }, d1: { ...d1, orders: [], search_misses: [] } });
  assert.match(md, /Ningún pedido nuevo ni pago ayer\./);
  assert.match(md, /Búsquedas sin resultados: ninguna/);
});
