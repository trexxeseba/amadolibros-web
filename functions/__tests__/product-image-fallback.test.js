import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest, renderPage } from '../libro/[[path]].js';
import { CATALOG_URL } from '../_shared/catalog.js';
import { inspectProductImages } from '../../shared/product-image-audit.js';
import { inspectProductHtml } from '../../scripts/commerce/full-commerce-audit.mjs';

const id = 'MLU123456'; const slug = 'libro-de-prueba';
const url = `https://www.amadolibros.com/libro/${id}/${slug}`;
const sources = ['https://http2.mlstatic.com/D_FIRST-O.jpg', 'https://http2.mlstatic.com/D_SECOND-O.jpg'];
const item = { id, title: 'Libro de prueba', price: 500, currency: 'UYU', status: 'active', available_quantity: 1, pictures: sources };
const image = position => `https://www.amadolibros.com/book-cover/${id}/${position ? 'cover-2.jpg' : 'cover.jpg'}`;
const entry = (position, width, height) => ({ current: {
  object_key: `covers/v1/objects/${String(position + 1).repeat(64)}.jpg`, sha256: String(position + 1).repeat(64),
  mime: 'image/jpeg', source_url: sources[position], width, height,
} });

async function page(bucket) {
  const previous = globalThis.caches;
  globalThis.caches = { default: { match: async request => request.url === CATALOG_URL ? Response.json({ items: [item] }) : undefined } };
  try {
    const response = await onRequest({ request: new Request(url), params: { path: [id, slug] }, data: {},
      env: { APP_ENV: 'production', COVER_GOOGLE_QUALITY_GATE: 'true', COVER_R2: bucket } });
    assert.equal(response.status, 200);
    return await response.text();
  } finally { if (previous) globalThis.caches = previous; else delete globalThis.caches; }
}
const bucket = entries => ({ get: async () => ({ text: async () => JSON.stringify({ schema_version: 1, entries }) }) });

test('regresión 426×500: el handler productivo conserva portada y oferta', async () => {
  const html = await page(bucket({ [`${id}:0`]: entry(0,426,500) }));
  assert.deepEqual(inspectProductImages(html).products[0].images, [image(0)]);
  assert.deepEqual(inspectProductHtml(html,url).issues, []);
  assert.match(html, /"@type":"Offer"/);
});
test('índice ausente, corrupto o inaccesible conserva la foto real sin esconder la falla', async () => {
  for (const data of [
    { get: async () => null },
    { get: async () => ({ text: async () => '{invalid' }) },
    { get: async () => { throw new Error('R2 unavailable'); } },
  ]) assert.deepEqual(inspectProductImages(await page(data)).products[0].images, [image(0)]);
});
test('la secundaria de calidad va primera, y la chica se conserva en vez de tirarse', async () => {
  // La portada (426×500) sirve hoy pero no llega al mínimo de 2027; la
  // secundaria (800×1000) cumple las dos. Google toma la PRIMERA como
  // principal, así que la buena va adelante — pero la otra no se descarta:
  // descartarla era lo que dejaba miles de libros sin imagen para Google.
  const html = await page(bucket({ [`${id}:0`]: entry(0,426,500), [`${id}:1`]: entry(1,800,1000) }));
  assert.deepEqual(inspectProductImages(html).products[0].images, [image(1), image(0)]);
  assert.match(html, /class="cover-main"/);
  assert.match(html, /data-idx="1"/);
});
test('sin fotos reales no inventa logo ni una imagen vacía y la auditoría lo detecta', () => {
  const html = renderPage({ ...item, pictures: [], thumbnail: '' },slug,false,'','',[],[]);
  const result = inspectProductImages(html);
  assert.deepEqual(result.products[0].images, []);
  assert.ok(inspectProductHtml(html,url).issues.includes('PRODUCT_IMAGE_MISSING'));
});
test('detector lee Product de @graph; og:image y otros esquemas no ocultan su ausencia', () => {
  const schema = object => `<meta property="og:image" content="${image(0)}"><script type="application/ld+json">${JSON.stringify(object)}</script>`;
  assert.ok(inspectProductImages(schema({ '@graph': [{ '@type':'Organization', image:image(0) }, { '@type':['Book','Product'], sku:id }] })).issues.includes('PRODUCT_IMAGE_MISSING'));
  assert.deepEqual(inspectProductImages(schema({ '@type':'Product',image:[{ '@type':'ImageObject',contentUrl:image(0) }] })).issues, []);
  for (const invalid of ['', [], null]) assert.ok(inspectProductImages(schema({ '@type':'Product',image:invalid })).issues.includes('PRODUCT_IMAGE_MISSING'));
  for (const invalid of ['javascript:alert(1)', '/relative.jpg', 'https://www.amadolibros.com/images/logo-amado.webp'])
    assert.ok(inspectProductImages(schema({ '@type':'Product',image:invalid })).issues.includes('PRODUCT_IMAGE_INVALID'));
  assert.ok(inspectProductImages('<script type="application/ld+json">broken</script>').issues.includes('PRODUCT_JSONLD_INVALID'));
});
test('auditor conserva fichas editoriales Book; no permite que Book oculte un Product sin imagen', () => {
  const book='<script type="application/ld+json">{"@type":"Book","name":"Libro"}</script>';
  assert.deepEqual(inspectProductImages(book,{allowBookOnly:true}).issues,[]);
  assert.ok(inspectProductImages(book).issues.includes('PRODUCT_SCHEMA_MISSING'));
  assert.ok(inspectProductImages(book+'<script type="application/ld+json">{"@type":"Product"}</script>',{allowBookOnly:true}).issues.includes('PRODUCT_IMAGE_MISSING'));
});
