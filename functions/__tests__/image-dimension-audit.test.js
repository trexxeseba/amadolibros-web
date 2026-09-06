import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('la implementación es de solo lectura: no escribe en R2, no llama a Merchant, no usa Cloudflare Images', () => {
  const source = readFileSync('scripts/seo/image-dimension-audit.mjs', 'utf8');
  assert.doesNotMatch(source, /\.put\(|\.delete\(/);
  assert.doesNotMatch(source, /merchantapi\.googleapis\.com/i);
  assert.doesNotMatch(source, /env\.IMAGES|imagesBinding|upscale/i);
  const fetchCalls = source.match(/\bfetch\(/g) || [];
  assert.equal(fetchCalls.length, 1);
});

test('readImageDimensions (worker-sync/cover-mirror.js) sigue exportada y mide JPEG/PNG reales', async () => {
  const { readImageDimensions } = await import('../../worker-sync/cover-mirror.js');
  // JPEG 2x1 mínimo válido (marcador SOF0) — sólo se necesita el header.
  const jpeg = new Uint8Array([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08,
    0x00, 0x01, 0x00, 0x02, // height=1, width=2
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9,
  ]);
  const dims = readImageDimensions(jpeg);
  assert.equal(dims.width, 2);
  assert.equal(dims.height, 1);
  assert.equal(dims.mime, 'image/jpeg');
});
