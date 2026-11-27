import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Preview only. No orders, payments or real waitlist entries are created.
const base = new URL(process.env.COMMERCE_BASE_URL || '');
assert.match(base.hostname, /^[a-z0-9-]+\.amadolibros-web\.pages\.dev$/);
const output = process.env.COMMERCE_UI_OUTPUT_DIR || 'artifacts/purchase-ui';
await fs.mkdir(output, { recursive: true });
const { chromium } = await import(pathToFileURL(process.env.AMADO_PLAYWRIGHT_MODULE).href);
const browser = await chromium.launch({ executablePath: process.env.AMADO_CHROMIUM_PATH });
const report = { origin: base.origin, revision: process.env.GITHUB_SHA || null, profiles: [], galleries: [], recompressed: [], errors: [] };
const artifacts = file => path.join(output, file);

async function findPausedPage() {
  const response = await fetch(new URL('/sitemap-books-paused.xml', base), { signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200, 'paused sitemap');
  const urls = [...(await response.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => new URL(new URL(m[1]).pathname, base).href);
  for (const url of urls.slice(0, 40)) {
    const page = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (page.ok && (await page.text()).includes('id="aviso-stock"')) return url;
  }
  throw Error('No visible waitlist form found in the paused sitemap sample');
}

async function contextFor(width) {
  const context = await browser.newContext({ viewport: { width, height: width < 700 ? 812 : 900 }, isMobile: width < 700, hasTouch: width < 700 });
  const intercepted = [];
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (/google-analytics|googletagmanager|facebook|clarity\.ms|cloudflareinsights|analytics\./i.test(url.hostname)) return route.abort();
    if (url.pathname === '/api/stock-waitlist' && request.method() === 'POST') {
      intercepted.push(JSON.parse(request.postData()));
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ registered: true }) });
    }
    if (/\/api\//.test(url.pathname) && request.method() !== 'GET' && url.pathname !== '/api/cart/validate') {
      report.errors.push('Unexpected write blocked: ' + url.pathname);
      return route.abort();
    }
    return route.continue();
  });
  return { context, intercepted };
}

async function dismissCookies(page) {
  const reject = page.getByRole('button', { name: 'Rechazar', exact: true });
  if (await reject.count()) await reject.click({ timeout: 5000 });
}

async function measure(page, name, width) {
  const data = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth,
    unnamedImages: [...document.querySelectorAll('a img')].filter(i => !i.getAttribute('alt') && !i.closest('[aria-hidden="true"]')).length }));
  assert.ok(data.content <= data.viewport + 1, name + ' has horizontal overflow');
  await page.screenshot({ path: artifacts(width + '-' + name + '.png'), fullPage: true });
  return data;
}

