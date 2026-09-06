import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COVER_MANIFEST_KEY,
  coverCandidates,
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
    this.versions = new Map();
    this.conflictManifestOnce = null;
    if (manifest) this.write(COVER_MANIFEST_KEY, new TextEncoder().encode(JSON.stringify(manifest)));
  }
  etag(key) {
    return `etag-${this.versions.get(key) || 0}`;
  }
  write(key, bytes) {
    this.objects.set(key, bytes.slice());
    this.versions.set(key, (this.versions.get(key) || 0) + 1);
  }
  async get(key) {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    return { body: bytes, etag: this.etag(key), text: async () => new TextDecoder().decode(bytes) };
  }
  async head(key) {
    const bytes = this.objects.get(key);
    return bytes ? { size: bytes.byteLength } : null;
  }
  async put(key, body, options = {}) {
    if (key === COVER_MANIFEST_KEY && this.conflictManifestOnce) {
      const manifest = this.conflictManifestOnce(this.objects.has(key) ? this.manifest() : null);
      this.conflictManifestOnce = null;
      this.write(key, new TextEncoder().encode(JSON.stringify(manifest)));
      return null;
    }
    const current = this.objects.has(key) ? this.etag(key) : null;
    const onlyIf = options.onlyIf || null;
    if (onlyIf?.etagMatches && onlyIf.etagMatches !== current) return null;
    if (onlyIf?.etagDoesNotMatch === '*' && current) return null;
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body);
    this.write(key, bytes);
    return { etag: this.etag(key) };
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
    price: 1000,
    currency: 'UYU',
    domain_id: 'MLU-BOOKS',
    permalink: `https://articulo.mercadolibre.com.uy/${id}`,
    pictures: [SOURCE.replace('123-O', `${id}-O`)],
    thumbnail: '',
    ...patch,
  };
}

