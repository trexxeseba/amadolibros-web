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

test('el proxy sirve posiciones secundarias desde subdominios oficiales de mlstatic', async () => {
  const originalFetch = globalThis.fetch;
  const galleryItem = {
    ...item,
    pictures: [
      item.pictures[0],
      'https://mlu-s2-p.mlstatic.com/D_SECOND-O.jpg',
    ],
  };
  globalThis.caches = { default: { async match() { return null; }, async put() {} } };
  globalThis.fetch = async input => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === CATALOG_URL) return Response.json({ items: [galleryItem] });
    if (url === galleryItem.pictures[1]) {
      return new Response(new Uint8Array([4, 5, 6]), {
        headers: { 'content-type': 'image/jpeg' },
      });
    }
    throw new Error(`fetch inesperado: ${url}`);
  };
  try {
    const response = await coverRequest({
      request: new Request(`https://www.amadolibros.com/book-cover/${item.id}/cover-2.jpg`),
      params: { path: [item.id, 'cover-2.jpg'] },
      env: { APP_ENV: 'production' },
      data: {},
      waitUntil() {},
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-cover-source'), 'mercadolibre');
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [4, 5, 6]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('el proxy prioriza la copia R2 y no consulta mlstatic cuando existe', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.caches = { default: { async match() { return null; }, async put() {} } };
  const hash = 'a'.repeat(64);
  const objectKey = `covers/v1/objects/${hash}.jpg`;
  const manifest = {
    schema_version: 1,
    updated_at: '2026-08-16T12:00:00Z',
    entries: {
      [`${item.id}:0`]: {
        product_id: item.id,
        position: 0,
        current: {
          object_key: objectKey,
          sha256: hash,
          mime: 'image/jpeg',
          source_url: item.pictures[0],
        },
      },
    },
  };
  const bucket = {
    async get(key) {
      if (key === 'covers/v1/manifest.json') return { text: async () => JSON.stringify(manifest) };
      if (key === objectKey) return { body: new Uint8Array([9, 8, 7]) };
      return null;
    },
  };
  globalThis.fetch = async input => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === CATALOG_URL) return Response.json({ items: [item] });
    throw new Error(`no debía consultar origen: ${url}`);
  };
  try {
    const ctx = {
      request: new Request(`https://www.amadolibros.com/book-cover/${item.id}/cover.jpg`),
      params: { path: [item.id, 'cover.jpg'] },
      env: { APP_ENV: 'production', COVER_R2: bucket },
      data: {},
      waitUntil() {},
    };
    const response = await coverRequest(ctx);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-cover-source'), 'r2-production');
    assert.equal(response.headers.get('etag'), `"${hash}"`);
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [9, 8, 7]);
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
