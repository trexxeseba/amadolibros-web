import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PREVIEW_COVER_MANIFEST_KEY,
  findPreviewCover,
  previewCoverSummary,
  previewCoverUrl,
} from '../_shared/preview-cover.js';
import { onRequest as coverRequest } from '../preview-cover/[[path]].js';
import { renderPage } from '../libro/[[path]].js';

const ID = 'MLU123456789';
const HASH = 'a'.repeat(64);
const SOURCE = 'https://http2.mlstatic.com/D_TEST-O.jpg';
const OBJECT_KEY = `covers/v1/objects/${HASH}.jpg`;

function manifest(overrides = {}) {
  return {
    schema_version: 1,
    updated_at: '2026-08-09T21:00:00.000Z',
    entries: {
      [`${ID}:0`]: {
        product_id: ID,
        position: 0,
        current: {
          object_key: OBJECT_KEY,
          sha256: HASH,
          mime: 'image/jpeg',
          source_url: SOURCE,
        },
      },
    },
    ...overrides,
  };
}

function bucket({ manifestValue = manifest(), image = new Uint8Array([1, 2, 3]) } = {}) {
  const reads = [];
  return {
    reads,
    async get(key) {
      reads.push(key);
      if (key === PREVIEW_COVER_MANIFEST_KEY) {
        return { async text() { return JSON.stringify(manifestValue); } };
      }
      if (key === OBJECT_KEY) return { body: image, size: image.byteLength };
      return null;
    },
  };
}

function ctx({ appEnv = 'preview', coverBucket = bucket(), path = [], method = 'GET' } = {}) {
  return {
    request: new Request('https://cover-ui.example/preview-cover/test', { method }),
    params: { path },
    env: { APP_ENV: appEnv, COVER_R2: coverBucket },
    data: {},
  };
}

test('Preview resuelve una URL inmutable del mismo origen y memoiza el manifest', async () => {
  const coverBucket = bucket();
  const context = ctx({ coverBucket });
  const first = await previewCoverUrl(context, ID, 0, SOURCE);
  const second = await previewCoverUrl(context, ID, 0, SOURCE);
  assert.equal(first, `https://cover-ui.example/preview-cover/${ID}/0/${HASH}.jpg`);
  assert.equal(second, first);
  assert.deepEqual(coverBucket.reads, [PREVIEW_COVER_MANIFEST_KEY]);
});

test('Producción no consulta el bucket ni expone una portada Preview', async () => {
  const coverBucket = bucket();
  const result = await previewCoverUrl(ctx({ appEnv: 'production', coverBucket }), ID, 0, SOURCE);
  assert.equal(result, null);
  assert.deepEqual(coverBucket.reads, []);
});

test('URL origen modificada conserva el fallback de Mercado Libre', async () => {
  const result = await previewCoverUrl(
    ctx(), ID, 0, 'https://http2.mlstatic.com/D_CHANGED-O.jpg'
  );
  assert.equal(result, null);
});

test('Manifest u objeto actual incoherente se rechazan sin lanzar error', async () => {
  const broken = manifest();
  broken.entries[`${ID}:0`].current.sha256 = 'b'.repeat(64);
  assert.equal(await findPreviewCover(ctx({ coverBucket: bucket({ manifestValue: broken }) }), ID), null);
});

test('Ruta pública sirve sólo el objeto exacto referenciado, con caché inmutable', async () => {
  const response = await coverRequest(ctx({ path: [ID, '0', `${HASH}.jpg`] }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/jpeg');
  assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(response.headers.get('etag'), `"${HASH}"`);
  assert.equal(response.headers.get('x-amado-cover-source'), 'r2-preview');
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3]);
});

test('HEAD valida la misma portada y devuelve headers sin cuerpo', async () => {
  const response = await coverRequest(ctx({
    path: [ID, '0', `${HASH}.jpg`],
    method: 'HEAD',
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/jpeg');
  assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(await response.text(), '');
});

test('Ruta rechaza hash ajeno, métodos de escritura y cualquier acceso en Producción', async () => {
  const wrongHash = await coverRequest(ctx({ path: [ID, '0', `${'b'.repeat(64)}.jpg`] }));
  assert.equal(wrongHash.status, 404);
  const post = await coverRequest(ctx({ path: [ID, '0', `${HASH}.jpg`], method: 'POST' }));
  assert.equal(post.status, 405);
  const production = await coverRequest(ctx({
    appEnv: 'production', path: [ID, '0', `${HASH}.jpg`],
  }));
  assert.equal(production.status, 404);
});

test('Status Preview expone sólo conteo y un ID de muestra; Producción devuelve 404', async () => {
  const summary = await previewCoverSummary(ctx());
  assert.deepEqual(summary, { entries: 1, with_valid_copy: 1, sample_product_id: ID });
  const response = await coverRequest(ctx({ path: ['status'] }));
  assert.deepEqual(await response.json(), summary);
  const production = await coverRequest(ctx({ appEnv: 'production', path: ['status'] }));
  assert.equal(production.status, 404);
});

test('Ficha usa la portada R2 sólo como primera imagen y conserva las secundarias', () => {
  const previewSrc = `https://cover-ui.example/preview-cover/${ID}/0/${HASH}.jpg`;
  const html = renderPage({
    id: ID,
    title: 'Libro de prueba',
    author: 'Autora',
    price: 1200,
    status: 'active',
    available_quantity: 1,
    condition: 'new',
    pictures: [SOURCE, 'https://http2.mlstatic.com/D_SECOND-O.jpg'],
    thumbnail: '',
    permalink: 'https://articulo.mercadolibre.com.uy/test',
  }, 'libro-de-prueba', true, '', previewSrc);
  assert.match(html, new RegExp(`class="cover-main"[^>]+src="${previewSrc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  assert.match(html, /https:\/\/http2\.mlstatic\.com\/D_SECOND-O\.jpg/);
  assert.match(html, new RegExp(`data-thumbnail="${previewSrc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
});
