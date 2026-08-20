import test from 'node:test';
import assert from 'node:assert/strict';

import {
  enrichActiveCatalogBreadcrumbHtml,
  enrichByRequestProductHtml,
  onRequest,
} from '../libro/_middleware.js';
import { PAUSED_SEO_COHORT } from '../_shared/paused-seo-cohort.js';

const COHORT_PRODUCT_ID = PAUSED_SEO_COHORT[0].id;
const OUTSIDE_COHORT_PRODUCT_ID = 'MLU999999999';

function productHtml({ inStock = false } = {}) {
  const orderCopy = inStock
    ? '<span>Esta publicación no se convierte automáticamente a UYU. Consultanos para confirmar precio y forma de pago.</span>'
    : '<span>Podemos intentar conseguirlo por encargo. Consultanos y verificamos disponibilidad, edición y precio.</span>';
  return `<!doctype html>
<html lang="es">
<head>
  <style>.order-box span{font-weight:700}</style>
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"Inicio","item":"https://www.amadolibros.com/"},{"@type":"ListItem","position":2,"name":"Libro de prueba"}]}</script>
</head>
<body>
  <nav><a href="/">Inicio</a> › <span>Libro de prueba</span></nav>
  <main>
    ${inStock ? '<span class="badge in-stock">En stock</span>' : ''}
    <div class="order-box">
      <strong>${inStock ? 'Precio publicado: USD 10' : '¿Buscás este libro?'}</strong>
      ${orderCopy}
    </div>
  </main>
</body>
</html>`;
}

function breadcrumbSchema(html) {
  for (const match of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    const parsed = JSON.parse(match[1]);
    if (parsed?.['@type'] === 'BreadcrumbList') return parsed;
  }
  return null;
}

function assertLeadTime(html) {
  assert.match(html, /Demora estimada: 15 a 20 días desde la confirmación\./);
  assert.match(html, /Salvo demoras del proveedor, courier o aduana\./);
  assert.match(html, /Antes de avanzar verificamos disponibilidad, edición y precio\./);
  assert.doesNotMatch(html, /Podemos intentar conseguirlo por encargo/);
  assert.doesNotMatch(html, /días hábiles|garantizad/i);
  assert.match(html, /class="order-lead-time"/);
  assert.match(html, /\.order-box \.order-lead-time\{font-weight:650\}/);
}

test('la ficha de la cohorte comunica el plazo y conserva el hub SEO', () => {
  const html = enrichByRequestProductHtml(productHtml(), COHORT_PRODUCT_ID);

  assertLeadTime(html);
  assert.match(html, /class="order-hub-links"/);
  assert.match(html, /<a href="\/libros-por-encargo">Libros por encargo<\/a>/);
});

test('una ficha pausada fuera de la cohorte también comunica el plazo sin inventar enlaces SEO', () => {
  const html = enrichByRequestProductHtml(productHtml(), OUTSIDE_COHORT_PRODUCT_ID);

  assertLeadTime(html);
  assert.doesNotMatch(html, /class="order-hub-links"/);
  assert.doesNotMatch(html, /<a href="\/libros-por-encargo">Libros por encargo<\/a>/);
});

test('una ficha activa con caja de moneda extranjera no recibe plazo de encargo', () => {
  const source = productHtml({ inStock: true });
  const html = enrichByRequestProductHtml(source, OUTSIDE_COHORT_PRODUCT_ID);

  assert.equal(html, source);
  assert.doesNotMatch(html, /15 a 20 días/);
});

test('QW3: una ficha activa enlaza Catálogo en HTML y BreadcrumbList', () => {
  const html = enrichActiveCatalogBreadcrumbHtml(productHtml({ inStock: true }));

  assert.match(html, /<a href="\/">Inicio<\/a> ›\s*<a href="\/catalogo">Catálogo<\/a> ›\s*<span>Libro de prueba<\/span>/);
  assert.doesNotMatch(html, /Libros por encargo/);

  const schema = breadcrumbSchema(html);
  assert.ok(schema);
  assert.deepEqual(schema.itemListElement.map(item => [item.position, item.name]), [
    [1, 'Inicio'],
    [2, 'Catálogo'],
    [3, 'Libro de prueba'],
  ]);
  assert.equal(schema.itemListElement[1].item, 'https://www.amadolibros.com/catalogo');
});

test('QW3: una ficha pausada queda fuera del breadcrumb de Catálogo', () => {
  const source = productHtml();
  assert.equal(enrichActiveCatalogBreadcrumbHtml(source), source);
});

test('QW3: el breadcrumb activo es idempotente', () => {
  const first = enrichActiveCatalogBreadcrumbHtml(productHtml({ inStock: true }));
  const second = enrichActiveCatalogBreadcrumbHtml(first);

  assert.equal(second, first);
  assert.equal((second.match(/href="\/catalogo">Catálogo<\/a>/g) || []).length, 1);
  const schema = breadcrumbSchema(second);
  assert.equal(schema.itemListElement.filter(item => item.name === 'Catálogo').length, 1);
});

test('el enriquecimiento es idempotente dentro y fuera de la cohorte', () => {
  for (const productId of [COHORT_PRODUCT_ID, OUTSIDE_COHORT_PRODUCT_ID]) {
    const first = enrichByRequestProductHtml(productHtml(), productId);
    const second = enrichByRequestProductHtml(first, productId);

    assert.equal(second, first);
    assert.equal((second.match(/15 a 20 días/g) || []).length, 1);
    assert.equal((second.match(/\.order-box \.order-lead-time\{/g) || []).length, 1);
  }
});

test('el middleware transforma una ficha pausada fuera de cohorte y elimina validators del body anterior', async () => {
  const upstream = new Response(productHtml(), {
    status: 200,
    headers: {
      'content-type': 'text/html;charset=UTF-8',
      'content-length': '999',
      etag: '"anterior"',
      'cache-control': 'public, max-age=3600',
    },
  });
  const response = await onRequest({
    request: new Request(`https://www.amadolibros.com/libro/${OUTSIDE_COHORT_PRODUCT_ID}/libro`),
    next: async () => upstream,
  });
  const html = await response.text();

  assertLeadTime(html);
  assert.equal(response.headers.get('etag'), null);
  assert.equal(response.headers.get('content-length'), null);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=3600');
});

test('QW3: el middleware transforma una ficha activa, conserva cache-control y descarta validators anteriores', async () => {
  const upstream = new Response(productHtml({ inStock: true }), {
    status: 200,
    headers: {
      'content-type': 'text/html;charset=UTF-8',
      'content-length': '999',
      etag: '"activo"',
      'cache-control': 'public, max-age=3600',
    },
  });
  const response = await onRequest({
    request: new Request(`https://www.amadolibros.com/libro/${OUTSIDE_COHORT_PRODUCT_ID}/libro`),
    next: async () => upstream,
  });
  const html = await response.text();

  assert.notEqual(response, upstream);
  assert.match(html, /href="\/catalogo">Catálogo<\/a>/);
  assert.doesNotMatch(html, /15 a 20 días/);
  assert.doesNotMatch(html, /Libros por encargo/);
  assert.equal(response.headers.get('etag'), null);
  assert.equal(response.headers.get('content-length'), null);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=3600');
});
