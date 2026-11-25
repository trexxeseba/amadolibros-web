import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as categoryRequest } from '../libros/[[path]].js';
import { CATALOG_URL, PAUSED_MANIFEST_URL, PRODUCTION_MANIFEST_URL } from '../_shared/catalog.js';

const CATEGORY = 'psicologia';
const PAGE_SIZE = 48;

function buildItems(count = 100) {
  return Array.from({ length: count }, (_, index) => ({
    id: `MLU${String(index + 1).padStart(4, '0')}`,
    title: `Psicología prueba ${index + 1}`,
    author: `Autor ${index + 1}`,
    price: 1000 + index,
    status: 'active',
    available_quantity: 1,
    thumbnail: '',
    pictures: [],
  }));
}

let ITEMS = buildItems();

function categoryData() {
  return {
    categories: [{ id: CATEGORY, name: 'Psicología', count: ITEMS.length, subcategories: [] }],
    items: Object.fromEntries(ITEMS.map(item => [item.id, [CATEGORY]])),
  };
}

function context(search = '', appEnv = 'production') {
  const host = appEnv === 'preview' ? 'preview.example' : 'www.amadolibros.com';
  return {
    request: new Request(`https://${host}/libros/${CATEGORY}${search}`),
    params: { path: [CATEGORY] },
    env: { APP_ENV: appEnv },
    data: {},
    waitUntil() {},
  };
}

test.beforeEach(() => {
  ITEMS = buildItems();
  globalThis.caches = {
    default: {
      async match(request) {
        if (request.url.endsWith('/data/active-categories.json')) return Response.json(categoryData());
        if (request.url === CATALOG_URL) return Response.json({ total: ITEMS.length, items: ITEMS });
        if ([PRODUCTION_MANIFEST_URL, PAUSED_MANIFEST_URL].includes(request.url)) {
          return Response.json({ schema_version: 0 });
        }
        return null;
      },
      async put() {},
    },
  };
});

async function render(search = '', appEnv = 'production') {
  const response = await categoryRequest(context(search, appEnv));
  const html = response.status === 200 ? await response.text() : '';
  return { response, html };
}

function ids(html) {
  return [...html.matchAll(/\/libro\/(MLU\d+)\//g)].map(match => match[1])
    .filter((id, index, all) => all.indexOf(id) === index);
}

test('1. primera página sirve 48 fichas y enlaces HTML a página 2', async () => {
  const { response, html } = await render();
  assert.equal(response.status, 200);
  assert.equal(ids(html).length, PAGE_SIZE);
  assert.match(html, /Mostrando 1–48 de 100 libros/);
  assert.match(html, /<a class="pg-ctl" rel="next" href="\/libros\/psicologia\?page=2">Siguiente/);
  assert.match(html, /<meta name="robots" content="index, follow">/);
});

test('2. página 2 es indexable y self-canonical', async () => {
  const { response, html } = await render('?page=2');
  assert.equal(response.status, 200);
  assert.equal(ids(html).length, PAGE_SIZE);
  assert.match(html, /Mostrando 49–96 de 100 libros/);
  assert.match(html, /<link rel="canonical" href="https:\/\/www\.amadolibros\.com\/libros\/psicologia\?page=2">/);
  assert.match(html, /<meta name="robots" content="index, follow">/);
  assert.match(html, /<a class="pg-ctl" rel="prev" href="\/libros\/psicologia">‹ Anterior<\/a>/);
});

test('3. última página sirve el resto y no enlaza a una página inexistente', async () => {
  const { html } = await render('?page=3');
  assert.equal(ids(html).length, 4);
  assert.match(html, /Mostrando 97–100 de 100 libros/);
  assert.match(html, /<span class="pg-ctl is-off" aria-disabled="true">Siguiente/);
});

test('4. la unión de páginas cubre la categoría sin duplicados', async () => {
  const all = [];
  for (const search of ['', '?page=2', '?page=3']) all.push(...ids((await render(search)).html));
  assert.equal(all.length, 100);
  assert.equal(new Set(all).size, 100);
});

test('5. el orden es estable aunque cambie el orden del catálogo de origen', async () => {
  const original = [];
  for (const search of ['', '?page=2', '?page=3']) original.push(...ids((await render(search)).html));
  ITEMS.reverse();
  const reversed = [];
  for (const search of ['', '?page=2', '?page=3']) reversed.push(...ids((await render(search)).html));
  assert.deepEqual(reversed, original);
});

test('6. page=1 explícito normaliza 301 a la landing limpia', async () => {
  const { response } = await render('?page=1');
  assert.equal(response.status, 301);
  assert.equal(response.headers.get('Location'), '/libros/psicologia');
});

test('7. sintaxis inválida de page normaliza a la landing limpia', async () => {
  const { response } = await render('?page=2abc');
  assert.equal(response.status, 301);
  assert.equal(response.headers.get('Location'), '/libros/psicologia');
});

test('8. página mayor al máximo devuelve 404 real', async () => {
  const { response } = await render('?page=4');
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('Location'), null);
});

test('9. parámetros ajenos a page no crean otra landing indexable', async () => {
  const { html } = await render('?page=2&orden=precio');
  assert.match(html, /<meta name="robots" content="noindex, follow">/);
  assert.match(html, /<link rel="canonical" href="https:\/\/www\.amadolibros\.com\/libros\/psicologia\?page=2">/);
});

test('10. preview conserva navegación relativa y permanece noindex', async () => {
  const { html } = await render('?page=2', 'preview');
  assert.match(html, /<meta name="robots" content="noindex, follow">/);
  assert.match(html, /href="https:\/\/preview\.example\/libro\/MLU\d+\//);
  assert.match(html, /href="\/libros\/psicologia\?page=3"/);
});

test('disponibilidad filtra la colección antes de paginar y mantiene sus conteos completos', async () => {
  ITEMS = buildItems().map((item, index) => index < 60 ? item : { ...item, status: 'paused', available_quantity: 0 });
  const available = await render('?disponibilidad=disponibles');
  assert.equal(available.response.status, 200);
  assert.equal(ids(available.html).length, 48);
  assert.ok(ids(available.html).every(id => Number(id.slice(3)) <= 60));
  assert.match(available.html, /100 libros<\/strong> en esta colección · 60 disponibles · 40 por encargo/);
  assert.match(available.html, /Mostrando 1–48 de 60 libros/);
  assert.match(available.html, /page=2&amp;disponibilidad=disponibles/);
  assert.match(available.html, /name="disponibilidad" value="disponibles"/);
  assert.match(available.html, /name="robots" content="noindex, follow"/);
  const last = await render('?page=2&disponibilidad=disponibles');
  assert.equal(ids(last.html).length, 12);
  const requested = await render('?disponibilidad=encargo');
  assert.equal(ids(requested.html).length, 40);
  assert.ok(ids(requested.html).every(id => Number(id.slice(3)) > 60));
  assert.match(requested.html, /disponibilidad=encargo" aria-current="page"/);
});

test('orden y paginación conservan el filtro sin mezclar estados', async () => {
  ITEMS = buildItems().map((item, index) => index < 60 ? item : { ...item, status: 'paused', available_quantity: 0 });
  const { html } = await render('?orden=precio-desc&disponibilidad=disponibles');
  assert.match(html, /page=2&amp;orden=precio-desc&amp;disponibilidad=disponibles/);
  assert.equal(ids(html)[0], 'MLU0060');
  assert.match(html, /orden=precio-desc&amp;disponibilidad=encargo/);
});