try {
  const paused = await findPausedPage();
  report.paused = paused;
  for (const width of [375, 1440]) {
    const { context, intercepted } = await contextFor(width);
    try {
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(new URL('/regalos/', base).href, { waitUntil: 'networkidle' });
      await dismissCookies(page);
      const entry = { width, regalos: await measure(page, 'regalos', width), errors };
      report.profiles.push(entry);
      const button = page.locator('[data-action="add-to-cart"]').first();
      const productId = await button.getAttribute('data-id');
      await button.click();
      await page.waitForFunction(id => JSON.parse(localStorage.getItem('amado-cart') || '{"items":[]}').items.some(i => i.id === id), productId);
      const items = await page.evaluate(() => JSON.parse(localStorage.getItem('amado-cart')).items);
      assert.equal(items.find(i => i.id === productId).quantity, 1);
      await Promise.all([page.waitForURL(url => /^\/carrito\/?$/.test(url.pathname)), button.click()]);
      await page.waitForLoadState('networkidle');
      entry.cart = await measure(page, 'carrito', width);
      assert.equal(await page.evaluate(id => JSON.parse(localStorage.getItem('amado-cart')).items.find(i => i.id === id).quantity, productId), 1);
      await page.goto(new URL('/libro/' + productId + '/x', base).href, { waitUntil: 'networkidle' });
      entry.product = await measure(page, 'ficha', width);

      await page.goto(paused, { waitUntil: 'networkidle' });
      const contact = page.locator('#waitlist-email'), submit = page.locator('#aviso-stock button[type="submit"]');
      await contact.fill('09abc841325'); await submit.click();
      assert.equal(await contact.getAttribute('aria-invalid'), 'true');
      assert.equal(intercepted.length, 0, 'invalid contact must not be sent');
      await contact.fill('099 123 456');
      assert.equal(await contact.getAttribute('aria-invalid'), null);
      // The request is fulfilled above: this checks client behavior without registering a contact.
      await page.evaluate(() => {
        const form = document.querySelector('#aviso-stock');
        let token = form.querySelector('[name="cf-turnstile-response"]');
        if (!token) { token = document.createElement('input'); token.type = 'hidden'; token.name = 'cf-turnstile-response'; form.appendChild(token); }
        token.value = 'browser-test-intercepted';
      });
      await submit.click();
      await page.waitForFunction(() => document.querySelector('#waitlist-status').classList.contains('is-ok'));
      assert.equal(intercepted.length, 1);
      assert.equal(intercepted[0].email, '099 123 456');
      entry.waitlist = await measure(page, 'aviso', width);
      assert.deepEqual(errors, [], 'page script errors');
    } finally { await context.close(); }
  }

  const { context } = await contextFor(375);
  try {
    const page = await context.newPage();
    const errors = [], cors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (/CORS|tainted|Access-Control/i.test(m.text())) cors.push(m.text()); });
    for (const id of ['MLU1494548512', 'MLU1447482978', 'MLU626310388', 'MLU1256360946', 'MLU1465393798']) {
      const response = await page.goto(new URL('/libro/' + id + '/x', base).href, { waitUntil: 'networkidle' });
      assert.equal(response.status(), 200, id);
      await page.waitForFunction(() => document.querySelector('#gMainBtn')?.getAttribute('data-gallery-filter') === 'complete', null, { timeout: 45000 });
      const removed = await page.locator('.thumb-btn').evaluateAll(nodes => nodes.filter(n => n.hidden).map(n => n.querySelector('img')?.src));
      report.galleries.push({ id, removed });
      await page.screenshot({ path: artifacts('gallery-' + id + '.png'), fullPage: true });
    }
    assert.deepEqual(errors, []); assert.deepEqual(cors, []);
    assert.ok(report.galleries.some(g => g.removed.length > 0), 'known posters in the reviewed sample must be filtered');

    // Controlled re-encodings exercise the deployed filter without changing server data.
    const fixture = JSON.parse(await fs.readFile(new URL('../../functions/__tests__/fixtures/gallery-visual.json', import.meta.url), 'utf8'));
    const poster = fixture.decoded.find(row => fixture.cases.find(c => c.id === row.id).bad);
    const firstThumbnail = await page.locator('.thumb-btn img').first().getAttribute('src');
    for (const [width, type, quality] of [[96, 'image/jpeg', 0.45], [240, 'image/jpeg', 0.85], [480, 'image/webp', 0.75]]) {
      const encoded = await page.evaluate(({ pixels, aspect, width, type, quality }) => {
        const source = document.createElement('canvas'); source.width = source.height = 32;
        source.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels), 32, 32), 0, 0);
        const image = document.createElement('canvas'); image.width = width; image.height = Math.round(width / aspect);
        image.getContext('2d').drawImage(source, 0, 0, image.width, image.height);
        return image.toDataURL(type, quality).split(',')[1];
      }, { pixels: poster.pixels, aspect: poster.aspect, width, type, quality });
      const imageRoute = route => route.fulfill({ status: 200, contentType: type, body: Buffer.from(encoded, 'base64'), headers: { 'Access-Control-Allow-Origin': '*' } });
      await page.route(firstThumbnail, imageRoute);
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForFunction(() => document.querySelector('#gMainBtn')?.getAttribute('data-gallery-filter') === 'complete', null, { timeout: 45000 });
      assert.equal(await page.locator('.thumb-btn').first().evaluate(n => n.hidden), true, width + ' ' + type);
      report.recompressed.push({ width, type, quality, hidden: true, sourceHash: poster.id });
      await page.unroute(firstThumbnail, imageRoute);
    }
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
  assert.deepEqual(report.errors, []);
  report.ok = true;
} catch (error) {
  report.ok = false; report.errors.push(error.stack || error.message); process.exitCode = 1;
} finally {
  await browser.close();
  await fs.writeFile(artifacts('report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, profiles: report.profiles.length, galleries: report.galleries.length, errors: report.errors }));
}
