import test from 'node:test';
import assert from 'node:assert/strict';
import { plannedVariants, missingWork, signS3, COVER_RECIPES, GALLERY_RECIPES } from '../r2-variants-backfill.mjs';
import { variantObjectKey, imageVariant } from '../../../shared/image-variants.js';

const H1 = 'a'.repeat(64), H2 = 'b'.repeat(64), H3 = 'c'.repeat(64);
const entry = (hash, ext = 'jpg') => ({ current: { object_key: `covers/v1/objects/${hash}.${ext}`, sha256: hash, mime: 'image/jpeg' } });

test('todas las recetas planificadas existen en el contrato de lectura', () => {
  for (const id of [...COVER_RECIPES, ...GALLERY_RECIPES]) assert.ok(imageVariant(id), id);
});

test('la tapa principal lleva todas las recetas y la galería sólo las de la ficha', () => {
  const masters = plannedVariants({ entries: {
    'MLU1:0': entry(H1), 'MLU1:1': entry(H2), 'MLU2:0': entry(H1),
    'MLU3:0': { current: { object_key: `covers/v1/objects/${H3}.jpg`, sha256: H1 } }, // hash no coincide
    'MLU4:0': { current: { object_key: 'otra/ruta.jpg', sha256: H3 } },
  } });
  assert.equal(masters.length, 2);
  const cover = masters.find(m => m.hash === H1), gallery = masters.find(m => m.hash === H2);
  assert.deepEqual([...cover.recipes].sort(), [...COVER_RECIPES].sort());
  assert.deepEqual([...gallery.recipes].sort(), [...GALLERY_RECIPES].sort());
});

test('sólo publicaciones activas, con las tapas principales primero', () => {
  const masters = plannedVariants({ entries: {
    'MLU1:1': entry(H2), 'MLU1:0': entry(H1), 'MLU9:0': entry(H3),
  } }, new Set(['MLU1']));
  assert.deepEqual(masters.map(m => m.hash), [H1, H2]);
});

test('sólo quedan como trabajo las variantes ausentes', () => {
  const masters = plannedVariants({ entries: { 'MLU1:0': entry(H1), 'MLU2:0': entry(H2) } });
  const existing = new Set(COVER_RECIPES.map(id => variantObjectKey(H1, id)));
  existing.add(variantObjectKey(H2, 'v1-240-q85'));
  const work = missingWork(masters, existing);
  assert.equal(work.length, 1);
  assert.equal(work[0].hash, H2);
  assert.equal(work[0].missing.length, COVER_RECIPES.length - 1);
  assert.ok(!work[0].missing.includes('v1-240-q85'));
});

test('la firma S3 apunta al bucket de producción e incluye la consulta ordenada', () => {
  const { url, options } = signS3({ account: '0'.repeat(32), accessKey: '1'.repeat(32), secretKey: 'x',
    method: 'GET', query: { prefix: 'covers/variants/v1/', 'list-type': '2' }, now: new Date('2026-11-27T00:00:00Z') });
  assert.equal(url, `https://${'0'.repeat(32)}.r2.cloudflarestorage.com/amadolibros-images-production?list-type=2&prefix=covers%2Fvariants%2Fv1%2F`);
  assert.match(options.headers.authorization, /^AWS4-HMAC-SHA256 Credential=1{32}\/20261127\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[a-f0-9]{64}$/);
});
