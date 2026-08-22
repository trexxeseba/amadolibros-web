import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  BOOK_INTELLIGENCE_PREVIEW_POINTER_KEY,
  getPreviewBookIntelligenceEntry,
  validatePreviewBookIntelligenceManifest,
} from '../_shared/book-intelligence-enrichment-preview.js';

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function sampleEntry(decision = 'auto_publish', id = 'MLU616917519') {
  return {
    schema_version: 1,
    product_id: id,
    isbn: '9789878675701',
    availability: 'by_request',
    tier: decision === 'auto_publish' ? 'green' : decision === 'review' ? 'yellow' : 'red',
    decision,
    work: {
      can_generate: decision !== 'hold',
      auto_publish: decision === 'auto_publish',
      review_required: decision === 'review',
      topic_seeds: decision === 'hold' ? [] : ['selección argentina', 'básquetbol', 'China 2019', 'liderazgo', 'recambio generacional'],
      audience_seed: null,
    },
    edition: {
      auto_publishable_fields: decision === 'hold' ? {} : {},
      blocked_fields: [],
    },
    provenance: [],
    review: { required: decision === 'review', identity_conflicts: [], edition_fact_conflicts: [] },
  };
}

function sampleManifest(entries = [sampleEntry()]) {
  const counts = { total: entries.length, auto_publish: 0, review: 0, hold: 0 };
  for (const entry of entries) counts[entry.decision] += 1;
  return {
    schema_version: 1,
    generated_at: '2026-08-22T22:00:00.000Z',
    catalog_version: 'test',
    counts,
    entries,
  };
}

function objectFromText(text) {
  const bytes = Buffer.from(text);
  return {
    async text() { return text; },
    async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
  };
}

function envForManifest(manifest, mutatePointer = value => value, mutateObjectText = value => value) {
  const objectText = mutateObjectText(JSON.stringify(manifest));
  const objectBytes = Buffer.from(objectText);
  const sha = sha256(objectBytes);
  const objectKey = `book-intelligence/preview/v1/objects/${sha}.json`;
  const pointer = mutatePointer({
    schema_version: 1,
    environment: 'preview',
    current: {
      object_key: objectKey,
      sha256: sha,
      bytes: objectBytes.length,
      counts: manifest.counts,
    },
  });
  const gets = [];
  return {
    gets,
    env: {
      APP_ENV: 'preview',
      CATALOG_BUCKET: {
        async get(key) {
          gets.push(key);
          if (key === BOOK_INTELLIGENCE_PREVIEW_POINTER_KEY) return objectFromText(JSON.stringify(pointer));
          if (key === objectKey) return objectFromText(objectText);
          return null;
        },
      },
    },
  };
}

test('Producción corta antes de tocar R2 aunque exista un binding inyectado', async () => {
  let gets = 0;
  const result = await getPreviewBookIntelligenceEntry({
    APP_ENV: 'production',
    CATALOG_BUCKET: { async get() { gets += 1; return null; } },
  }, 'MLU616917519');
  assert.equal(result, null);
  assert.equal(gets, 0);
});

test('Preview sin binding falla abierto y no rompe la ficha', async () => {
  assert.equal(await getPreviewBookIntelligenceEntry({ APP_ENV: 'preview' }, 'MLU616917519'), null);
});

test('lector válido consulta puntero y luego objeto, y entrega sólo auto_publish', async () => {
  const entries = [
    sampleEntry('auto_publish', 'MLU616917519'),
    sampleEntry('review', 'MLU1416777650'),
    sampleEntry('hold', 'MLU658066458'),
  ];
  const { env, gets } = envForManifest(sampleManifest(entries));
  const green = await getPreviewBookIntelligenceEntry(env, 'MLU616917519');
  assert.equal(green?.decision, 'auto_publish');
  assert.equal(green?.product_id, 'MLU616917519');
  assert.equal(gets[0], BOOK_INTELLIGENCE_PREVIEW_POINTER_KEY);
  assert.match(gets[1], /^book-intelligence\/preview\/v1\/objects\/[a-f0-9]{64}\.json$/);
});

test('review y hold nunca se exponen por el lector público del piloto', async () => {
  const entries = [
    sampleEntry('auto_publish', 'MLU616917519'),
    sampleEntry('review', 'MLU1416777650'),
    sampleEntry('hold', 'MLU658066458'),
  ];
  assert.equal(await getPreviewBookIntelligenceEntry(envForManifest(sampleManifest(entries)).env, 'MLU1416777650'), null);
  assert.equal(await getPreviewBookIntelligenceEntry(envForManifest(sampleManifest(entries)).env, 'MLU658066458'), null);
});

test('puntero fuera de namespace Preview falla abierto', async () => {
  const manifest = sampleManifest();
  const { env } = envForManifest(manifest, pointer => ({
    ...pointer,
    current: {
      ...pointer.current,
      object_key: `book-intelligence/production/v1/objects/${pointer.current.sha256}.json`,
    },
  }));
  assert.equal(await getPreviewBookIntelligenceEntry(env, 'MLU616917519'), null);
});

test('SHA declarado que no coincide con object key falla abierto', async () => {
  const manifest = sampleManifest();
  const { env } = envForManifest(manifest, pointer => ({
    ...pointer,
    current: { ...pointer.current, sha256: '0'.repeat(64) },
  }));
  assert.equal(await getPreviewBookIntelligenceEntry(env, 'MLU616917519'), null);
});

test('bytes corrompidos o JSON inválido fallan abierto', async () => {
  const manifest = sampleManifest();
  const corrupt = envForManifest(manifest, pointer => ({
    ...pointer,
    current: { ...pointer.current, sha256: '0'.repeat(64), object_key: `book-intelligence/preview/v1/objects/${'0'.repeat(64)}.json` },
  }));
  assert.equal(await getPreviewBookIntelligenceEntry(corrupt.env, 'MLU616917519'), null);

  const invalidJson = envForManifest(manifest, value => value, () => '{not-json');
  assert.equal(await getPreviewBookIntelligenceEntry(invalidJson.env, 'MLU616917519'), null);
});

test('manifest con hold contaminado por temas es rechazado completo', () => {
  const badHold = sampleEntry('hold', 'MLU658066458');
  badHold.work.topic_seeds = ['esto no debería existir'];
  assert.equal(validatePreviewBookIntelligenceManifest(sampleManifest([badHold])), false);
});

test('manifest con copy externo prohibido es rechazado', () => {
  const entry = sampleEntry();
  entry.provenance = [{ source: 'publisher', description: 'copy externo' }];
  assert.equal(validatePreviewBookIntelligenceManifest(sampleManifest([entry])), false);
});

test('IDs duplicados o conteos inconsistentes invalidan el manifest', () => {
  const duplicate = sampleEntry();
  const manifest = sampleManifest([duplicate, { ...duplicate }]);
  assert.equal(validatePreviewBookIntelligenceManifest(manifest), false);

  const wrongCounts = sampleManifest();
  wrongCounts.counts.total = 99;
  assert.equal(validatePreviewBookIntelligenceManifest(wrongCounts), false);
});