function imagesBinding({ fail = false } = {}) {
  const observed = {};
  return {
    observed,
    input() {
      const chain = {
        transform(options) {
          observed.transform = options;
          return chain;
        },
        async output(options) {
          observed.output = options;
          if (fail) throw new Error('AI temporalmente no disponible');
          return {
            response: () => new Response(pngBytes(1024, 1536, 7), {
              headers: { 'content-type': 'image/png' },
            }),
          };
        },
      };
      return chain;
    },
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

test('genera candidatos para todas las posiciones oficiales de una galería', () => {
  const candidates = coverCandidates(item('MLU123456', {
    pictures: Array.from({ length: 18 }, (_, index) =>
      `https://mlu-s2-p.mlstatic.com/D_GALLERY_${index + 1}-O.jpg`),
  }));
  assert.equal(candidates.length, 16);
  assert.deepEqual(candidates.map(candidate => candidate.position), Array.from({ length: 16 }, (_, index) => index));
  assert.equal(candidates[15].source_url, 'https://mlu-s2-p.mlstatic.com/D_GALLERY_16-O.jpg');
});

test('copia cada posición de la galería a R2 con entradas independientes', async () => {
  const bucket = new MockR2();
  const result = await syncCoverMirror(
    { COVER_R2: bucket },
    { items: [item('MLU123456', {
      pictures: [
        'https://http2.mlstatic.com/D_MAIN-O.jpg',
        'https://mlu-s2-p.mlstatic.com/D_SECOND-O.jpg',
      ],
    })] },
    {
      fetchFn: async () => new Response(pngBytes(), { headers: { 'content-type': 'image/png' } }),
    },
  );
  assert.equal(result.imported, 2);
  assert.ok(bucket.manifest().entries['MLU123456:0'].current.object_key);
  assert.ok(bucket.manifest().entries['MLU123456:1'].current.object_key);
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

test('completa portadas principales de distintos libros antes que galerías secundarias', () => {
  const catalog = {
    items: [
      item('MLU100001', {
        pictures: [
          'https://http2.mlstatic.com/D_MLU100001_MAIN-O.jpg',
          'https://http2.mlstatic.com/D_MLU100001_SECOND-O.jpg',
        ],
      }),
      item('MLU100002', {
        pictures: [
          'https://http2.mlstatic.com/D_MLU100002_MAIN-O.jpg',
          'https://http2.mlstatic.com/D_MLU100002_SECOND-O.jpg',
        ],
      }),
    ],
  };

  const batch = selectCoverBatch(catalog, { schema_version: 1, entries: {} }, { limit: 2 });
  assert.deepEqual(
    batch.selected.map(row => `${row.product_id}:${row.position}`),
    ['MLU100001:0', 'MLU100002:0'],
  );
});

test('la política nueva reprocesa copias anteriores aunque sean recientes', () => {
  const now = Date.parse('2026-08-16T12:00:00Z');
  const catalog = { items: [item()] };
  const manifest = {
    schema_version: 1,
    updated_at: '2026-08-16T11:00:00Z',
    entries: {
      'MLU123456:0': {
        current: {
          object_key: 'covers/v1/objects/low.png',
          source_url: item().pictures[0],
          mime: 'image/png', width: 400, height: 600,
        },
        last_validated_at: '2026-08-16T11:00:00Z',
      },
    },
  };
  assert.equal(selectCoverBatch(catalog, manifest, { nowMs: now }).selected.length, 1);
  assert.equal(selectCoverBatch(catalog, manifest, { nowMs: now, aiUpscaleEnabled: true }).selected.length, 1);
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

test('Cloudflare Images mejora la copia R2 y conserva el original inmutable', async () => {
  const bucket = new MockR2();
  const images = imagesBinding();
  const result = await syncCoverMirror(
    { COVER_R2: bucket, COVER_ALLOW_GENERATIVE_UPSCALE: 'true', IMAGES: images },
    { items: [item()] },
    {
      now: () => new Date('2026-08-16T12:00:00Z'),
      fetchFn: async () => new Response(pngBytes(400, 600), { headers: { 'content-type': 'image/png' } }),
    },
  );
  assert.equal(result.failed, 0);
  assert.equal(result.ai_upscaled, 1);
  assert.equal(result.quality_pending, 0);
  assert.deepEqual(images.observed.transform, { width: 1024, fit: 'scale-up', upscale: 'generate' });
  assert.deepEqual(images.observed.output, { format: 'image/jpeg', quality: 90 });
  const entry = bucket.manifest().entries['MLU123456:0'];
  assert.equal(entry.current.width, 1024);
  assert.equal(entry.current.height, 1536);
  assert.equal(entry.current.transform.kind, 'cloudflare-ai-upscale');
  assert.notEqual(entry.current.object_key, entry.current.original_object_key);
  assert.equal(bucket.objects.has(entry.current.object_key), true);
  assert.equal(bucket.objects.has(entry.current.original_object_key), true);
});

test('si la mejora IA falla mantiene la portada original y registra el motivo', async () => {
  const bucket = new MockR2();
  const result = await syncCoverMirror(
    { COVER_R2: bucket, COVER_ALLOW_GENERATIVE_UPSCALE: 'true', IMAGES: imagesBinding({ fail: true }) },
    { items: [item()] },
    {
      now: () => new Date('2026-08-16T12:00:00Z'),
      fetchFn: async () => new Response(pngBytes(400, 600), { headers: { 'content-type': 'image/png' } }),
    },
  );
  assert.equal(result.failed, 0);
  assert.equal(result.quality_pending, 1);
  assert.equal(result.results[0].quality_status, 'original-retained');
  const entry = bucket.manifest().entries['MLU123456:0'];
  assert.equal(entry.current.width, 400);
  assert.match(entry.last_transform_error.message, /temporalmente no disponible/);
  assert.equal(bucket.objects.has(entry.current.object_key), true);
});

test('no consume Images para un producto que Merchant excluye', async () => {
  const bucket = new MockR2();
  const images = imagesBinding();
  const result = await syncCoverMirror(
    { COVER_R2: bucket, COVER_ALLOW_GENERATIVE_UPSCALE: 'true', IMAGES: images },
    { items: [item('MLU999999', { domain_id: 'MLU-COMPUTER_COMPONENTS' })] },
    {
      now: () => new Date('2026-08-16T12:00:00Z'),
      fetchFn: async () => new Response(pngBytes(400, 600), { headers: { 'content-type': 'image/png' } }),
    },
  );
  assert.equal(result.failed, 0);
  assert.equal(result.ai_upscaled, 0);
  assert.equal(result.quality_pending, 0);
  assert.equal(images.observed.transform, undefined);
  assert.equal(bucket.manifest().entries['MLU999999:0'].current.width, 400);
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

test('reintenta el put condicional y fusiona entradas de dos corridas concurrentes', async () => {
  const bucket = new MockR2();
  bucket.conflictManifestOnce = () => ({
    schema_version: 1,
    updated_at: '2026-08-16T11:59:59.000Z',
    entries: {
      'MLU999999:0': {
        product_id: 'MLU999999', position: 0,
        current: {
          object_key: `covers/v1/objects/${'b'.repeat(64)}.jpg`,
          sha256: 'b'.repeat(64), mime: 'image/jpeg',
          source_url: 'https://http2.mlstatic.com/D_CONCURRENT-O.jpg',
        },
        last_validated_at: '2026-08-16T11:59:59.000Z',
      },
    },
  });

  const result = await syncCoverMirror(
    { COVER_R2: bucket },
    { items: [item()] },
    {
      now: () => new Date('2026-08-16T12:00:00.000Z'),
      fetchFn: async () => new Response(pngBytes(), { headers: { 'content-type': 'image/png' } }),
    },
  );

  assert.equal(result.manifest_retries, 1);
  assert.ok(bucket.manifest().entries['MLU123456:0'].current.object_key);
  assert.equal(
    bucket.manifest().entries['MLU999999:0'].current.object_key,
    `covers/v1/objects/${'b'.repeat(64)}.jpg`,
  );
});

test('un intento fallido concurrente no pisa una copia válida más nueva', async () => {
  const previous = {
    schema_version: 1,
    updated_at: '2026-08-01T00:00:00.000Z',
    entries: {
      'MLU123456:0': {
        product_id: 'MLU123456', position: 0,
        current: {
          object_key: `covers/v1/objects/${'a'.repeat(64)}.jpg`,
          sha256: 'a'.repeat(64), mime: 'image/jpeg',
          source_url: 'https://http2.mlstatic.com/D_OLD-O.jpg',
        },
        last_validated_at: '2026-08-01T00:00:00.000Z',
      },
    },
  };
  const bucket = new MockR2(previous);
  bucket.conflictManifestOnce = manifest => ({
    ...manifest,
    updated_at: '2026-08-16T12:00:01.000Z',
    entries: {
      ...manifest.entries,
      'MLU123456:0': {
        ...manifest.entries['MLU123456:0'],
        current: {
          object_key: `covers/v1/objects/${'c'.repeat(64)}.jpg`,
          sha256: 'c'.repeat(64), mime: 'image/jpeg',
          source_url: item().pictures[0],
        },
        last_validated_at: '2026-08-16T12:00:01.000Z',
      },
    },
  });

  const result = await syncCoverMirror(
    { COVER_R2: bucket },
    { items: [item()] },
    {
      now: () => new Date('2026-08-16T12:00:00.000Z'),
      fetchFn: async () => new Response('bloqueado', { status: 403 }),
      limit: 1,
    },
  );

  assert.equal(result.manifest_retries, 1);
  const entry = bucket.manifest().entries['MLU123456:0'];
  assert.equal(entry.current.object_key, `covers/v1/objects/${'c'.repeat(64)}.jpg`);
  assert.match(entry.last_error.message, /HTTP 403/);
});

test('sistema general descubre fuentes nativas en todas las posiciones sin MLU predefinidos ni IA', async () => {
  const book=item('MLU987654321', {pictures:[
    'https://http2.mlstatic.com/D_123456-MLU123456789_012026-O.jpg',
    'https://http2.mlstatic.com/D_654321-MLU987654321_022026-O.jpg',
  ]});
  const bucket=new MockR2();
  const result=await syncCoverMirror({COVER_R2:bucket,IMAGES:{input(){throw new Error('No IA automática');}}},{items:[book]}, {
    fetchFn:async url=>new Response(url.endsWith('-F.jpg')?pngBytes(800,1200,7):pngBytes(300,450),{headers:{'content-type':'image/png'}}),
  });
  assert.equal(result.scope_images,2); assert.equal(result.pending,0); assert.equal(result.needs_better_source,0);
  for(const position of [0,1]) {
    const entry=bucket.manifest().entries[`${book.id}:${position}`];
    assert.equal(entry.current.width,800); assert.equal(entry.current.height,1200);
    assert.equal(entry.current.source_url,book.pictures[position]);
    assert.match(entry.current.native_source_url,/-F.jpg$/); assert.equal(entry.current.transform,null);
    assert.equal(entry.source_policy_version,1);
  }
});

test('el master bueno se conserva cuando el origen pierde resolución', async () => {
  const bucket=new MockR2(); const catalog={items:[item()]};
  await syncCoverMirror({COVER_R2:bucket},catalog,{now:()=>new Date('2026-01-01'),fetchFn:async()=>new Response(pngBytes(1200,1800),{headers:{'content-type':'image/png'}})});
  const before=bucket.manifest().entries['MLU123456:0'].current;
  const result=await syncCoverMirror({COVER_R2:bucket},catalog,{now:()=>new Date('2026-03-01'),fetchFn:async()=>new Response(pngBytes(300,450),{headers:{'content-type':'image/png'}})});
  assert.deepEqual(bucket.manifest().entries['MLU123456:0'].current,before);
  assert.equal(result.results[0].quality_status,'better-master-preserved');
  assert.equal(result.needs_better_source,0);
});

test('cola persistente de fuentes insuficientes, sin reintento caliente y recuperación automática', async () => {
  const bucket=new MockR2(); const catalog={items:[item()]}; let calls=0;
  const fetchFn=async()=>{calls++;return new Response(pngBytes(300,450),{headers:{'content-type':'image/png'}});};
  const first=await syncCoverMirror({COVER_R2:bucket},catalog,{now:()=>new Date('2026-01-01'),fetchFn});
  assert.equal(first.needs_better_source,1);
  const report=JSON.parse(await (await bucket.get('covers/v1/quality-report.json')).text());
  assert.equal(report.needs_better_source.length,1);
  await syncCoverMirror({COVER_R2:bucket},catalog,{now:()=>new Date('2026-01-01T00:05:00Z'),fetchFn});
  assert.equal(calls,1);
  const recovered=await syncCoverMirror({COVER_R2:bucket},catalog,{now:()=>new Date('2026-01-09'),fetchFn:async()=>new Response(pngBytes(800,1200),{headers:{'content-type':'image/png'}})});
  assert.equal(recovered.needs_better_source,0); assert.equal(recovered.pending,0);
});

test('una variante caída no bloquea otra fuente real válida', async () => {
  const book=item('MLU987654321',{pictures:['https://http2.mlstatic.com/D_123456-MLU123456789_012026-O.jpg']});
  const bucket=new MockR2();
  const result=await syncCoverMirror({COVER_R2:bucket},{items:[book]},{fetchFn:async url=>url.endsWith('-O.jpg')?new Response('down',{status:503}):new Response(pngBytes(800,1200),{headers:{'content-type':'image/png'}})});
  assert.equal(result.failed,0);
  assert.ok(bucket.manifest().entries[book.id+':0'].source_probes.some(x=>x.error));
});

test('una imagen inaccesible no bloquea el descubrimiento y permanece en la cola entre bloques', async () => {
  const bucket = new MockR2();
  const broken = item('MLU111111', { status: 'paused' });
  const first = await syncCoverMirror({COVER_R2: bucket}, {items: [broken]}, {
    includePaused: true, now: () => new Date('2026-01-01'),
    fetchFn: async () => new Response('unavailable', {status: 503}),
  });
  assert.equal(first.failed, 1);
  assert.equal(first.source_discovery_pending, 0);
  const next = await syncCoverMirror({COVER_R2: bucket}, {items: [item('MLU222222')]}, {
    now: () => new Date('2026-01-01T00:05:00Z'),
    fetchFn: async () => new Response(pngBytes(), {headers: {'content-type': 'image/png'}}),
  });
  assert.equal(next.imported, 1);
  const report = JSON.parse(await (await bucket.get('covers/v1/quality-report.json')).text());
  assert.ok(report.unavailable.some(row => row.product_id === broken.id));
  const cooling = await syncCoverMirror({COVER_R2: bucket}, {items: [broken]}, {
    includePaused: true, now: () => new Date('2026-01-01T00:10:00Z'),
    fetchFn: async () => { throw new Error('must not retry before cooldown'); },
  });
  assert.equal(cooling.attempted, 0);
});
