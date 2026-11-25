import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { buildSales, onRequest } from '../api/prueba-social.js';
import {
  PRUEBA_SOCIAL_REVIEWS,
  reviewSnippet,
  relativeDays,
  pruebaSocialHtml,
  pruebaSocialScript,
} from '../../shared/prueba-social.js';
import { GOOGLE_REVIEWS } from '../../shared/google-reviews.js';

const NOW = Date.parse('2026-11-18T12:00:00Z');
const D = 86400000;

test('buildSales: deduplica títulos, calcula días y descarta fechas futuras', () => {
  const out = buildSales(
    [
      { title: 'Libro A', date_created_ms: NOW - 2 * D },
      { title: 'libro a', date_created_ms: NOW - 5 * D },
      { title: 'Libro B', date_created_ms: NOW - 1000 },
      { title: '', date_created_ms: NOW },
      { title: 'Futuro', date_created_ms: NOW + 10 * D },
    ],
    NOW,
  );
  assert.deepEqual(out, [{ titulo: 'Libro A', dias: 2 }, { titulo: 'Libro B', dias: 0 }]);
});

test('API: solo expone título y días, solo ventas pagas de los últimos 14 días', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE ml_sales_orders(order_id TEXT, status TEXT, date_created_ms INTEGER);
    CREATE TABLE ml_sales_items(order_id TEXT, title TEXT, unit_price REAL);`);
  const ins = (id, st, ms, title) => {
    sqlite.prepare('INSERT INTO ml_sales_orders VALUES (?,?,?)').run(id, st, ms);
    sqlite.prepare('INSERT INTO ml_sales_items VALUES (?,?,?)').run(id, title, 999);
  };
  const real = Date.now();
  ins('1', 'paid', real - D, 'Reciente');
  ins('2', 'cancelled', real - D, 'Cancelada');
  ins('3', 'paid', real - 40 * D, 'Vieja');
  const stmt = (sql, args = []) => ({
    bind: (...v) => stmt(sql, v),
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  const res = await onRequest({ env: { ORDERS_DB: { prepare: (s) => stmt(s) } } });
  const body = await res.json();
  assert.deepEqual(body, { ventas: [{ titulo: 'Reciente', dias: 1 }] });
  assert.ok(!JSON.stringify(body).includes('999'), 'sin montos');
});

test('API: sin base o con error responde lista vacía', async () => {
  assert.deepEqual(await (await onRequest({ env: {} })).json(), { ventas: [] });
  const broken = { prepare: () => { throw new Error('x'); } };
  assert.deepEqual(await (await onRequest({ env: { ORDERS_DB: broken } })).json(), { ventas: [] });
});

test('reseñas del cartel: son las de Google, cortas y terminan en palabra', () => {
  assert.equal(PRUEBA_SOCIAL_REVIEWS.length, GOOGLE_REVIEWS.length);
  for (const r of PRUEBA_SOCIAL_REVIEWS) assert.ok(r.text.length <= 125, r.name);
  assert.equal(reviewSnippet('Corta.'), 'Corta.');
  assert.ok(reviewSnippet('palabra '.repeat(40)).endsWith('…'));
});

test('relativeDays: hoy, ayer, hace N días', () => {
  assert.equal(relativeDays(0), 'hoy');
  assert.equal(relativeDays(1), 'ayer');
  assert.equal(relativeDays(4), 'hace 4 días');
});

test('script: es JS válido, no inventa nombres y evita pantallas de pago', () => {
  assert.doesNotThrow(() => new Function(pruebaSocialScript()));
  const html = pruebaSocialHtml();
  assert.ok(html.includes('/api/prueba-social'));
  assert.ok(/carrito\|checkout\|pago/.test(pruebaSocialScript()));
  assert.ok(!/ld\+json|aggregateRating/i.test(html));
  assert.ok(!/únicamente|sólo/i.test(html));
});

test('las fichas, los pedidos por encargo y el pago no crean avisos ni consultan ventas', () => {
    for (const pathname of ['/libro/MLU1/un-libro', '/pedir-libro', '/carrito', '/checkout', '/pago']) {
        // Si el script continúa necesitaría document, fetch o temporizadores.
        assert.doesNotThrow(() => runInNewContext(pruebaSocialScript(), { location: { pathname } }), pathname);
    }
});
