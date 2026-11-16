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

test('el informe muestra el embudo, los pedidos sin pagar y el tráfico que parece automático, y oculta las búsquedas de prueba', () => {
  const md = buildActivityReport({
    periods,
    ga4: {
      yesterday: day({ cities: [{ city: 'Montevideo', sessions: 90 }, { city: 'Beijing', sessions: 3 }, { city: 'Harbin', sessions: 2 }] }),
      lastWeek: day(),
    },
    d1: { ...d1, search_misses: [{ query: 'zzzinexistente999', count: 4 }, { query: 'harry potter', count: 3 }] },
  });
  assert.match(md, /Embudo del día\*\*: 210 abrieron una ficha → 9 agregaron al carrito → 0 crearon un pedido \(de 140 visitas\)/);
  assert.match(md, /Posible tráfico automático \(ciudades de centros de datos\): 5 visitas — Beijing 3 · Harbin 2/);
  assert.match(md, /\*\*Para seguir hoy\*\*/);
  assert.match(md, /\| AL-2 \| Ficciones \| \$ 1\.000 \| retiro \|/);
  assert.doesNotMatch(md, /zzzinexistente/);
  assert.match(md, /«harry potter» \(3\)/);
});

test('con pocas visitas no hay embudo y sin pedidos abiertos no hay «para seguir hoy»', () => {
  const few = day({ totals: [{ sessions: 12, totalUsers: 10, newUsers: 5, screenPageViews: 30 }] });
  const md = buildActivityReport({ periods, ga4: { yesterday: few, lastWeek: few }, d1: { ...d1, orders: [d1.orders[0]] } });
  assert.doesNotMatch(md, /Embudo del día/);
  assert.doesNotMatch(md, /Para seguir hoy/);
});

// Cruce entre canales: lo que miraron en la web contra Mercado Libre, WhatsApp y la web.
import { airtableRows, buildCross, fetchAirtablePedidos, sameTitle } from '../daily/cross-sales.mjs';

test('la semana del cruce son los 7 días hasta ayer, y sus consultas no leen datos personales', () => {
  assert.equal(periods.week.startDate, '2026-09-28');
  assert.equal(periods.week.endDate, '2026-10-04');
  assert.equal(periods.week.endIso, '2026-10-05T03:00:00.000Z');
  const queries = dailyQueries(periods);
  assert.match(queries.ml_sales_week, /ml_sales_items/);
  assert.match(queries.web_orders_week, /order_items/);
  for (const sql of [queries.ml_sales_week, queries.web_orders_week]) {
    assert.doesNotMatch(sql, /buyer|phone|email|address|nickname/i);
  }
});

test('mismo libro por título: tolera tildes y palabras de relleno, no confunde libros distintos', () => {
  assert.equal(sameTitle('Gold Foil Tarot - Edición Especial', 'Gold Foil Tarot'), true);
  assert.equal(sameTitle('Biblia Católica Para Jóvenes Última Edición Tapa Dura', 'La biblia catolica para jovenes'), true);
  assert.equal(sameTitle('Psicofarmacologia Practica - Gabriela Jufe - 3era Edición', 'Psicofarmacología Práctica Gabriela Jufe 5ta Edición'), true);
  assert.equal(sameTitle('Biblia Rvr1960 Letra Grande Rosa Floral', 'Biblia De Jerusalén Manual'), false);
  assert.equal(sameTitle('Tarot', 'Tarot de Marsella'), false);
});

