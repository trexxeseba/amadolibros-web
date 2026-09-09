// Se ejecuta exclusivamente en Checkly. Recorrido de lectura, sin compra ni eventos de Analytics.
const { test, expect } = require('@playwright/test');
/* AMADO_IMAGE_SENSOR */

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
      const r = i.getBoundingClientRect(); return r.width > 20 && r.height > 20 && r.bottom > 0 && r.top < innerHeight;
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
        if (r.width < 20 || r.height < 20 || r.bottom <= 0 || r.top >= innerHeight) continue;
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
  expect(path).toMatch(/^\/libro\/MLU\d+\/?$/);
  await open(path);
  await inspectImages();
  expect(errors, 'ERROR_JAVASCRIPT_EN_RECORRIDO').toEqual([]);
});
