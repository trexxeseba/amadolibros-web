// Sustituye el contrato visual del Finder retirado por pedido de Seba.
import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from '../libros/[[path]].js';
import { CATALOG_URL, PRODUCTION_MANIFEST_URL, PAUSED_MANIFEST_URL, R2_BASE } from '../_shared/catalog.js';
import { orderCategoryItems } from '../_shared/category-order.js';
import { fetchCategoryDates, CATEGORY_DATES_CACHE_URL } from '../_shared/category-dates.js';
import { TAROT_MERCH_TAGS } from '../_shared/tarot-merch-tags.js';
import { buildTagLookup } from '../_shared/tarot-hub-modules.js';
import { SEO_CATEGORIES } from '../_shared/seo-categories.js';

let items;
const realIds = ['MLU608201824', 'MLU643087668', 'MLU804612402'];
const lookup = buildTagLookup(TAROT_MERCH_TAGS);
const physicalIds = [...new Set([...realIds.slice(0, 2), ...TAROT_MERCH_TAGS.flatMap(tag => [tag.id, ...(tag.duplicate_mlu_ids || [])])])].filter(id => { const t = lookup(id); return t?.format === 'mazo' && !t.needs_review && ['tarot', 'oraculo', 'lenormand', 'kipper'].includes(t.primary_type); });
const categoryData = () => ({
  categories: [{ id: 'esoterismo-tarot', name: 'Esoterismo y tarot', count: items.length, subcategories: [{ id: 'tarot-oraculos', name: 'Tarot y oráculos', count: items.length }] }],
  items: Object.fromEntries(items.map(item => [item.id, ['esoterismo-tarot', 'tarot-oraculos']])),
});

test.beforeEach(() => {
  items = Array.from({ length: 55 }, (_, i) => ({
    id: physicalIds[i], title: `Producto ${i}`, author: `Autor ${i}`,
    status: 'active', available_quantity: 1, price: 1000 + i,
    start_time: new Date(Date.UTC(2025, 0, i + 1)).toISOString(), pictures: [],
  }));
  globalThis.caches = { default: { async match(request) {
    if (request.url.endsWith('/data/active-categories.json')) return Response.json(categoryData());
    if (request.url === CATALOG_URL) return Response.json({ items });
    if ([PRODUCTION_MANIFEST_URL, PAUSED_MANIFEST_URL].includes(request.url)) return Response.json({ schema_version: 0 });
    throw new Error(`Lectura inesperada: ${request.url}`);
  }, async put() {} } };
});

