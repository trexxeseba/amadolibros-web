import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

const base = new URL(process.env.COMMERCE_BASE_URL);
assert.ok(base.protocol === 'https:' && /(?:^|\.)amadolibros-web\.pages\.dev$/.test(base.hostname));
const get = async path => {
  let url = new URL(path, base);
  for (let redirect = 0; redirect < 4; redirect++) {
    assert.equal(url.origin, base.origin, 'Preview must not fetch production');
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    if ([301, 302, 307, 308].includes(response.status)) {
      const location = response.headers.get('location'); assert.ok(location);
      await response.body?.cancel(); url = new URL(location, url); continue;
    }
    assert.equal(response.status, 200, `HTTP ${response.status}`);
    return response;
  }
  throw new Error('too-many-redirects');
};
const home = await (await get('/')).text();
assert.doesNotMatch(home, /\/cdn-cgi\/image\//);
const cover = await (await get('/preview-cover/status')).json();
assert.ok(cover.sample_product_id);
const page = await (await get(`/libro/${cover.sample_product_id}`)).text();
assert.doesNotMatch(page, /\/cdn-cgi\/image\//);
const zoomTag = page.match(/<img[^>]*id="glbImg"[^>]*>/)?.[0];
assert.ok(zoomTag); assert.doesNotMatch(zoomTag, /\s(?:src|srcset)=/);
const sources = [...page.matchAll(/https:\/\/[^\s"<>]+\/preview-cover\/MLU\d+\/\d+\/[a-f0-9]{64}\.(?:jpg|png|webp)\?variant=v1-\d+-q\d+/g)]
  .map(m => m[0]);
assert.ok(sources.length, 'versioned gallery URLs missing');
const unique = [...new Set(sources)];
const report = { base: base.origin, product: cover.sample_product_id, checkedAt: new Date().toISOString(), images: [] };
await mkdir('artifacts/image-variants/visual', { recursive: true });
let derivedCount = 0;
for (const [index, source] of unique.entries()) {
  const response = await get(source);
  const bytes = Buffer.from(await response.arrayBuffer());
  const metadata = await sharp(bytes).metadata();
  const variant = response.headers.get('x-cover-variant');
  report.images.push({ path: new URL(source).pathname + new URL(source).search,
    mime: response.headers.get('content-type'), variant, bytes: bytes.length, width: metadata.width, height: metadata.height });
  if (variant !== 'original-fallback') {
    derivedCount++;
    assert.equal(metadata.format, 'webp');
    assert.match(response.headers.get('cache-control'), /immutable/);
    const second = Buffer.from(await (await get(source)).arrayBuffer());
    assert.equal(createHash('sha256').update(bytes).digest('hex'), createHash('sha256').update(second).digest('hex'));
    if (index < 3) await writeFile(`artifacts/image-variants/visual/variant-${index}.webp`, bytes);
  }
}
assert.ok(derivedCount > 0, 'real persisted variants must be delivered');
const originalUrl = new URL(unique[0]); originalUrl.search = '';
await writeFile('artifacts/image-variants/visual/original.bin', Buffer.from(await (await get(originalUrl.href)).arrayBuffer()));
await writeFile('artifacts/image-variants/delivery.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ product: report.product, checked: report.images.length, derivedCount }));
