import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  REGALOS,
  REGALOS_GROUPS,
  regalosListIds,
  selectRegalos,
  groupRegalos,
  navidadEstado,
  diasHasta,
} from '../_shared/regalos.js';
import REGALOS_DATA from '../_shared/regalos-data.js';
import { onRequest, navidadHtml } from '../regalos.js';
import { SITE_HEADER_NAV } from '../_shared/site-header.js';
import { STATIC_SITEMAP_PAGES } from '../sitemap-pages.xml.js';

const UY = iso => Date.parse(`${iso}T12:00:00-03:00`);

test('regalos: el módulo generado coincide con data/regalos.json y tiene ids MLU únicos', () => {
  const json = JSON.parse(readFileSync(new URL('../../data/regalos.json', import.meta.url), 'utf8'));
  assert.deepEqual(REGALOS_DATA.lista.ids, json.lista.ids);
  const ids = regalosListIds();
  assert.ok(ids.length >= 50, `lista corta: ${ids.length}`);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^MLU\d+$/);
});

test('regalos: entra solo lo listado, activo y con stock', () => {
  const [a, b, c] = regalosListIds();
  const items = [
    { id: a, status: 'active', available_quantity: 1, price: 3000, title: 'A' },
    { id: b, status: 'paused', available_quantity: 1, price: 3000, title: 'B' },
    { id: c, status: 'active', available_quantity: 0, price: 3000, title: 'C' },
    { id: 'MLU1', status: 'active', available_quantity: 5, price: 9000, title: 'No listado' },
    { id: a, status: 'active', available_quantity: 1, price: 3000, title: 'A repetido' },
  ];
  assert.deepEqual(selectRegalos(items).map(i => i.title), ['A']);
  assert.deepEqual(selectRegalos(null), []);
});

test('regalos: agrupa por para quién, ordena por precio y manda el resto a Más ideas', () => {
  const cat = { 1: 'literatura-ficcion', 2: 'comics-manga', 3: 'medicina-salud', 4: 'literatura-ficcion' };
  const sel = [
    { id: 1, price: 3000, title: 'b' }, { id: 2, price: 4000, title: 'c' }, { id: 3, price: 5000, title: 'd' }, { id: 4, price: 6000, title: 'a' },
  ];
  const groups = groupRegalos(sel, id => cat[id]);
  assert.deepEqual(groups.map(g => g.id), ['literatura', 'comics', 'mas']);
  assert.deepEqual(groups[0].items.map(i => i.id), [4, 1]);
  assert.ok(REGALOS_GROUPS.every(g => g.categories.length > 0));
});

test('regalos: fechas de Navidad (Montevideo 23/12, interior 18/12) y apagado después', () => {
  assert.equal(REGALOS.navidad.montevideoHasta, '2026-12-23');
  assert.equal(REGALOS.navidad.interiorHasta, '2026-12-18');
  assert.equal(navidadEstado(UY('2026-11-21')), 'ambas');
  assert.equal(navidadEstado(UY('2026-12-18')), 'ambas');
  assert.equal(navidadEstado(UY('2026-12-19')), 'montevideo');
  assert.equal(navidadEstado(UY('2026-12-23')), 'montevideo');
  assert.equal(navidadEstado(UY('2026-12-24')), 'ninguna');
  assert.equal(navidadEstado(UY('2027-01-05')), 'ninguna');
  assert.equal(diasHasta('2026-12-23', UY('2026-12-21')), 2);
  assert.equal(diasHasta('2026-12-23', UY('2026-12-23')), 0);
  const html = navidadHtml(UY('2026-12-01'));
  assert.match(html, /23 de diciembre/);
  assert.match(html, /18 de diciembre/);
  assert.equal(navidadHtml(UY('2026-12-26')), '');
  assert.ok(!/únicamente|sólo/i.test(html));
});

test('regalos: la página responde con los libros listados y enlaza a WhatsApp con el título', async () => {
  const [a, b] = regalosListIds();
  const items = [
    { id: a, status: 'active', available_quantity: 1, price: 3500, title: 'Estuche Prueba Uno', author: 'Autora X', thumbnail: 'http://x/a-I.jpg' },
    { id: b, status: 'active', available_quantity: 3, price: 2800, title: 'Cómic Prueba Dos', thumbnail: 'http://x/b-I.jpg' },
  ];
  const categories = { items: { [a]: [['literatura-ficcion', 1]], [b]: [['comics-manga', 1]] }, categories: [] };
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  globalThis.caches = { default: { match: async () => null, put: async () => {} } };
  globalThis.fetch = async url => {
    const u = String(url);
    if (u.includes('active-categories.json')) return new Response(JSON.stringify(categories), { headers: { 'content-type': 'application/json' } });
    if (u.includes('catalog.json')) return new Response(JSON.stringify({ items }), { headers: { 'content-type': 'application/json' } });
    return new Response('nope', { status: 404 });
  };
  try {
    const res = await onRequest({ request: new Request('https://www.amadolibros.com/regalos'), env: {}, waitUntil() {} });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-regalos-total'), '2');
    const html = await res.text();
    assert.match(html, /Estuche Prueba Uno/);
    assert.match(html, /Último ejemplar/);
    assert.match(html, /wa\.me\/59899841325\?text=/);
    assert.match(html, /Estuche%20Prueba%20Uno|Estuche\+Prueba\+Uno/);
    assert.match(html, /data-cta-location="regalos_card"/);
    assert.match(html, /id="literatura"/);
    assert.match(html, /id="comics"/);
    assert.ok(!/únicamente|sólo/i.test(html));
    assert.ok(!/aggregateRating/i.test(html));
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
  }
});

test('regalos: está en la navegación y en el sitemap', () => {
  assert.ok(SITE_HEADER_NAV.some(i => i.href === '/regalos'));
  assert.ok(STATIC_SITEMAP_PAGES.includes('https://www.amadolibros.com/regalos'));
});