async function render(search = '', path = 'esoterismo-tarot', appEnv = 'production') {
  const response = await onRequest({ request: new Request(`https://preview.example/libros/${path}${search}`), params: { path: path.split('/') }, env: { APP_ENV: appEnv }, data: {}, waitUntil() {} });
  return { response, html: await response.text() };
}
const ids = html => [...html.matchAll(/class="book-image" href="[^\"]*\/libro\/(MLU\d+)\//g)].map(m => m[1]);

test('una grilla, un H1 y ningún bloque editorial, cuestionario o separación de cartas', async () => {
  const { html, response } = await render();
  assert.equal(response.status, 200);
  assert.equal((html.match(/<h1>/g) || []).length, 1);
  assert.equal((html.match(/class="books-grid"/g) || []).length, 1);
  assert.equal(ids(html).length, 48);
  assert.doesNotMatch(html, /tarot-finder|tarot-module|Cómo elegir un tarot|Para empezar|Para profundizar|Clásicos|Mazos de oráculo<|Subcategorías de Esoterismo/);
  assert.match(html, /Te llega hoy/);
  assert.match(html, /<form class="category-order"[^>]*method="get">/);
  assert.match(html, /<button type="submit">Ordenar<\/button>/);
  assert.doesNotMatch(html, /Más popular|Más vendido/);
});

for (const [order, reverse] of [['recientes', true], ['antiguos', false], ['precio-desc', true], ['precio-asc', false]]) {
  test(`orden ${order}: compara todo el universo antes de paginar, sin saltos ni duplicados`, async () => {
    const first = await render(`?orden=${order}`);
    const second = await render(`?page=2&orden=${order}`);
    const expected = items.map(item => item.id);
    if (reverse) expected.reverse();
    assert.deepEqual([...ids(first.html), ...ids(second.html)], expected);
    assert.match(first.html, new RegExp(`href="/libros/esoterismo-tarot\\?page=2&amp;orden=${order}"`));
    assert.match(first.html, /name="robots" content="noindex, follow"/);
    assert.match(second.html, /rel="canonical" href="https:\/\/www.amadolibros.com\/libros\/esoterismo-tarot\?page=2"/);
    assert.match(second.html, new RegExp(`href="/libros/esoterismo-tarot\\?orden=${order}"`));
  });
}

test('cambiar el orden no cambia la edición elegida para un ISBN repetido', async () => {
  items[0].isbn = '9780000000001'; items[1].isbn = '9780000000001';
  const a = ids((await render('?orden=antiguos')).html);
  const b = ids((await render('?orden=precio-desc')).html);
  const remaining = ids((await render('?page=2&orden=precio-desc')).html);
  assert.ok(a.includes(items[0].id));
  assert.ok([...b, ...remaining].includes(items[0].id));
  assert.ok(![...a, ...b, ...remaining].includes(items[1].id));
});

test('fechas y precios desconocidos quedan al final; los empates son estables', () => {
  const sample = [{ id: 'MLU3' }, { id: 'MLU2', price: 10, start_time: '2025-01-01' }, { id: 'MLU1', price: 10, start_time: '2025-01-01' }];
  for (const order of ['recientes', 'antiguos', 'precio-desc', 'precio-asc']) {
    assert.deepEqual(orderCategoryItems(sample, order).map(i => i.id), ['MLU1', 'MLU2', 'MLU3']);
  }
});

test('se conservan los robots normales y el orden no permite inyectar contenido', async () => {
  assert.match((await render()).html, /name="robots" content="index, follow"/);
  assert.match((await render('', 'esoterismo-tarot', 'preview')).html, /name="robots" content="noindex, follow"/);
  const { html } = await render('?orden=%3Cscript%3E');
  assert.match(html, /value="mezclados" selected/);
  assert.doesNotMatch(html, /<script>.*<\/script>/);
});

test('tarot y oráculos físicos comparten grilla, los manuales conservan su sección', async () => {
  items = realIds.map(id => ({ id, title: id, status: 'active', available_quantity: 1, price: 1000 }));
  const { html } = await render('', 'esoterismo-tarot/mazos');
  assert.deepEqual(new Set(ids(html)), new Set(realIds.slice(0, 2)));
  assert.ok(!ids(html).includes(realIds[2]));
  assert.deepEqual(ids((await render('', 'esoterismo-tarot/libros-tarot-oraculos')).html), [realIds[2]]);
});

test('la antigua URL de oráculos redirige a la colección compartida y sale de la allowlist', async () => {
  const { response } = await render('?page=3&orden=precio-desc', 'esoterismo-tarot/oraculos');
  assert.equal(response.status, 301);
  assert.equal(response.headers.get('Location'), '/libros/esoterismo-tarot/mazos?orden=precio-desc');
  assert.ok(!SEO_CATEGORIES.some(c => c.id === 'esoterismo-tarot/oraculos'));
});

test('el enriquecimiento de fechas respeta el precio, el stock y el universo del índice activo', async () => {
  const original = globalThis.caches.default.match;
  const indexUrl = `${R2_BASE}/test/active-index.json`;
  globalThis.caches.default.match = async request => {
    if (request.url === PRODUCTION_MANIFEST_URL) return Response.json({ schema_version: 1, current: {
      version: 'test', index_key: 'test/index.json', active_index_key: 'test/active-index.json', block_prefix: 'test/', block_count: 128,
    } });
    if (request.url === `${R2_BASE}/test/index.json`) return Response.json({ schema_version: 1, fields: ['id', 'title', 'author', 'isbn', 'image'], derived_fields: { slug: 'slugify-v1', status: 'paused', block: 'numeric-id-mod-block-count' }, block_count: 128, items: [] });
    if (request.url === indexUrl) return Response.json({ schema_version: 1,
      fields: ['id', 'title', 'author', 'isbn', 'image', 'price', 'available_quantity'],
      derived_fields: { slug: 'slugify-v1', status: 'active' },
      items: [[items[0].id, items[0].title, '', '', '', 9876, 2], [items[1].id, items[1].title, '', '', '', 4567, 1]],
    });
    return original(request);
  };
  const { html } = await render('?orden=recientes');
  assert.deepEqual(ids(html), [items[1].id, items[0].id]);
  assert.match(html, /9[.,]876 UYU/);
  assert.match(html, /4[.,]567 UYU/);
  assert.ok(!html.includes(`/libro/${items[2].id}/`));
});


test('la proyección de fechas evita releer el catálogo completo y sólo cachea fechas válidas', async () => {
  let catalogReads = 0;
  const entries = new Map();
  globalThis.caches.default = {
    async match(request) {
      if (request.url === CATEGORY_DATES_CACHE_URL) return entries.get(request.url)?.clone();
      assert.equal(request.url, CATALOG_URL);
      catalogReads++;
      return Response.json({ items: [items[0], { id: 'MLU9999', start_time: 'desconocida' }] });
    },
    async put(request, response) { entries.set(request.url, response.clone()); },
  };
  const pending = [];
  const first = await fetchCategoryDates({ waitUntil(p) { pending.push(p); } });
  await Promise.all(pending);
  const second = await fetchCategoryDates({});
  assert.deepEqual([...first], [[items[0].id, items[0].start_time]]);
  assert.deepEqual([...second], [...first]);
  assert.equal(catalogReads, 1);
  assert.equal(entries.get(CATEGORY_DATES_CACHE_URL).headers.get('cache-control'), 'public, max-age=60');
  assert.deepEqual(await entries.get(CATEGORY_DATES_CACHE_URL).json(), { [items[0].id]: items[0].start_time });
});

test('un catálogo fallido no guarda una proyección vacía y permite reintentar', async () => {
  let reads = 0, writes = 0;
  globalThis.caches.default = {
    async match(request) {
      if (request.url === CATEGORY_DATES_CACHE_URL) return null;
      assert.equal(request.url, CATALOG_URL);
      return ++reads === 1 ? new Response('JSON incompleto') : Response.json({ items: [items[0]] });
    },
    async put() { writes++; },
  };
  const ctx = { waitUntil() {} };
  assert.equal((await fetchCategoryDates(ctx)).size, 0);
  assert.equal(writes, 0);
  assert.equal((await fetchCategoryDates(ctx)).size, 1);
  assert.equal(writes, 1);
});

test('los siete ejemplos de las capturas quedan en Libros y nunca en las dos entradas de mazos', async () => {
  const examples = ['MLU1242572016', 'MLU692266499', 'MLU661278697', 'MLU1068776958', 'MLU1044019592', 'MLU1038819632', 'MLU1012194582'];
  items = [...realIds.slice(0, 2), ...examples].map((id, i) => ({ id, title: `Edición ${id}`, status: i % 2 ? 'paused' : 'active', available_quantity: i % 2 ? 0 : 1, price: 1234 }));
  for (const path of ['esoterismo-tarot', 'esoterismo-tarot/mazos']) {
    const { html } = await render('', path);
    assert.deepEqual(new Set(ids(html)), new Set(realIds.slice(0, 2)));
    for (const id of examples) assert.ok(!ids(html).includes(id), `${path}: ${id}`);
    assert.match(html, /aria-label="Tipo de producto"/);
    assert.match(html, /href="\/libros\/esoterismo-tarot" aria-current="page">Tarot y oráculos/);
    assert.match(html, /href="\/libros\/esoterismo-tarot\/libros-esoterismo">Libros/);
  }
  const { html } = await render('', 'esoterismo-tarot/libros-esoterismo');
  assert.deepEqual(new Set(ids(html)), new Set(examples));
  assert.match(html, /libros-esoterismo" aria-current="page">Libros/);
});

test('la vista inicial intercala disponibles y por encargo antes de paginar, sin perder productos', async () => {
  items.forEach((item, i) => { if (i % 2) Object.assign(item, { status: 'paused', available_quantity: 0, price: 987654 }); });
  const first = await render();
  const second = await render('?page=2');
  const displayed = [...ids(first.html), ...ids(second.html)];
  assert.equal(displayed.length, items.length);
  assert.equal(new Set(displayed).size, items.length);
  const stockById = new Map(items.map(item => [item.id, item.status]));
  assert.deepEqual(ids(first.html).map(id => stockById.get(id)), Array.from({ length: 48 }, (_, i) => i % 2 ? 'paused' : 'active'));
  assert.equal((first.html.match(/class="stock-badge by-request"/g) || []).length, 24);
  assert.equal((first.html.match(/aria-label="Te llega hoy en Montevideo"/g) || []).length, 24);
  assert.doesNotMatch(first.html, /987[.,]654 UYU/);
  assert.match(first.html, /Consultá precio y plazo de entrega/);
  assert.match(first.html, /55 productos<\/strong> · 28 disponibles · 27 por encargo/);
});

test('se mezclan los índices vigentes, activos ganan ante el mismo ID y no se consulta el catálogo de fechas por defecto', async () => {
  const [active, paused] = items;
  let catalogReads = 0;
  globalThis.caches.default.match = async request => {
    if (request.url.endsWith('/data/active-categories.json')) return Response.json(categoryData());
    if (request.url === PRODUCTION_MANIFEST_URL) return Response.json({ schema_version: 1, current: {
      version: 'mixed', index_key: 'mixed/index.json', active_index_key: 'mixed/active-index.json', block_prefix: 'mixed', block_count: 128,
    } });
    if (request.url === `${R2_BASE}/mixed/active-index.json`) return Response.json({ schema_version: 1,
      fields: ['id', 'title', 'author', 'isbn', 'image', 'price', 'available_quantity'],
      derived_fields: { slug: 'slugify-v1', status: 'active' },
      items: [[active.id, active.title, '', '', '', 4567, 1]],
    });
    if (request.url === `${R2_BASE}/mixed/index.json`) return Response.json({ schema_version: 1,
      fields: ['id', 'title', 'author', 'isbn', 'image'], block_count: 128,
      derived_fields: { slug: 'slugify-v1', status: 'paused', block: 'numeric-id-mod-block-count' },
      items: [[active.id, active.title, '', '', ''], [paused.id, paused.title, '', '', '']],
    });
    if (request.url === CATALOG_URL) catalogReads++;
    throw new Error(`Lectura inesperada: ${request.url}`);
  };
  const { html, response } = await render();
  assert.equal(response.status, 200);
  assert.deepEqual(ids(html), [active.id, paused.id]);
  assert.equal(catalogReads, 0);
  assert.match(html, /4[.,]567 UYU/);
  assert.match(html, /2 productos<\/strong> · 1 disponible · 1 por encargo/);
  assert.equal((html.match(/class="stock-badge by-request"/g) || []).length, 1);
});
