import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MANIFEST_KEY,
  importCovers,
} from '../lib/cover-pilot.js';

const SOURCE_A = 'https://http2.mlstatic.com/D_NQ_NP_123456-MLU12345678901_012026-O.webp';
const SOURCE_B = 'https://http2.mlstatic.com/D_NQ_NP_987654-MLU12345678901_022026-O.webp';

function pngBytes(width = 300, height = 450, salt = 0) {
  const bytes = new Uint8Array(45);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  bytes.set([0, 0, 0, 13], 8);
  bytes.set([73, 72, 68, 82], 12); // IHDR
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 2, 0, 0, 0], 24);
  bytes[32] = salt;
  bytes.set([0, 0, 0, 0], 33);
  bytes.set([73, 69, 78, 68], 37); // IEND
  bytes[44] = salt;
  return bytes;
}

function imageResponse(bytes = pngBytes(), headers = {}) {
  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'Content-Length': String(bytes.byteLength),
      ...headers,
    },
  });
}

class MockR2 {
  constructor() {
    this.objects = new Map();
    this.operations = [];
  }

  async get(key) {
    this.operations.push(`get:${key}`);
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      text: async () => new TextDecoder().decode(object.bytes),
      arrayBuffer: async () => object.bytes.buffer.slice(
        object.bytes.byteOffset,
        object.bytes.byteOffset + object.bytes.byteLength,
      ),
    };
  }

  async head(key) {
    this.operations.push(`head:${key}`);
    const object = this.objects.get(key);
    return object ? { size: object.bytes.byteLength } : null;
  }

  async put(key, body, options = {}) {
    this.operations.push(`put:${key}`);
    const bytes = typeof body === 'string'
      ? new TextEncoder().encode(body)
      : new Uint8Array(body);
    this.objects.set(key, { bytes: bytes.slice(), options });
  }

  manifest() {
    const object = this.objects.get(MANIFEST_KEY);
    return object ? JSON.parse(new TextDecoder().decode(object.bytes)) : null;
  }
}

function payload(url = SOURCE_A) {
  return {
    items: [{ product_id: 'MLU123456789', position: 0, url }],
  };
}

test('rechaza más de 20 imágenes antes de tocar R2 o la red', async () => {
  const bucket = new MockR2();
  const items = Array.from({ length: 21 }, (_, index) => ({
    product_id: `MLU${String(100000000 + index)}`,
    position: 0,
    url: SOURCE_A,
  }));
  let fetched = false;
  await assert.rejects(
    importCovers({ COVER_R2: bucket }, { items }, {
      fetchFn: async () => { fetched = true; return imageResponse(); },
    }),
    error => error.code === 'ITEM_LIMIT_EXCEEDED',
  );
  assert.equal(fetched, false);
  assert.deepEqual(bucket.operations, []);
});

test('rechaza hosts que no sean el origen HTTPS exacto de Mercado Libre', async () => {
  const bucket = new MockR2();
  await assert.rejects(
    importCovers({ COVER_R2: bucket }, payload('https://example.com/cover.png')),
    error => error.code === 'SOURCE_HOST_NOT_ALLOWED',
  );
  await assert.rejects(
    importCovers({ COVER_R2: bucket }, payload('http://http2.mlstatic.com/cover.png')),
    error => error.code === 'SOURCE_HOST_NOT_ALLOWED',
  );
});

test('guarda por SHA-256, verifica R2 y publica el manifest último', async () => {
  const bucket = new MockR2();
  const result = await importCovers({ COVER_R2: bucket }, payload(), {
    fetchFn: async () => imageResponse(pngBytes(), { ETag: '"cover-v1"' }),
    now: () => new Date('2026-08-09T20:00:00Z'),
  });

  assert.equal(result.failed, 0);
  assert.equal(result.imported, 1);
  assert.match(result.results[0].object_key, /^covers\/v1\/objects\/[a-f0-9]{64}\.png$/);
  const puts = bucket.operations.filter(operation => operation.startsWith('put:'));
  assert.equal(puts.at(-1), `put:${MANIFEST_KEY}`);
  assert.equal(puts.length, 2);

  const manifest = bucket.manifest();
  const entry = manifest.entries['MLU123456789:0'];
  assert.equal(entry.current.width, 300);
  assert.equal(entry.current.height, 450);
  assert.equal(entry.current.source_url, SOURCE_A);
  assert.equal(entry.source_validators.etag, '"cover-v1"');
  assert.equal(entry.last_error, null);
});

