// Se ejecuta exclusivamente en Checkly. Recorrido de lectura, sin compra ni eventos de Analytics.
const { test, expect } = require('@playwright/test');
const installImageSensor = function installImageSensor({ slowMs = 8000 } = {}) {
  const events = []; const tracked = new WeakMap(); const timers = new Set();
  const safePath = value => {
    try { const u = new URL(value, location.href); return /^https?:$/.test(u.protocol) ? u.pathname.slice(0, 300) : null; } catch { return null; }
  };
  const emit = (img, state, resource) => {
    const path = safePath(resource);
    if (!path || events.length >= 100) return;
    events.push({ state, resource: path, page: location.pathname.slice(0, 300), time: Date.now() });
  };
  const entry = img => {
    let value = tracked.get(img);
    if (!value) { value = { failed: new Set(), slow: new Set() }; tracked.set(img, value); }
    return value;
  };
  const onError = event => {
    const img = event.target;
    if (!(img instanceof HTMLImageElement)) return;
    const value = entry(img); const resource = img.currentSrc || img.src;
    if (!value.failed.has(resource)) { value.failed.add(resource); emit(img, 'broken', resource); }
  };
  const onLoad = event => {
    const img = event.target;
    if (!(img instanceof HTMLImageElement)) return;
    const value = entry(img); const resource = img.currentSrc || img.src;
    if (img.naturalWidth === 0) { onError(event); return; }
    if (value.failed.has(resource)) { value.failed.delete(resource); emit(img, 'recovered', resource); }
    else if (value.failed.size) emit(img, 'fallback_loaded', resource);
    if (value.slow.has(resource)) { value.slow.delete(resource); emit(img, 'loaded_after_delay', resource); }
  };
  const observer = new IntersectionObserver(entries => {
    for (const item of entries) {
      const img = item.target; const value = entry(img);
      if (!item.isIntersecting) { if (value.timer) { clearTimeout(value.timer); timers.delete(value.timer); value.timer = null; } continue; }
      if (img.complete) { if (img.currentSrc && img.naturalWidth === 0) onError({ target: img }); continue; }
      if (value.timer) continue;
      const resource = img.currentSrc || img.src;
      value.timer = setTimeout(() => {
        timers.delete(value.timer); value.timer = null;
        if (img.isConnected && !img.complete && (img.currentSrc || img.src) === resource && !value.slow.has(resource)) {
          value.slow.add(resource); emit(img, 'slow', resource);
        }
      }, slowMs);
      timers.add(value.timer);
    }
  });
  const observe = root => {
    if (root instanceof HTMLImageElement) observer.observe(root);
    root.querySelectorAll?.('img').forEach(img => observer.observe(img));
  };
  const mutation = new MutationObserver(records => records.forEach(r => {
    r.addedNodes.forEach(observe);
    if (r.type === 'attributes' && r.target instanceof HTMLImageElement) {
      const value = entry(r.target); if (value.timer) { clearTimeout(value.timer); timers.delete(value.timer); value.timer = null; }
      observer.unobserve(r.target); observer.observe(r.target);
    }
  }));
  document.addEventListener('error', onError, true);
  document.addEventListener('load', onLoad, true);
  mutation.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset', 'sizes'] });
  observe(document);
  window.__amadoImageMonitor = { events, stop() {
    mutation.disconnect(); observer.disconnect(); timers.forEach(clearTimeout);
    document.removeEventListener('error', onError, true); document.removeEventListener('load', onLoad, true);
  } };
};

test('Amado: home, catálogo, portadas y una ficha', async ({ page }) => {
  test.setTimeout(55000);
  await page.setViewportSize({ width: 1365, height: 900 });
  await page.route('**/*', route => {
    const r = route.request(); const u = new URL(r.url());
    if (!['GET', 'HEAD'].includes(r.method()) || /google-analytics|googletagmanager|doubleclick|facebook/.test(u.hostname)) return route.abort();
    return route.continue();
  });
  await page.addInitScript(installImageSensor);
  const errors = [];
  page.on('pageerror', () => errors.push('JAVASCRIPT_ERROR'));
  const inspectImages = async () => {
    expect(await page.evaluate(() => [...document.images].filter(i => !/logo/i.test(i.currentSrc || i.src)).length), 'PAGINA_SIN_FOTOS_DE_CONTENIDO').toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => [...document.images].filter(i => {
      const r = i.getBoundingClientRect(); return r.width > 20 && r.height > 20 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
    }).filter(i => !i.complete || i.naturalWidth === 0).length), { timeout: 8000, message: 'IMAGEN_VISIBLE_NO_CARGA' }).toBe(0);
    const events = await page.evaluate(() => window.__amadoImageMonitor?.events || []);
    const unresolved = new Map();
    for (const e of events) {
      if (['broken','slow'].includes(e.state)) unresolved.set(e.resource, e.state);
      if (e.state === 'recovered') unresolved.delete(e.resource);
    }
    expect([...unresolved.keys()], 'FOTO_FALLIDA_O_LENTA_AUN_CON_LOGO_DE_REEMPLAZO').toEqual([]);
    const backgrounds = await page.evaluate(async () => {
      const urls = new Set();
      for (const el of document.querySelectorAll('main *')) {
        const r = el.getBoundingClientRect();
        if (r.width < 20 || r.height < 20 || r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) continue;
        for (const m of getComputedStyle(el).backgroundImage.matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
          const u = new URL(m[1], location.href); if (/^https?:$/.test(u.protocol)) urls.add(u.href);
        }
      }
      return Promise.all([...urls].slice(0,10).map(src => new Promise(resolve => {
        const img = new Image(); const done = ok => { clearTimeout(timer); resolve(ok); };
        const timer = setTimeout(() => done(false), 5000);
        img.onload = () => done(img.naturalWidth > 0); img.onerror = () => done(false); img.src = src;
      })));
    });
    expect(backgrounds.every(Boolean), 'FONDO_O_BANNER_VISIBLE_NO_CARGA').toBe(true);
  };
  const open = async path => {
    const response = await page.goto(`https://www.amadolibros.com${path}`, { waitUntil: 'domcontentloaded', timeout: 12000 });
    expect(response?.status(), 'PAGINA_NO_DISPONIBLE').toBe(200);
    expect(new URL(page.url()).hostname, 'REDIRECCION_INESPERADA').toBe('www.amadolibros.com');
    await expect(page.locator('h1').first(), 'CONTENIDO_PRINCIPAL_AUSENTE').toBeVisible({ timeout: 5000 });
  };
  await open('/');
  await inspectImages();
  await page.evaluate(() => scrollTo(0, innerHeight));
  await inspectImages();
  await open('/catalogo');
  await expect(page.locator('a[href*="/libro/MLU"]').first(), 'CATALOGO_SIN_FICHAS').toBeVisible({ timeout: 8000 });
  await inspectImages();
  const href = await page.locator('a[href*="/libro/MLU"]').first().getAttribute('href');
  const path = new URL(href, 'https://www.amadolibros.com').pathname;
  expect(path).toMatch(/^\/libro\/MLU\d+(?:\/[^/?#]+)?\/?$/);
  await open(path);
  await inspectImages();
  expect(errors, 'ERROR_JAVASCRIPT_EN_RECORRIDO').toEqual([]);
});