test('el cruce junta vistas web con ventas de ML, consultas de Airtable y pedidos web', () => {
  const cross = buildCross({
    webItems: [
      { itemId: 'MLU111', itemName: 'Gold Foil Tarot - Edición Especial', itemsViewed: 4, itemsAddedToCart: 1 },
      { itemId: 'MLU222', itemName: 'Psicofarmacologia Practica - Gabriela Jufe', itemsViewed: 2, itemsAddedToCart: 0 },
      { itemId: 'MLU333', itemName: 'Deleuze Y La Brujería', itemsViewed: 1, itemsAddedToCart: 0 },
      { itemId: '(not set)', itemName: '(not set)', itemsViewed: 9, itemsAddedToCart: 0 },
    ],
    mlSales: [{ item_id: 'MLU111', title: 'Gold Foil Tarot Edición Especial', isbn: '9780738772011', quantity: 2, last_date: '2026-10-03T14:00:00.000-03:00' }],
    webOrders: [{ product_id: 'MLU333', title: 'Deleuze Y La Brujería', quantity: 1, paid: 0 }],
    airtable: [
      { title: 'Psicofarmacología Práctica Gabriela Jufe 5ta Edición', isbn: '', estado: 'PASADO AL CLIENTE', canal: 'WhatsApp', fecha: '2026-10-02T17:22:00.000Z' },
      { title: 'Tarot dorado', isbn: '9780738772011', estado: 'entregado', canal: 'Instagram', fecha: '2026-09-30T10:00:00.000Z' },
    ],
  });
  assert.equal(cross.total, 3);
  assert.equal(cross.soldMl, 1);
  assert.equal(cross.askedWa, 2);
  assert.equal(cross.boughtWa, 1);
  assert.equal(cross.orderedWeb, 1);
  const gold = cross.rows.find(r => r.title.startsWith('Gold'));
  assert.equal(gold.ml, '2 vendidos (último 03/10)');
  // Encontrado por el ISBN de la venta en Mercado Libre, aunque el título no coincida.
  assert.equal(gold.wa, 'compró por Instagram 30/09');
  assert.equal(cross.rows.find(r => r.title.startsWith('Psico')).wa, 'PASADO AL CLIENTE por WhatsApp 02/10');
  assert.equal(cross.rows.find(r => r.title.startsWith('Deleuze')).web, '1 pedido (sin pagar)');
});

test('el informe muestra el cruce, y dice sin dato cuando falta una fuente', () => {
  const md = buildActivityReport({
    periods,
    ga4: { yesterday: day(), lastWeek: day(), weekItems: [{ itemId: 'MLU1', itemName: 'Rayuela', itemsViewed: 5, itemsAddedToCart: 0 }] },
    d1: { ...d1, ml_sales_week: [{ item_id: 'MLU1', title: 'Rayuela', quantity: 1, last_date: '2026-10-02T10:00:00.000-03:00' }], web_orders_week: [] },
    airtable: { error: 'Airtable HTTP 403: sin permiso' },
  });
  assert.match(md, /## Cruce: lo que miraron en la web y dónde terminó/);
  assert.match(md, /del lunes 28\/09 al domingo 04\/10/);
  assert.match(md, /De 1 libros mirados: \*\*1 se vendieron en Mercado Libre\*\*/);
  assert.match(md, /\| Rayuela \| 5 \| 0 \| — \| 1 vendido \(último 02\/10\) \| — \|/);
  assert.match(md, /WhatsApp\/Airtable sin dato \(Airtable HTTP 403: sin permiso\)/);
  const sinGa4 = buildActivityReport({ periods, ga4: { error: 'x' }, d1: {} });
  assert.match(sinGa4, /## Cruce: lo que miraron en la web y dónde terminó\n\nSin dato de GA4/);
});

test('Airtable: lee solo título, ISBN, estado, canal y fecha, y pagina', async () => {
  const urls = [];
  const pages = [
    { records: [{ fields: { 'Título': 'Rayuela', ISBN: 9788437604572, Estado: { name: 'entregado' }, Canal: { name: 'WhatsApp' }, 'Fecha consulta': '2026-10-01T10:00:00.000Z' } }], offset: 'p2' },
    { records: [{ fields: { 'Título': 'Ficciones', Estado: 'cotizado' } }, { fields: {} }] },
  ];
  const fetchImpl = async url => { urls.push(url); const body = pages.shift(); return { ok: true, json: async () => body }; };
  const rows = await fetchAirtablePedidos({ token: 't', sinceDate: '2026-09-28', fetchImpl });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { title: 'Rayuela', isbn: '9788437604572', estado: 'entregado', canal: 'WhatsApp', fecha: '2026-10-01T10:00:00.000Z' });
  assert.equal(urls.length, 2);
  assert.match(decodeURIComponent(urls[0]), /fields\[\]=Título/);
  assert.doesNotMatch(decodeURIComponent(urls[0]), /Cliente|Teléfono|Nombre/);
  assert.match(urls[1], /offset=p2/);
  assert.deepEqual(await fetchAirtablePedidos({ token: '', sinceDate: '2026-09-28' }), { error: 'falta AIRTABLE_TOKEN' });
  assert.deepEqual(airtableRows([{ fields: { 'Título': '' } }]), []);
});