test('no vuelve a descargar una URL validada hace menos de 30 días', async () => {
  const bucket = new MockR2();
  let fetches = 0;
  const fetchFn = async () => { fetches += 1; return imageResponse(); };
  await importCovers({ COVER_R2: bucket }, payload(), {
    fetchFn,
    now: () => new Date('2026-08-01T00:00:00Z'),
  });
  const second = await importCovers({ COVER_R2: bucket }, payload(), {
    fetchFn,
    now: () => new Date('2026-08-20T00:00:00Z'),
  });
  assert.equal(fetches, 1);
  assert.equal(second.results[0].status, 'fresh-skip');
});

test('a los 30 días revalida con ETag y conserva el objeto ante 304', async () => {
  const bucket = new MockR2();
  await importCovers({ COVER_R2: bucket }, payload(), {
    fetchFn: async () => imageResponse(pngBytes(), {
      ETag: '"cover-v1"',
      'Last-Modified': 'Sat, 01 Aug 2026 00:00:00 GMT',
    }),
    now: () => new Date('2026-08-01T00:00:00Z'),
  });
  const oldKey = bucket.manifest().entries['MLU123456789:0'].current.object_key;
  let conditionalHeaders;
  const second = await importCovers({ COVER_R2: bucket }, payload(), {
    fetchFn: async (_url, options) => {
      conditionalHeaders = options.headers;
      return new Response(null, { status: 304 });
    },
    now: () => new Date('2026-09-01T00:00:00Z'),
  });
  assert.equal(conditionalHeaders['If-None-Match'], '"cover-v1"');
  assert.equal(conditionalHeaders['If-Modified-Since'], 'Sat, 01 Aug 2026 00:00:00 GMT');
  assert.equal(second.results[0].status, 'not-modified');
  assert.equal(bucket.manifest().entries['MLU123456789:0'].current.object_key, oldKey);
});

test('una portada cambiada reemplaza el puntero y conserva la clave anterior', async () => {
  const bucket = new MockR2();
  await importCovers({ COVER_R2: bucket }, payload(), {
    fetchFn: async () => imageResponse(pngBytes(300, 450, 1)),
    now: () => new Date('2026-08-01T00:00:00Z'),
  });
  const oldKey = bucket.manifest().entries['MLU123456789:0'].current.object_key;
  const second = await importCovers({ COVER_R2: bucket }, payload(), {
    fetchFn: async () => imageResponse(pngBytes(301, 450, 2)),
    now: () => new Date('2026-09-01T00:00:00Z'),
  });
  const entry = bucket.manifest().entries['MLU123456789:0'];
  assert.equal(second.results[0].status, 'imported');
  assert.equal(second.results[0].replaced_previous, true);
  assert.notEqual(entry.current.object_key, oldKey);
  assert.equal(entry.previous_object_key, oldKey);
  assert.equal(bucket.objects.has(oldKey), true, 'el piloto no borra la copia anterior');
});

test('si la URL nueva falla mantiene visible la última copia válida', async () => {
  const bucket = new MockR2();
  await importCovers({ COVER_R2: bucket }, payload(), {
    fetchFn: async () => imageResponse(),
    now: () => new Date('2026-08-01T00:00:00Z'),
  });
  const oldEntry = structuredClone(bucket.manifest().entries['MLU123456789:0']);
  const second = await importCovers({ COVER_R2: bucket }, payload(SOURCE_B), {
    fetchFn: async () => new Response('fallo', { status: 503 }),
    now: () => new Date('2026-08-02T00:00:00Z'),
  });
  const entry = bucket.manifest().entries['MLU123456789:0'];
  assert.equal(second.failed, 1);
  assert.equal(second.results[0].retained_previous, true);
  assert.equal(entry.current.object_key, oldEntry.current.object_key);
  assert.equal(entry.current.source_url, SOURCE_A);
  assert.equal(entry.last_attempted_source_url, SOURCE_B);
  assert.equal(entry.last_error.code, 'SOURCE_HTTP_ERROR');
});

test('rechaza redirecciones y no escribe un objeto de imagen', async () => {
  const bucket = new MockR2();
  const result = await importCovers({ COVER_R2: bucket }, payload(), {
    fetchFn: async () => new Response(null, { status: 302, headers: { Location: 'https://example.com/x' } }),
  });
  assert.equal(result.failed, 1);
  assert.equal(result.results[0].code, 'SOURCE_REDIRECT_REJECTED');
  assert.deepEqual(
    bucket.operations.filter(operation => operation.startsWith('put:covers/v1/objects/')),
    [],
  );
});

test('rechaza MIME que no coincide con la firma del archivo', async () => {
  const bucket = new MockR2();
  const result = await importCovers({ COVER_R2: bucket }, payload(), {
    fetchFn: async () => imageResponse(pngBytes(), { 'Content-Type': 'image/jpeg' }),
  });
  assert.equal(result.failed, 1);
  assert.equal(result.results[0].code, 'IMAGE_MIME_MISMATCH');
});
