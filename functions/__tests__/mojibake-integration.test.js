// MOJIBAKE-FIX-1 — pruebas de integración: confirman que la reparación se
// aplica de forma coherente en la ficha de producto y en los resultados
// del buscador, y que nunca cambia el slug/URL canónica (que sigue
// derivando del título original, sin reparar).
import test from 'node:test';
import assert from 'node:assert/strict';

import { renderPage } from '../libro/[[path]].js';
import { onRequest as catalogRequest } from '../catalogo.js';
import { CATALOG_URL } from '../_shared/catalog.js';

const MOJIBAKE_TITLE = 'Soy Una SuperniÃ±a';
const CORRECT_TITLE = 'Soy Una Superniña';
const MOJIBAKE_TITLE_2 = 'Del CÃ­rculo Que Se CayÃ³ De Una Camiseta De Lunares';
const CORRECT_TITLE_2 = 'Del Círculo Que Se Cayó De Una Camiseta De Lunares';

function mojibakeBook(overrides = {}) {
  return {
    id: 'MLU900000001',
    title: MOJIBAKE_TITLE,
    author: 'MarÃ­a JosÃ© PÃ©rez',
    isbn: '9780000000099',
    price: 990,
    currency: 'UYU',
    status: 'active',
    available_quantity: 3,
    condition: 'new',
    pictures: ['https://http2.mlstatic.com/D_TEST-O.jpg'],
    thumbnail: '',
    permalink: 'https://articulo.mercadolibre.com.uy/MLU900000001',
    description: 'Una ediciÃ³n especial, con ilustraciones a color.',
    publisher: 'Editorial NiÃ±ez',
    bibliographic: { language: 'EspaÃ±ol', edition: 'Primera ediciÃ³n' },
    ...overrides,
  };
}

function jsonLdBlocks(html) {
  return [...html.matchAll(/<script type="application\/ld\+json">([^<]+)<\/script>/g)]
    .map(match => JSON.parse(match[1]));
}

// ── Ficha de producto ────────────────────────────────────────────────────

test('la ficha muestra el título reparado en H1, <title>, meta description, JSON-LD y alt, sin cambiar el slug', () => {
  const rawTitleSlug = 'soy-una-supernia-a'; // el mismo slug que produce hoy el título corrupto — no debe cambiar
  const html = renderPage(mojibakeBook(), rawTitleSlug, false, '');

  // Texto visible reparado
  assert.match(html, /<h1>Soy Una Superniña<\/h1>/);
  assert.match(html, /<title>Soy Una Superniña \| Amado Libros<\/title>/);
  assert.doesNotMatch(html, /Ã±|Ã­|Ã³|Ã©/); // ningún resto de mojibake en el HTML

  // Meta description y og/twitter usan el texto reparado
  assert.match(html, /<meta name="description" content="[^"]*Superniña[^"]*"/);
  assert.match(html, /<meta property="og:title"\s+content="Soy Una Superniña \| Amado Libros">/);

  // JSON-LD Product/Book usa el nombre reparado
  const schemas = jsonLdBlocks(html);
  const product = schemas.find(schema => Array.isArray(schema['@type']));
  assert.ok(product);
  assert.equal(product.name, CORRECT_TITLE);
  assert.match(product.description, /especial/);
  assert.doesNotMatch(JSON.stringify(product), /Ã±|Ã­|Ã³/);

  // Alt de imagen reparado
  assert.match(html, /alt="Soy Una Superniña"/);

  // La URL canónica sigue siendo la misma que ya existe hoy (deriva del
  // slug pasado por el caller, calculado con el título SIN reparar).
  assert.match(html, new RegExp(`<link rel="canonical" href="https://www\\.amadolibros\\.com/libro/MLU900000001/${rawTitleSlug}">`));
});

