import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createReposicionReader, ownStockIndex, REPOSICION_PATH, REPOSICION_AUD } from '../../worker-sync/reposicion-read.js';
import { OPERATIONS_ISSUER } from '../../worker-sync/operations-read.js';
import { SALES_SCHEMA } from '../../worker-sync/ml-sales.js';
import { importPurchases } from '../../worker-sync/purchases.js';
import { readSalesHealth, evaluateSalesHealth } from '../../worker-sync/sales-health.js';

function database(t) {
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close());
  const statement = (sql, args = []) => ({ sql, args, bind(...values) { return statement(sql, values); }, async first() { return sqlite.prepare(sql).get(...args) ?? null; }, async all() { return { results: sqlite.prepare(sql).all(...args) }; }, async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }; } });
  return { prepare: sql => statement(sql), async batch(items) { sqlite.exec('BEGIN'); try { const r = items.map(s => ({ results: sqlite.prepare(s.sql).all(...s.args) })); sqlite.exec('COMMIT'); return r; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } }, sqlite };
}

const NOW = Date.parse('2026-10-24T12:00:00Z');
const ISBN = '9780306406157', ISBN2 = '9788420412146';
const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const publicKey = await crypto.subtle.exportKey('jwk', keys.publicKey);
const b64 = v => Buffer.from(v).toString('base64url');
async function signed(action, args = {}, claims = {}) {
  const data = { v: 1, iss: OPERATIONS_ISSUER, aud: REPOSICION_AUD, seller_id: '440298103', method: 'POST', path: REPOSICION_PATH, iat: NOW / 1000, exp: NOW / 1000 + 60, jti: crypto.randomUUID(), action, args, ...claims };
  const payload = b64(JSON.stringify(data));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, new TextEncoder().encode(payload));
  return new Request('https://w.test' + REPOSICION_PATH, { method: 'POST', headers: { Authorization: `Amado-Signature ${payload}.${b64(sig)}` } });
}

async function fixture(t) {
  const db = database(t);
  await db.batch(SALES_SCHEMA.map(sql => db.prepare(sql)));
  const order = (id, days, qty, item, sku = null, isbn = ISBN) => {
    db.sqlite.prepare('INSERT INTO ml_sales_orders(order_id,seller_id,status,date_created,date_created_ms,last_updated_ms,fetched_at) VALUES(?,?,?,?,?,?,0)').run(String(id), '440298103', 'paid', new Date(NOW - days * 864e5).toISOString(), NOW - days * 864e5, NOW);
    db.sqlite.prepare('INSERT INTO ml_sales_items(order_id,line_key,item_id,title,title_key,seller_sku,quantity,isbn,updated_at) VALUES(?,?,?,?,?,?,?,?,0)').run(String(id), item, item, 'Libro A', 'libroa', sku, qty, isbn);
  };
  order(1, 10, 2, 'MLU1'); order(2, 200, 3, 'MLU2'); order(3, 20, 1, 'MLU9', `AMADO-AR-${ISBN}`); order(4, 5, 4, 'MLU5', null, ISBN2);
  db.sqlite.prepare("INSERT INTO ml_sales_sync_state(name,cursor_json,lease_until,updated_at,last_result_json) VALUES('orders','{\"phase\":\"incremental\"}',0,?,'{\"state\":\"idle\",\"errors_in_row\":0}')").run(NOW - 60000);
  await importPurchases(db, { supplier: 'CELESA', document_number: 'A1', document_date: '2026-10-20', items: [{ isbn: ISBN, title: 'Libro A', quantity: 2 }] }, NOW);
  const catalog = { updated_at: new Date(NOW - 3600000).toISOString(), items: [
    { id: 'MLU1', isbn: ISBN, status: 'active', available_quantity: 0, catalog_listing: false },
    { id: 'MLU2', isbn: ISBN, status: 'active', available_quantity: 0, catalog_listing: true },
    { id: 'MLU5', isbn: ISBN2, status: 'active', available_quantity: 3, catalog_listing: false },
  ] };
  const env = { ORDERS_DB: db, CATALOG_R2: { async get(key) { return key === 'catalog.json' ? { json: async () => catalog } : null; } } };
  return { db, env, read: createReposicionReader({ now: () => NOW, publicKey }) };
}

test('stock propio: propia y de catálogo comparten ejemplar (máximo), pausadas valen 0', () => {
  const idx = ownStockIndex({ items: [{ id: 'A', isbn: ISBN, status: 'active', available_quantity: 2 }, { id: 'B', isbn: ISBN, status: 'active', available_quantity: 2, catalog_listing: true }, { id: 'C', isbn: ISBN2, status: 'paused', available_quantity: 5 }] });
  assert.equal(idx.get(ISBN).stock_propio, 2);
  assert.equal(idx.get(ISBN2).stock_propio, 0);
});

