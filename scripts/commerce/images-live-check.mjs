import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectProductImages } from '../../shared/product-image-audit.js';

const base = new URL(process.env.COMMERCE_BASE_URL || 'https://www.amadolibros.com');
const production = base.origin === 'https://www.amadolibros.com';
assert.ok(base.protocol === 'https:' && (production || /(?:^|\.)amadolibros-web\.pages\.dev$/.test(base.hostname)));
const output = process.env.IMAGE_CHECK_OUTPUT || 'artifacts/commerce/images-live';
const productPath = '/libro/MLU651526046/big-english-1-british-pupil-s-book-pearson';
const ids = ['MLU651526046', 'MLU634431651', 'MLU709390092', 'MLU690771648', 'MLU679987262'];
const report = { checkedAt: new Date().toISOString(), base: base.origin, head: process.env.GITHUB_SHA,
  production, products: [], covers: [], browsers: [], failures: [] };
await mkdir(output, { recursive: true });
const save = () => writeFile(`${output}/report.json`, JSON.stringify(report, null, 2) + '\n');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const get = path => fetch(new URL(path, base), { redirect: 'manual', signal: AbortSignal.timeout(30000) });
let browser;
try {
  // Pages and the catalog Worker deploy independently. Wait only for the
  // declared transition; a timeout remains a failure, never a healthy result.
  if (production) {
    let ready = false;
    const until = Date.now() + 600000;
    do {
      const r = await get(`/book-cover/${ids[0]}/cover.jpg?image-readiness=${Date.now()}`).catch(() => null);
      ready = r?.status === 200 && r.headers.get('x-cover-index') === 'public-index';
      await r?.body?.cancel();
      if (!ready) await pause(10000);
    } while (!ready && Date.now() < until);
    assert.ok(ready, 'PUBLIC_COVER_INDEX_NOT_READY');
  }
  const response = await get(productPath);
  assert.equal(response.status, 200, 'PRODUCT_PAGE_UNAVAILABLE');
  const html = await response.text();
  assert.equal(/name="robots"[^>]+noindex/.test(html), !production, 'INDEXABILITY_MISMATCH');
  const inspected = inspectProductImages(html);
  report.products.push({ path: productPath, http: response.status, ...inspected });
  assert.deepEqual(inspected.issues, [], 'PRODUCT_IMAGE_INVALID_OR_MISSING');
  assert.ok(inspected.products.some(p => p.sku === ids[0] && p.images.length > 0), 'PRODUCT_ID_MISMATCH');
  for (const id of ids) {
    const started = performance.now();
    const r = await get(`/book-cover/${id}/cover.jpg?image-check=${Date.now()}`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    const row = { id, http: r.status, mime: r.headers.get('content-type'), bytes: bytes.length,
      index: r.headers.get('x-cover-index'), source: r.headers.get('x-cover-source'),
      elapsedMs: Math.round(performance.now() - started) };
    report.covers.push(row);
    assert.equal(row.http, 200, `COVER_HTTP_${id}`);
    assert.match(row.mime || '', /^image\/(jpeg|png|webp)/);
    assert.ok(row.bytes > 100, `COVER_EMPTY_${id}`);
    if (production) assert.equal(row.index, 'public-index', `COVER_LEGACY_FALLBACK_${id}`);
  }
  const { chromium } = await import(pathToFileURL(resolve(process.argv[2])).href);
  browser = await chromium.launch({ headless: true });
  for (const viewport of [{ width: 1365, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
    // This is a read-only synthetic visit; it must not create orders or GA events.
    await context.route('**/*', route => {
      const r = route.request(); const u = new URL(r.url());
      if (!['GET', 'HEAD'].includes(r.method()) || /google-analytics|googletagmanager|doubleclick|facebook/.test(u.hostname)) return route.abort();
      return route.continue();
    });
    const page = await context.newPage();
    const run = { viewport, pages: [], failedImages: [], javascriptErrors: [] };
    report.browsers.push(run);
    page.on('pageerror', e => run.javascriptErrors.push(e.message.slice(0, 200)));
    page.on('response', r => {
      if (r.request().resourceType() === 'image' && r.status() >= 400) run.failedImages.push({ url: r.url(), http: r.status() });
    });
    await page.addInitScript(() => {
      window.__coverQaErrors = [];
      addEventListener('error', e => {
        if (e.target instanceof HTMLImageElement) window.__coverQaErrors.push(e.target.currentSrc || e.target.src);
      }, true);
    });
    for (const path of ['/', '/libros/psicologia', productPath]) {
      const started = Date.now();
      const r = await page.goto(new URL(path, base).href, { waitUntil: 'domcontentloaded', timeout: 30000 });
      assert.equal(r.status(), 200, `BROWSER_PAGE_UNAVAILABLE_${path}`);
      assert.equal(new URL(page.url()).origin, base.origin, 'BROWSER_REDIRECT_OUTSIDE_SITE');
      const row = { path, navigationMs: Date.now() - started, images: [] };
      run.pages.push(row);
      const selector = path === '/libros/psicologia' ? '.book-card img' : 'main img';
      await page.waitForSelector(selector, { timeout: 10000 });
      const images = page.locator(selector);
      const count = await images.count();
      assert.ok(count > 0, 'CONTENT_IMAGES_ABSENT');
      if (path === '/libros/psicologia') assert.ok(count >= 24, 'CATALOG_SAMPLE_TOO_SMALL');
      const limit = Math.min(count, path === '/libros/psicologia' ? 48 : 8);
      for (let i = 0; i < limit; i++) {
        const image = images.nth(i);
        if (!await image.isVisible()) continue;
        await image.scrollIntoViewIfNeeded();
        const result = await image.evaluate(async img => {
          const start = performance.now();
          const original = img.currentSrc || img.src;
          try {
            // Responsive/lazy scripts may change currentSrc immediately after
            // entering the viewport. Wait for a completed image before decode.
            while (!img.complete || img.naturalWidth === 0) {
              if (performance.now() - start >= 8000) throw Error('timeout');
              await new Promise(resolve => setTimeout(resolve, 50));
            }
            await img.decode();
            const src = img.currentSrc || img.src;
            return { src, original, width: img.naturalWidth, height: img.naturalHeight,
              visibleWaitMs: Math.round(performance.now() - start),
              ok: img.complete && img.naturalWidth > 0 && !/logo-amado\./.test(src) };
          } catch { return { src: img.currentSrc || img.src, original, ok: false,
            visibleWaitMs: Math.round(performance.now() - start) }; }
        });
        row.images.push(result);
      }
      row.domImageErrors = await page.evaluate(() => window.__coverQaErrors);
      await page.screenshot({ path: `${output}/${viewport.width}-${run.pages.length}.png` });
      assert.ok(row.images.length > 0 && row.images.every(i => i.ok), `VISIBLE_IMAGE_NOT_LOADED_${path}`);
      assert.deepEqual(row.domImageErrors, [], `IMAGE_ERROR_EVENT_${path}`);
    }
    assert.deepEqual(run.failedImages, [], 'IMAGE_HTTP_FAILURES');
    assert.deepEqual(run.javascriptErrors, [], 'JAVASCRIPT_FAILURES');
    await context.close();
  }
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failures.push(String(error.message)); process.exitCode = 1;
} finally {
  await browser?.close(); await save();
  console.log(JSON.stringify({ status: report.status, checkedAt: report.checkedAt, base: report.base,
    products: report.products.length, covers: report.covers, browsers: report.browsers.map(b => ({ viewport: b.viewport,
      pages: b.pages.map(p => ({ path: p.path, images: p.images.length, loaded: p.images.filter(i => i.ok).length,
        maxVisibleWaitMs: Math.max(0, ...p.images.map(i => i.visibleWaitMs)) })) })), failures: report.failures }));
}
