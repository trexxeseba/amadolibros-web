import test from 'node:test';
import assert from 'node:assert/strict';
import {
  auditCatalogSafety,
  auditFeed,
  expectedFeedPrice,
  inspectProductHtml,
  parseMerchantFeed,
  stableSample,
} from '../../scripts/commerce/full-commerce-audit.mjs';

// Fuera de la ventana de la promo web: el feed debe publicar el precio habitual.
const FUERA_DE_PROMO = { now: new Date('2026-10-01T12:00:00-03:00') };
const EN_PROMO = { now: new Date('2026-11-02T12:00:00-03:00') };

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
  const result = auditFeed({ items: [catalogItem()] }, rows, FUERA_DE_PROMO);
  assert.equal(result.critical, 0);
});

test('detecta precio cruzado, imagen externa y producto no-libro', () => {
  const rows = parseMerchantFeed(feedXml({
    image: 'https://http2.mlstatic.com/D_X-O.jpg',
    price: '25650 UYU',
  }));
  const result = auditFeed({ items: [catalogItem({
    domain_id: 'MLU-COMPUTER_COMPONENTS', isbn: null, author: null, pages: null,
  })] }, rows, FUERA_DE_PROMO);
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
    <title>Libro real</title><script type="application/ld+json">{"@type":"Product","image":"https://www.amadolibros.com/book-cover/MLU123456/cover.jpg"}</script>
  </head><body><h1>Libro real</h1></body></html>`;
  const url = 'https://preview.example/libro/MLU123456/libro-real';
  assert.deepEqual(inspectProductHtml(page('index, follow'), url, { expectIndexable: true }).issues, []);
  assert.deepEqual(inspectProductHtml(page('noindex, follow'), url, { expectIndexable: false }).issues, []);
  assert.ok(inspectProductHtml(page('index, follow'), url, { expectIndexable: false }).issues.includes('PREVIEW_INDEXABLE'));
  assert.equal(inspectProductHtml(page('index, follow').replace('"@type":"Product"', '"@type":["Product","Book"]'), url).product_schema, true);
});

test('con la promo vigente el feed debe publicar el precio habitual por 0,85 redondeado', () => {
  const rows = parseMerchantFeed(feedXml({ price: '842 UYU' })); // 990 * 0,85 = 841,5
  const result = auditFeed({ items: [catalogItem()] }, rows, EN_PROMO);
  assert.equal(result.critical, 0);
  assert.equal(expectedFeedPrice(990, EN_PROMO), 842);
});

test('con la promo vigente un feed al precio habitual sigue fallando', () => {
  const rows = parseMerchantFeed(feedXml({ price: '990 UYU' }));
  const result = auditFeed({ items: [catalogItem()] }, rows, EN_PROMO);
  const mismatch = result.issues.find(row => row.code === 'FEED_PRICE_MISMATCH');
  assert.ok(mismatch);
  assert.equal(mismatch.expected_price, 842);
  assert.equal(mismatch.promo_active, true);
});

test('con la promo vigente un precio cualquiera distinto del esperado falla', () => {
  const rows = parseMerchantFeed(feedXml({ price: '800 UYU' }));
  const result = auditFeed({ items: [catalogItem()] }, rows, EN_PROMO);
  assert.ok(result.issues.some(row => row.code === 'FEED_PRICE_MISMATCH'));
});

test('terminada la promo, un feed que conserva el precio promocional falla', () => {
  const rows = parseMerchantFeed(feedXml({ price: '842 UYU' }));
  const result = auditFeed({ items: [catalogItem()] }, rows, { now: new Date('2026-11-10T00:00:00-03:00') });
  assert.ok(result.issues.some(row => row.code === 'FEED_PRICE_MISMATCH' && row.promo_active === false));
});
