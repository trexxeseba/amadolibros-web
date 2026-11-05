import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

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
const catalog = await (await get('/catalogo')).text();
assert.doesNotMatch(home, /\/cdn-cgi\/image\//);
const cover = await (await get('/preview-cover/status')).json();
assert.ok(cover.sample_product_id);
const page = await (await get(`/libro/${cover.sample_product_id}`)).text();
assert.doesNotMatch(page, /\/cdn-cgi\/image\//);
const zoomTag = page.match(/<img[^>]*id="glbImg"[^>]*>/)?.[0];
assert.ok(zoomTag); assert.doesNotMatch(zoomTag, /\s(?:src|srcset)=/);
// Preview uses its separate bucket; it must not claim production coverage.
// In the dormant rollout, gallery/home URLs remain on their previous paths.
for (const html of [home,catalog,page]) assert.doesNotMatch(html,/\?variant=v1-/);
// One intentional absent variant exercises Preview isolation, not inventory.
// Do not follow a redirect or request any transformation/original image.
const absent = new URL(`/preview-cover/MLU1/0/${'0'.repeat(64)}.jpg?variant=v1-240-q85`,base);
const missing = await fetch(absent,{redirect:'manual',signal:AbortSignal.timeout(30_000)});
assert.equal(missing.status,503); assert.equal(missing.headers.get('location'),null);
assert.equal(missing.headers.get('x-cover-variant'),'unavailable');
assert.equal(missing.headers.get('cache-control'),'no-store');
await missing.body?.cancel();
await mkdir('artifacts/image-variants', {recursive:true});
const dormantReport={base:base.origin,mode:'dormant-delivery',pages:3,hidden_zoom_has_src:false,
  variant_urls_emitted:0,image_requests:1,negative_variant_probes:1,original_image_requests:0,
  preview_missing_variant_isolated:true,production_coverage_verified:false,
  live_variant_cache_hit_verified:false};
await writeFile('artifacts/image-variants/delivery.json',JSON.stringify(dormantReport,null,2));
console.log(JSON.stringify(dormantReport));
// Existing-object and edge-cache behavior is covered locally. A real R2/cache
// HIT still needs a known existing Preview variant or the approved production
// endpoint smoke after deployment. This check never generates that fixture.
