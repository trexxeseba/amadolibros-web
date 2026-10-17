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
await mkdir('artifacts/image-variants', {recursive:true});
const dormantReport={base:base.origin,mode:'dormant-delivery',pages:3,hidden_zoom_has_src:false,
  variant_urls_emitted:0,image_requests:0,production_coverage_verified:false};
await writeFile('artifacts/image-variants/delivery.json',JSON.stringify(dormantReport,null,2));
console.log(JSON.stringify(dormantReport));
// The authenticated second-pass job separately validates actual production
// WebP bytes and runs the real resolver. Do not infer that from Preview.
