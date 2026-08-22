import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { R2_DEV_BASE } from '../_shared/r2-access.js';
import {
  BOOK_INTELLIGENCE_PREVIEW_POINTER_KEY,
  getPreviewBookIntelligenceEntry,
  validatePreviewBookIntelligenceManifest,
} from '../_shared/book-intelligence-enrichment-preview.js';

function sha256(buffer) { return createHash('sha256').update(buffer).digest('hex'); }
function sampleEntry(decision = 'auto_publish', id = 'MLU616917519') {
  return {
    schema_version: 1, product_id: id, isbn: '9789878675701', availability: 'by_request',
    tier: decision === 'auto_publish' ? 'green' : decision === 'review' ? 'yellow' : 'red', decision,
    work: { can_generate: decision !== 'hold', auto_publish: decision === 'auto_publish', review_required: decision === 'review', topic_seeds: decision === 'hold' ? [] : ['selección argentina','básquetbol','China 2019','liderazgo','recambio generacional'], audience_seed: null },
    edition: { auto_publishable_fields: {}, blocked_fields: [] }, provenance: [],
    review: { required: decision === 'review', identity_conflicts: [], edition_fact_conflicts: [] },
  };
}
function sampleManifest(entries = [sampleEntry()]) {
  const counts = { total: entries.length, auto_publish: 0, review: 0, hold: 0 };
  for (const entry of entries) counts[entry.decision] += 1;
  return { schema_version: 1, generated_at: '2026-08-22T22:00:00.000Z', catalog_version: 'test', counts, entries };
}
function responseFrom(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer));
  return { ok: true, async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); } };
}
function fetchForManifest(manifest, mutatePointer = value => value, mutateObject = value => value) {
  const objectBytes = Buffer.from(mutateObject(JSON.stringify(manifest)));
  const sha = sha256(objectBytes);
  const objectKey = `book-intelligence/preview/v1/objects/${sha}.json`;
  const pointer = mutatePointer({ schema_version: 1, environment: 'preview', current: { object_key: objectKey, sha256: sha, bytes: objectBytes.length, counts: manifest.counts } });
  const urls = [];
  return {
    urls,
    fetchImpl: async url => {
      urls.push(String(url));
      if (String(url) === `${R2_DEV_BASE}/${BOOK_INTELLIGENCE_PREVIEW_POINTER_KEY}`) return responseFrom(JSON.stringify(pointer));
      if (String(url) === `${R2_DEV_BASE}/${objectKey}`) return responseFrom(objectBytes);
      return { ok: false, status: 404, async arrayBuffer() { return new ArrayBuffer(0); } };
    },
  };
}
const previewEnv = { APP_ENV: 'preview' };

test('Producción corta antes de hacer fetch HTTP', async () => {
  let calls = 0;
  const result = await getPreviewBookIntelligenceEntry({ APP_ENV: 'production' }, 'MLU616917519', { fetchImpl: async () => { calls++; throw new Error('no'); } });
  assert.equal(result, null); assert.equal(calls, 0);
});
test('Preview sin fetch disponible falla abierto', async () => {
  assert.equal(await getPreviewBookIntelligenceEntry(previewEnv, 'MLU616917519', { fetchImpl: null }), null);
});
test('lector usa exclusivamente R2_DEV_BASE y entrega sólo auto_publish', async () => {
  const entries = [sampleEntry('auto_publish','MLU616917519'), sampleEntry('review','MLU1416777650'), sampleEntry('hold','MLU658066458')];
  const fixture = fetchForManifest(sampleManifest(entries));
  const green = await getPreviewBookIntelligenceEntry(previewEnv, 'MLU616917519', fixture);
  assert.equal(green?.decision, 'auto_publish');
  assert.equal(fixture.urls[0], `${R2_DEV_BASE}/${BOOK_INTELLIGENCE_PREVIEW_POINTER_KEY}`);
  assert.match(fixture.urls[1], new RegExp(`^${R2_DEV_BASE.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}/book-intelligence/preview/v1/objects/[a-f0-9]{64}\\.json$`));
});
test('review y hold nunca se exponen', async () => {
  const manifest = sampleManifest([sampleEntry('auto_publish','MLU616917519'), sampleEntry('review','MLU1416777650'), sampleEntry('hold','MLU658066458')]);
  assert.equal(await getPreviewBookIntelligenceEntry(previewEnv,'MLU1416777650',fetchForManifest(manifest)), null);
  assert.equal(await getPreviewBookIntelligenceEntry(previewEnv,'MLU658066458',fetchForManifest(manifest)), null);
});
test('puntero fuera de namespace Preview falla abierto', async () => {
  const fixture = fetchForManifest(sampleManifest(), pointer => ({ ...pointer, current: { ...pointer.current, object_key: `book-intelligence/production/v1/objects/${pointer.current.sha256}.json` } }));
  assert.equal(await getPreviewBookIntelligenceEntry(previewEnv,'MLU616917519',fixture), null);
});
test('SHA declarado distinto del object key falla abierto', async () => {
  const fixture = fetchForManifest(sampleManifest(), pointer => ({ ...pointer, current: { ...pointer.current, sha256: '0'.repeat(64) } }));
  assert.equal(await getPreviewBookIntelligenceEntry(previewEnv,'MLU616917519',fixture), null);
});
test('respuesta HTTP fallida o bytes inválidos fallan abierto', async () => {
  assert.equal(await getPreviewBookIntelligenceEntry(previewEnv,'MLU616917519',{ fetchImpl: async () => ({ ok:false,status:503 }) }), null);
  const invalid = fetchForManifest(sampleManifest(), value => value, () => '{not-json');
  assert.equal(await getPreviewBookIntelligenceEntry(previewEnv,'MLU616917519',invalid), null);
});
test('manifest con hold contaminado por temas es rechazado', () => {
  const bad = sampleEntry('hold','MLU658066458'); bad.work.topic_seeds=['no'];
  assert.equal(validatePreviewBookIntelligenceManifest(sampleManifest([bad])), false);
});
test('manifest con copy externo prohibido es rechazado', () => {
  const entry=sampleEntry(); entry.provenance=[{source:'publisher',description:'copy'}];
  assert.equal(validatePreviewBookIntelligenceManifest(sampleManifest([entry])), false);
});
test('IDs duplicados o conteos inconsistentes invalidan manifest', () => {
  const e=sampleEntry(); assert.equal(validatePreviewBookIntelligenceManifest(sampleManifest([e,{...e}])), false);
  const wrong=sampleManifest(); wrong.counts.total=99; assert.equal(validatePreviewBookIntelligenceManifest(wrong), false);
});
