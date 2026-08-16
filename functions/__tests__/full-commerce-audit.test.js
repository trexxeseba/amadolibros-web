import test from 'node:test';
import assert from 'node:assert/strict';
import {
  auditCatalogSafety,
  auditFeed,
  inspectProductHtml,
  parseMerchantFeed,
  stableSample,
} from '../../scripts/commerce/full-commerce-audit.mjs';

function catalogItem(patch = {}) {
  return {
    id: 'MLU123456', title: 'Libro real', author: 'Autora', isbn: '9788499809991',
    status: 'active', available_quantity: 1, price: 990, currency: 'UYU',
    domain_id: 'MLU-BOOKS',
    ...patch,
  };
}

function feedXml(patch = {}) {
  const row = {
    id: 'MLU123456', title: 'Libro real', description: 'Descripción real',
    link: 'https://www.amadolibros.com/libro/MLU123456/libro-real',
    image: 'https://www.amadolibros.com/book-cover/MLU123456/cover.jpg',
    price: '990 UYU',
    ...patch,
  };
  return `<rss><channel><item>
    <g:id>${row.id}</g:id><g:title>${row.title}</g:title>
    <g:description>${row.description}</g:description><g:link>${row.link}</g:link>
    <g:image_link>${row.image}</g:image_link><g:availability>in stock</g:availability>
    <g:price>${row.price}</g:price><g:condition>new</g:condition>
  </item></channel></rss>`;
}

test('parsea el feed y valida una oferta coherente bajo dominio propio', () => {
  const rows = parseMerchantFeed(feedXml());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'MLU123456');
  const result = auditFeed({ items: [catalogItem()] }, rows);
  assert.equal(result.critical, 0);
});

test('detecta precio cruzado, imagen externa y producto no-libro', () => {
  const rows = parseMerchantFeed(feedXml({
    image: 'https://http2.mlstatic.com/D_X-O.jpg',
    price: '25650 UYU',
  }));
  const result = auditFeed({ items: [catalogItem({ domain_id: 'MLU-COMPUTER_COMPONENTS' })] }, rows);
  const codes = result.issues.map(row => row.code);
  assert.ok(codes.includes('FEED_NON_BOOK'));
  assert.ok(codes.includes('FEED_PRICE_MISMATCH'));
  assert.ok(codes.includes('FEED_IMAGE_LINK_EXTERNAL'));
});

test('separa moneda no-UYU revisable de un precio activo realmente inválido', () => {
  const result = auditCatalogSafety({ items: [
    catalogItem({ id: 'MLU-USD', currency: 'USD' }),
    catalogItem({ id: 'MLU-BAD', price: 0 }),
  ] });
  assert.equal(result.active_non_uyu, 1);
  assert.equal(result.critical, 1);
  assert.ok(result.issues.some(row => row.code === 'CATALOG_PRICE_INVALID'));
});

test('la muestra estable cubre todo el rango sin aleatoriedad', () => {
  assert.deepEqual(stableSample([0, 1, 2, 3, 4, 5, 6, 7], 4), [0, 2, 4, 6]);
  assert.deepEqual(stableSample([1, 2], 0), [1, 2]);
});

test('distingue una ficha indexable de un Preview protegido', () => {
  const page = robots => `<!doctype html><html><head>
    <meta name="robots" content="${robots}">
    <link rel="canonical" href="https://www.amadolibros.com/libro/MLU123456/libro-real">
    <title>Libro real</title><script type="application/ld+json">{"@type":"Book"}</script>
  </head><body><h1>Libro real</h1></body></html>`;
  const url = 'https://preview.example/libro/MLU123456/libro-real';
  assert.deepEqual(inspectProductHtml(page('index, follow'), url, { expectIndexable: true }).issues, []);
  assert.deepEqual(inspectProductHtml(page('noindex, follow'), url, { expectIndexable: false }).issues, []);
  assert.ok(inspectProductHtml(page('index, follow'), url, { expectIndexable: false }).issues.includes('PREVIEW_INDEXABLE'));
  assert.equal(inspectProductHtml(page('index, follow').replace('"@type":"Book"', '"@type":["Product","Book"]'), url).product_schema, true);
});