test('hechos por ISBN: ventas propio/encargo, compras, stock y banderas', async t => {
  const { env, read } = await fixture(t);
  const res = await read(await signed('reposicion_hechos', { isbns: [ISBN] }), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.read_only, true);
  const r = body.data.resultados[0];
  assert.equal(r.stock_propio, 0);
  assert.deepEqual(r.ventas.propio, { d30: 2, d90: 2, d180: 2, d365: 5 });
  assert.equal(r.ventas.encargo_sbs.d30, 1);
  assert.equal(r.compras.en_transito_estimado, 2);
  assert.equal(r.plazo_entrega_dias, 15);
  // Sin cobertura de compras cargada no se puede afirmar nada sobre compras… pero este ISBN sí tiene compras.
  assert.ok(!r.fuente_incompleta.some(f => f.startsWith('compras_no_cargadas')));
  assert.equal(r.sbs.disponible, 'desconocida');
  assert.deepEqual(body.data.cobertura_faltante, ['CELESA', 'ARNOIA', 'CASASSA_Y_LORENZO', 'AMAZON_COM']);
});

test('ISBN sin compras y sin cobertura cargada → FUENTE INCOMPLETA', async t => {
  const { env, read } = await fixture(t);
  const r = (await (await read(await signed('reposicion_hechos', { isbns: [ISBN2] }), env)).json()).data.resultados[0];
  assert.equal(r.estado_datos, 'FUENTE INCOMPLETA');
  assert.ok(r.fuente_incompleta[0].startsWith('compras_no_cargadas'));
});

test('candidatos: ISBN con ventas propias y stock ≤1, ordenados por ventas recientes', async t => {
  const { env, read } = await fixture(t);
  const body = await (await read(await signed('candidatos', { limite: 10 }), env)).json();
  assert.deepEqual(body.data.resultados.map(r => r.isbn), [ISBN]);
});

test('firma: aud equivocado, vencida o jti repetido se rechazan; acción desconocida 400', async t => {
  const { env, read } = await fixture(t);
  assert.equal((await read(await signed('estado', {}, { aud: 'amado-mercadolibre-read' }), env)).status, 401);
  assert.equal((await read(await signed('estado', {}, { exp: NOW / 1000 - 1, iat: NOW / 1000 - 30 }), env)).status, 401);
  const req = await signed('estado');
  assert.equal((await read(req.clone(), env)).status, 200);
  assert.equal((await read(req, env)).status, 409);
  assert.equal((await read(await signed('borrar_todo'), env)).status, 400);
  assert.equal((await read(await signed('reposicion_hechos', { isbns: [], extra: 1 }), env)).status, 400);
});

test('salud: sync parado o errores seguidos son problemas; sin datos es nota', async t => {
  const db = database(t);
  assert.deepEqual(evaluateSalesHealth(await readSalesHealth(db), NOW).problemas, []);
  const h = { sales: { updated_at: NOW - 3 * 3600000, cursor: { phase: 'incremental', inc_filter: { name: null } }, last: { errors_in_row: 4, code: 'ml_http_401' }, last_order: '2026-10-20' }, purchases: { documents: 0 } };
  const out = evaluateSalesHealth(h, NOW);
  assert.equal(out.problemas.length, 2);
  assert.ok(out.notas.some(n => n.includes('barrido semanal')));
});

import { createReposicionPanel } from '../panel/reposicion.js';
import { createReposicionFacts } from '../../worker-sync/reposicion-facts.js';
import { createSessionToken, deriveSessionSecret, sessionCookieHeader } from '../_shared/panel-auth.js';

test('panel de reposición: exige sesión y muestra candidatos, búsqueda por ISBN y por título', async t => {
  const { db, env: wenv } = await fixture(t);
  const catalogLoader = async () => (await wenv.CATALOG_R2.get('catalog.json')).json();
  const panel = createReposicionPanel({ factsFactory: () => createReposicionFacts({ now: () => NOW, loadCatalog: catalogLoader }) });
  const env = { APP_ENV: 'production', PANEL_PASSWORD: 'una-clave-larga', ORDERS_DB: db };
  const noSession = await panel({ request: new Request('https://www.amadolibros.com/panel/reposicion'), env });
  assert.equal(noSession.status, 303);
  const cookie = sessionCookieHeader(await createSessionToken(await deriveSessionSecret(env.PANEL_PASSWORD))).split(';')[0];
  const get = async q => { const r = await panel({ request: new Request('https://www.amadolibros.com/panel/reposicion' + q, { headers: { cookie } }), env }); return { status: r.status, html: await r.text() }; };
  const cand = await get('');
  assert.equal(cand.status, 200);
  assert.match(cand.html, /Candidatos a reponer/);
  assert.match(cand.html, new RegExp(ISBN));
  assert.match(cand.html, /Fuente incompleta|Revisar|Listo para decidir/);
  assert.match(cand.html, /Celesa/);
  const byIsbn = await get('?q=' + ISBN2);
  assert.match(byIsbn.html, /Búsqueda por ISBN/);
  assert.match(byIsbn.html, /Sin compras registradas/);
  const byTitle = await get('?q=Libro%20A');
  assert.match(byTitle.html, /Búsqueda por título/);
  assert.ok(!/<script/i.test(cand.html));
});
