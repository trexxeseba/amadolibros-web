import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  enrichByRequestProductHtml,
  onRequest,
} from '../libro/_middleware.js';
import {
  ORDER_HUB_PATH,
  orderHubPageForProductId,
} from '../_shared/order-hub.js';
import { PAUSED_SEO_COHORT } from '../_shared/paused-seo-cohort.js';

function productHtml({ preview = false, active = false } = {}) {
  const breadcrumb = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Inicio', item: 'https://www.amadolibros.com/' },
      { '@type': 'ListItem', position: 2, name: 'Libro de prueba' },
    ],
  };
  const product = {
    '@context': 'https://schema.org',
    '@type': ['Product', 'Book'],
    name: 'Libro de prueba',
  };
  const orderCopy = active
    ? '<span>Esta publicación no se convierte automáticamente a UYU. Consultanos para confirmar precio y forma de pago, o comprala directamente en MercadoLibre.</span>'
    : '<span>Podemos intentar conseguirlo por encargo. Consultanos y verificamos disponibilidad, edición y precio.</span>';
  return `<!doctype html><html><head>
    <meta name="robots" content="${preview ? 'noindex, follow' : 'index, follow'}">
    <link rel="canonical" href="https://www.amadolibros.com/libro/MLU1/libro-de-prueba">
    <script type="application/ld+json">${JSON.stringify(product)}</script>
    <script type="application/ld+json">${JSON.stringify(breadcrumb)}</script>
    <style>main{display:grid}</style>
  </head><body>
    <nav>
      <a href="/">Inicio</a> ›
      <span>Libro de prueba</span>
    </nav>
    <main>
      <div class="info">
        ${active ? '<span class="badge in-stock">✓ En stock</span>' : ''}
        <div class="order-box">
          <strong>${active ? 'Precio publicado' : '¿Buscás este libro?'}</strong>
          ${orderCopy}
        </div>
      </div>
    </main>
  </body></html>`;
}

function breadcrumbSchema(html) {
  for (const match of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    const parsed = JSON.parse(match[1]);
    if (parsed?.['@type'] === 'BreadcrumbList') return parsed;
  }
  return null;
}

test('resuelve la página exacta del hub sin cargar el índice pausado', () => {
  assert.equal(orderHubPageForProductId(PAUSED_SEO_COHORT[0].id), 1);
  assert.equal(orderHubPageForProductId(PAUSED_SEO_COHORT[47].id), 1);
  assert.equal(orderHubPageForProductId(PAUSED_SEO_COHORT[48].id), 2);
  assert.equal(orderHubPageForProductId(PAUSED_SEO_COHORT.at(-1).id), 63);
  assert.equal(orderHubPageForProductId('MLU999999999999'), null);
});

test('una ficha pausada de la cohorte enlaza al hub, su página exacta y el servicio', () => {
  const productId = PAUSED_SEO_COHORT[48].id;
  const html = enrichByRequestProductHtml(productHtml(), productId);

  assert.match(html, /<a href="\/libros-por-encargo">Libros por encargo<\/a> ›/);
  assert.match(html, /class="order-hub-links"/);
  assert.match(html, /href="\/libros-por-encargo\?page=2"/);
  assert.match(html, /Volver a la página 2 donde aparece este título/);
  assert.match(html, /href="\/libros-agotados-importados-uruguay"/);
  assert.match(html, /<link rel="canonical" href="https:\/\/www\.amadolibros\.com\/libro\/MLU1\/libro-de-prueba">/);
  assert.doesNotMatch(html, /"@type":"Offer"|priceCurrency/);

  const schema = breadcrumbSchema(html);
  assert.ok(schema);
  assert.deepEqual(schema.itemListElement.map(item => [item.position, item.name]), [
    [1, 'Inicio'],
    [2, 'Libros por encargo'],
    [3, 'Libro de prueba'],
  ]);
  assert.equal(schema.itemListElement[1].item, `https://www.amadolibros.com${ORDER_HUB_PATH}`);
});

test('Preview conserva noindex y los headers mientras muestra la misma navegación HTML', async () => {
  const productId = PAUSED_SEO_COHORT[48].id;
  const context = {
    request: new Request(`https://preview.example.com/libro/${productId}/libro-de-prueba`),
    next: async () => new Response(productHtml({ preview: true }), {
      status: 200,
      headers: {
        'content-type': 'text/html;charset=UTF-8',
        'cache-control': 'public, max-age=3600',
        'server-timing': 'route_total;dur=12',
      },
    }),
  };

  const response = await onRequest(context);
  const html = await response.text();
  assert.match(html, /<meta name="robots" content="noindex, follow">/);
  assert.match(html, /href="\/libros-por-encargo\?page=2"/);
  assert.match(html, /<a href="\/libros-por-encargo">Libros por encargo<\/a>/);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=3600');
  assert.equal(response.headers.get('server-timing'), 'route_total;dur=12');
});

test('si el título volvió a stock, no se lo etiqueta ni enlaza como por encargo', () => {
  const productId = PAUSED_SEO_COHORT[48].id;
  const original = productHtml({ active: true });
  assert.equal(enrichByRequestProductHtml(original, productId), original);
});

test('una ficha pausada fuera de la cohorte recibe el plazo sin enlaces SEO', () => {
  const html = enrichByRequestProductHtml(productHtml(), 'MLU999999999999');

  assert.match(html, /Demora estimada: 15 a 20 días desde la confirmación\./);
  assert.doesNotMatch(html, /class="order-hub-links"/);
  assert.doesNotMatch(html, /href="\/libros-por-encargo/);

  const schema = breadcrumbSchema(html);
  assert.ok(schema);
  assert.deepEqual(schema.itemListElement.map(item => [item.position, item.name]), [
    [1, 'Inicio'],
    [2, 'Libro de prueba'],
  ]);
});

test('el middleware evita el catálogo completo y usa sólo la cohorte compacta de IDs', () => {
  const source = readFileSync('functions/libro/_middleware.js', 'utf8');
  assert.doesNotMatch(source, /fetchPausedIndex|fetchPausedItem|fetchCatalog|R2_BASE/);
  assert.match(source, /isProductInShowcaseCohort/);
});
