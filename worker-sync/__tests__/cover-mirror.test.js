import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COVER_MANIFEST_KEY,
  primaryCoverCandidate,
  selectCoverBatch,
  syncCoverMirror,
} from '../cover-mirror.js';

const SOURCE = 'https://http2.mlstatic.com/D_123-MLU123-O.jpg';

function pngBytes(width = 600, height = 900, salt = 0) {
  const bytes = new Uint8Array(45);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  bytes.set([0, 0, 0, 13, 73, 72, 68, 82], 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[32] = salt;
  bytes.set([73, 69, 78, 68], 37);
  return bytes;
}

class MockR2 {
  constructor(manifest = null) {
    this.objects = new Map();
    if (manifest) this.objects.set(COVER_MANIFEST_KEY, new TextEncoder().encode(JSON.stringify(manifest)));
  }
  async get(key) {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    return { body: bytes, text: async () => new TextDecoder().decode(bytes) };
  }
  async head(key) {
    const bytes = this.objects.get(key);
    return bytes ? { size: bytes.byteLength } : null;
  }
  async put(key, body) {
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body);
    this.objects.set(key, bytes.slice());
  }
  manifest() {
    return JSON.parse(new TextDecoder().decode(this.objects.get(COVER_MANIFEST_KEY)));
  }
}

function item(id = 'MLU123456', patch = {}) {
  return {
    id,
    status: 'active',
    available_quantity: 1,
    pictures: [SOURCE.replace('123-O', `${id}-O`)],
    thumbnail: '',
    ...patch,
  };
}

test('normaliza miniatura y excluye productos no activos o sin origen ML', () => {
  assert.equal(
    primaryCoverCandidate(item('MLU123456', { pictures: [], thumbnail: 'http://http2.mlstatic.com/D_X-I.jpg' })).source_url,
    'https://http2.mlstatic.com/D_X-O.jpg',
  );
  assert.equal(primaryCoverCandidate(item('MLU123456', { status: 'paused' })), null);
  assert.equal(primaryCoverCandidate(item('MLU123456', { pictures: ['https://example.com/x.jpg'] })), null);
});

test('prioriza faltantes, después URL cambiada y al final revalidaciones vencidas', () => {
  const now = Date.parse('2026-08-16T12:00:00Z');
  const catalog = { items: [item('MLU100001'), item('MLU100002'), item('MLU100003')] };
  const manifest = {
    schema_version: 1,
    updated_at: '2026-08-01T00:00:00Z',
    entries: {
      'MLU100002:0': {
        current: { object_key: 'old', source_url: 'https://http2.mlstatic.com/OLD-O.jpg' },
        last_validated_at: '2026-08-15T00:00:00Z',
      },
      'MLU100003:0': {
        current: { object_key: 'old2', source_url: item('MLU100003').pictures[0] },
        last_validated_at: '2026-06-01T00:00:00Z',
      },
    },
  };
  const batch = selectCoverBatch(catalog, manifest, { limit: 3, nowMs: now });
  assert.deepEqual(batch.selected.map(row => row.product_id), ['MLU100001', 'MLU100002', 'MLU100003']);
});

test('copia bytes verificados a R2 y publica el manifest al final', async () => {
  const bucket = new MockR2();
  const result = await syncCoverMirror(
    { COVER_R2: bucket, COVER_MIRROR_BATCH_SIZE: '20' },
    { items: [item()] },
    {
      now: () => new Date('2026-08-16T12:00:00Z'),
      fetchFn: async () => new Response(pngBytes(), { headers: { 'content-type': 'image/png' } }),
    },
  );
  assert.equal(result.failed, 0);
  assert.equal(result.imported, 1);
  assert.equal(result.pending, 0);
  const entry = bucket.manifest().entries['MLU123456:0'];
  assert.match(entry.current.object_key, /^covers\/v1\/objects\/[a-f0-9]{64}\.png$/);
  assert.equal(entry.current.width, 600);
  assert.equal(entry.current.height, 900);
  assert.equal(bucket.objects.has(entry.current.object_key), true);
});

test('una descarga fallida conserva la última copia y registra el error', async () => {
  const previous = {
    schema_version: 1,
    updated_at: '2026-08-01T00:00:00Z',
    entries: {
      'MLU123456:0': {
        product_id: 'MLU123456', position: 0,
        current: { object_key: 'covers/v1/objects/old.jpg', source_url: 'https://http2.mlstatic.com/OLD-O.jpg' },
        last_validated_at: '2026-08-01T00:00:00Z',
      },
    },
  };
  const bucket = new MockR2(previous);
  const result = await syncCoverMirror(
    { COVER_R2: bucket },
    { items: [item()] },
    { fetchFn: async () => new Response('bloqueado', { status: 403 }), limit: 1 },
  );
  assert.equal(result.failed, 1);
  assert.equal(result.pending, 1);
  const entry = bucket.manifest().entries['MLU123456:0'];
  assert.equal(entry.current.object_key, 'covers/v1/objects/old.jpg');
  assert.match(entry.last_error.message, /HTTP 403/);
});