test('la ficha repara autor, editorial y campos bibliográficos, sin tocar id/isbn/precio/stock', () => {
  const html = renderPage(mojibakeBook(), 'slug-fijo', false, '');
  assert.match(html, /Editorial Niñez/);
  assert.match(html, /Español/);
  assert.match(html, /Primera edición/);
  // Campos no textuales, intactos
  assert.match(html, /MLU900000001/);
  assert.match(html, /9780000000099/);
  assert.match(html, /990/);
});

test('un texto ya correcto en la ficha no se altera', () => {
  const html = renderPage(mojibakeBook({
    title: 'Cien años de soledad',
    author: 'Gabriel García Márquez',
    description: 'Una historia de la familia Buendía en Macondo.',
    bibliographic: {},
  }), 'cien-anos-de-soledad', false, '');
  assert.match(html, /<h1>Cien años de soledad<\/h1>/);
  assert.match(html, /Gabriel García Márquez/);
});

// ── Resultados del buscador (/catalogo) ─────────────────────────────────

function context(url, appEnv = 'test') {
  return {
    request: new Request(url),
    params: {},
    env: { APP_ENV: appEnv },
    waitUntil() {},
  };
}

function installCatalogCache(catalog) {
  globalThis.caches = {
    default: {
      async match(request) {
        return request.url === CATALOG_URL ? Response.json(catalog) : null;
      },
      async put() {},
    },
  };
}

test.afterEach(() => {
  delete globalThis.fetch;
  delete globalThis.caches;
});

test('el resultado de búsqueda muestra el título reparado, con el mismo href que ya existe hoy', async () => {
  installCatalogCache({
    total: 2,
    items: [
      mojibakeBook(),
      {
        id: 'MLU900000002', title: MOJIBAKE_TITLE_2, author: null,
        isbn: '9780000000100', price: 1200, status: 'active', available_quantity: 1,
        thumbnail: '', pictures: [], permalink: 'https://x/MLU900000002',
      },
    ],
  });
  const response = await catalogRequest(context('https://www.amadolibros.com/catalogo?q=super'));
  const html = await response.text();

  assert.match(html, new RegExp(`class="rc-title">${CORRECT_TITLE}</p>`));
  assert.doesNotMatch(html, /Ã±|Ã­|Ã³/);
  // El href sigue siendo el que ya generaba el título corrupto — no cambia
  // la URL canónica de la ficha para este producto.
  assert.match(html, /href="[^"]*\/libro\/MLU900000001\/soy-una-supernia-a"/);
});

test('el resultado de búsqueda repara también el segundo título reportado', async () => {
  installCatalogCache({
    total: 1,
    items: [{
      id: 'MLU900000003', title: MOJIBAKE_TITLE_2, author: 'Autora Tres',
      isbn: '9780000000101', price: 800, status: 'active', available_quantity: 1,
      thumbnail: '', pictures: [], permalink: 'https://x/MLU900000003',
    }],
  });
  // "camiseta" no forma parte de los tramos con mojibake del título, así
  // que ya matchea hoy contra el título sin reparar — esta prueba valida
  // sólo el TEXTO MOSTRADO reparado, no el matching de búsqueda (que sigue
  // comparando contra el título original; ver limitaciones en el informe).
  const response = await catalogRequest(context('https://www.amadolibros.com/catalogo?q=camiseta'));
  const html = await response.text();
  assert.match(html, new RegExp(`class="rc-title">${CORRECT_TITLE_2}</p>`));
});

test('resultados con título ya correcto no cambian', async () => {
  installCatalogCache({
    total: 1,
    items: [{
      id: 'MLU900000004', title: 'Cien años de soledad', author: 'Gabriel García Márquez',
      isbn: '9780000000102', price: 1500, status: 'active', available_quantity: 4,
      thumbnail: '', pictures: [], permalink: 'https://x/MLU900000004',
    }],
  });
  const response = await catalogRequest(context('https://www.amadolibros.com/catalogo?q=soledad'));
  const html = await response.text();
  assert.match(html, /class="rc-title">Cien años de soledad<\/p>/);
});
