import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { parseWaRef, onRequestPost, WA_REFS_SCHEMA } from '../api/wa-ref.js';
import { faviconHeadHtml } from '../_shared/brand.js';

const script = readFileSync(new URL('../../astro-front/public/wa-ref.js', import.meta.url), 'utf8');

function browser(search = '', pathname = '/libro/MLU123/x') {
  const store = new Map();
  const listeners = {};
  const beacons = [];
  const window = {
    location: { href: `https://www.amadolibros.com${pathname}${search}`, search, pathname },
    localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) },
    crypto: { getRandomValues: a => { for (let i = 0; i < a.length; i++) a[i] = i * 7; return a; } },
  };
  const document = { addEventListener: (n, h) => { listeners[n] = h; } };
  const navigator = { sendBeacon: (url, blob) => { beacons.push({ url, blob }); return true; } };
  runInNewContext(script, { window, document, navigator, URL, URLSearchParams, Uint8Array, JSON, Date, Math, Blob, String, Number });
  return { window, listeners, beacons, store };
}

test('wa-ref: agrega el código al mensaje de WhatsApp y avisa con el gclid guardado', async () => {
  const b = browser('?gclid=Cj0KCQiA_prueba-123&utm_source=google&utm_campaign=shopping');
  const anchor = { href: 'https://wa.me/59899841325?text=' + encodeURIComponent('Hola\nLibro: X'), getAttribute: () => 'MLU123' };
  b.listeners.click({ target: { closest: () => anchor } });
  const text = new URL(anchor.href).searchParams.get('text');
  assert.match(text, /^Hola\nLibro: X\n\nCódigo: AL-[A-Z2-9]{4}$/);
  assert.equal(b.beacons.length, 1);
  const sent = JSON.parse(await b.beacons[0].blob.text());
  assert.equal(sent.click_id, 'Cj0KCQiA_prueba-123');
  assert.equal(sent.click_id_type, 'gclid');
  assert.equal(sent.product_id, 'MLU123');
  assert.equal(sent.ref, text.slice(-7));
});

test('wa-ref: no toca enlaces que no son de WhatsApp y no duplica el código', () => {
  const b = browser();
  const other = { href: 'https://www.amadolibros.com/catalogo', getAttribute: () => '' };
  b.listeners.click({ target: { closest: () => other } });
  assert.equal(other.href, 'https://www.amadolibros.com/catalogo');
  assert.equal(b.beacons.length, 0);
  const again = b.window.AmadoWaRef.withCode('https://wa.me/1?text=' + encodeURIComponent('Hola\n\nCódigo: AL-AAAA'), 'AL-BBBB');
  assert.equal(new URL(again).searchParams.get('text'), 'Hola\n\nCódigo: AL-BBBB');
});

test('wa-ref API: valida y descarta lo que no corresponde', () => {
  assert.equal(parseWaRef({ ref: 'XX-1234' }), null);
  const row = parseWaRef({ ref: 'AL-7K2Q', page: '/libro/MLU1/x', product_id: 'mlu1', click_id: 'bad id!', click_id_type: 'gclid', utm_source: 'google<script>' });
  assert.equal(row.ref, 'AL-7K2Q');
  assert.equal(row.product_id, 'MLU1');
  assert.equal(row.click_id, '', 'gclid inválido no se guarda');
  assert.equal(row.utm_source, 'googlescript');
  assert.equal(parseWaRef({ ref: 'AL-7K2Q', page: 'https://otro.com' }).page, '');
});

test('wa-ref API: guarda en D1 una vez por código', async () => {
  const sqlite = new DatabaseSync(':memory:');
  const stmt = (sql, args = []) => ({ bind: (...v) => stmt(sql, v), run: async () => sqlite.prepare(sql).run(...args) });
  const db = { prepare: sql => stmt(sql) };
  const req = body => new Request('https://www.amadolibros.com/api/wa-ref', { method: 'POST', body: JSON.stringify(body) });
  const body = { ref: 'AL-7K2Q', page: '/regalos', click_id: 'Cj0KCQiA_prueba-123', click_id_type: 'gclid' };
  assert.equal((await onRequestPost({ request: req(body), env: { ORDERS_DB: db } })).status, 204);
  assert.equal((await onRequestPost({ request: req(body), env: { ORDERS_DB: db } })).status, 204);
  const rows = sqlite.prepare('SELECT ref, page, click_id FROM wa_refs').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].click_id, 'Cj0KCQiA_prueba-123');
  assert.equal((await onRequestPost({ request: req({ ref: 'nada' }), env: { ORDERS_DB: db } })).status, 400);
  assert.match(WA_REFS_SCHEMA, /CREATE TABLE IF NOT EXISTS wa_refs/);
});

test('wa-ref: el script se carga en las páginas del servidor', () => {
  assert.match(faviconHeadHtml(), /\/wa-ref\.js/);
});
