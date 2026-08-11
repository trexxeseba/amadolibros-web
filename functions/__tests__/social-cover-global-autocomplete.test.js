import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { onRequest as coverRequest, primaryCoverSource } from '../book-cover/[[path]].js';
import { renderPage } from '../libro/[[path]].js';
import { CATALOG_URL } from '../_shared/catalog.js';

const item = {
  id: 'MLU1430305290', title: 'Flauta Yamaha', status: 'active', available_quantity: 1,
  price: 1190, pictures: ['https://http2.mlstatic.com/D_PORTADA-O.jpg'],
  thumbnail: 'https://http2.mlstatic.com/D_PORTADA-I.jpg', permalink: 'https://example.com/item',
};

test('la ficha usa portada social del dominio y carga autocompletado global', () => {
  const html = renderPage(item, 'flauta-yamaha', false, '');
  const expected = 'https://www.amadolibros.com/book-cover/MLU1430305290/cover.jpg';
  assert.match(html, new RegExp(`<meta property="og:image"\\s+content="${expected}">`));
  assert.match(html, new RegExp(`<meta property="og:image:secure_url" content="${expected}">`));
  assert.match(html, /<script src="\/search-autocomplete\.js" defer><\/script>/);
});

test('el proxy solo acepta portada mlstatic y pide variante grande', () => {
  assert.equal(primaryCoverSource({ thumbnail: 'http://http2.mlstatic.com/D_ABC-I.jpg' }), 'https://http2.mlstatic.com/D_ABC-O.jpg');
  assert.equal(primaryCoverSource({ thumbnail: 'https://evil.example/cover.jpg' }), '');
});

test('el proxy entrega bytes de imagen con caché pública y admite HEAD', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.caches = { default: { async match() { return null; }, async put() {} } };
  globalThis.fetch = async input => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === CATALOG_URL) return Response.json({ items: [item] });
    if (url === item.pictures[0]) return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } });
    throw new Error(`fetch inesperado: ${url}`);
  };
  try {
    const ctx = method => ({ request: new Request('https://www.amadolibros.com/book-cover/MLU1430305290/cover.jpg', { method }), params: { path: ['MLU1430305290', 'cover.jpg'] }, env: { APP_ENV: 'production' }, waitUntil() {} });
    const get = await coverRequest(ctx('GET'));
    assert.equal(get.status, 200);
    assert.equal(get.headers.get('content-type'), 'image/jpeg');
    assert.match(get.headers.get('cache-control'), /s-maxage=604800/);
    assert.deepEqual([...new Uint8Array(await get.arrayBuffer())], [1, 2, 3]);
    const head = await coverRequest(ctx('HEAD'));
    assert.equal(head.status, 200);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('el script compartido apunta a todos los buscadores del catálogo', () => {
  const script = readFileSync(new URL('../../astro-front/public/search-autocomplete.js', import.meta.url), 'utf8');
  assert.match(script, /form\[action="\/catalogo"\] input\[name="q"\]/);
  assert.match(script, /api\/search-suggestions/);
  assert.match(script, /aria-autocomplete/);
});
