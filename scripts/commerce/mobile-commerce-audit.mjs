import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const BASE_URL = new URL(process.env.BASE_URL || 'https://www.amadolibros.com/');
const OUTPUT_DIR = process.env.MOBILE_AUDIT_OUTPUT_DIR || 'artifacts/mobile-commerce';
const VIEWPORT = { width: 390, height: 844 };

await fs.mkdir(OUTPUT_DIR, { recursive: true });

const report = {
  generatedAt: new Date().toISOString(),
  baseUrl: BASE_URL.href,
  viewport: VIEWPORT,
  stages: [],
  pages: {},
  controls: {},
  consoleErrors: [],
  pageErrors: [],
  failedRequests: [],
  criticalFailures: [],
};

let browser;
let page;
let productUrl = null;

function absoluteUrl(value) {
  return new URL(value, BASE_URL).href;
}

async function stage(name, fn) {
  const startedAt = Date.now();
  try {
    const detail = await fn();
    report.stages.push({ name, ok: true, durationMs: Date.now() - startedAt, detail });
    return detail;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report.stages.push({ name, ok: false, durationMs: Date.now() - startedAt, error: message });
    report.criticalFailures.push(`${name}: ${message}`);
    throw error;
  }
}

async function settle() {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
  await page.waitForTimeout(500);
}

async function pageSnapshot(label) {
  const snapshot = await page.evaluate(() => {
    const root = document.documentElement;
    const navigation = performance.getEntriesByType('navigation')[0];
    const resources = performance.getEntriesByType('resource');
    const transferredBytes = resources.reduce((sum, item) => sum + (item.transferSize || 0), 0);

    return {
      title: document.title,
      url: location.href,
      viewportWidth: root.clientWidth,
      scrollWidth: root.scrollWidth,
      horizontalOverflowPx: Math.max(0, root.scrollWidth - root.clientWidth),
      domContentLoadedMs: navigation ? Math.round(navigation.domContentLoadedEventEnd) : null,
      loadEventMs: navigation ? Math.round(navigation.loadEventEnd) : null,
      responseEndMs: navigation ? Math.round(navigation.responseEnd) : null,
      resourceCount: resources.length,
      transferredBytes,
    };
  });

  report.pages[label] = snapshot;
  if (snapshot.horizontalOverflowPx > 2) {
    report.criticalFailures.push(
      `${label}: desborde horizontal de ${snapshot.horizontalOverflowPx}px en viewport ${VIEWPORT.width}px`,
    );
  }

  await page.screenshot({
    path: path.join(OUTPUT_DIR, `${label}.png`),
    fullPage: true,
  });

  return snapshot;
}

async function assertResponse(response, label) {
  if (!response) throw new Error(`${label} no devolvió respuesta HTTP`);
  if (!response.ok()) throw new Error(`${label} respondió HTTP ${response.status()}`);
}

async function controlMetrics(selector, label) {
  const locator = page.locator(selector);
  await locator.waitFor({ state: 'visible', timeout: 15_000 });
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  const metrics = {
    visible: await locator.isVisible(),
    enabled: await locator.isEnabled(),
    width: box ? Math.round(box.width) : null,
    height: box ? Math.round(box.height) : null,
  };
  report.controls[label] = metrics;

  if (!box || box.height < 44 || box.width < 44) {
    report.criticalFailures.push(
      `${label}: objetivo táctil menor a 44×44px (${metrics.width ?? '?'}×${metrics.height ?? '?'}px)`,
    );
  }

  return metrics;
}

try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: 'es-UY',
    timezoneId: 'America/Montevideo',
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  });

  page = await context.newPage();

  page.on('console', (message) => {
    if (message.type() === 'error') {
      report.consoleErrors.push({ text: message.text(), url: page.url() });
    }
  });
  page.on('pageerror', (error) => {
    report.pageErrors.push({ message: error.message, url: page.url() });
  });
  page.on('requestfailed', (request) => {
    report.failedRequests.push({
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      error: request.failure()?.errorText || 'unknown',
    });
  });

  await stage('Portada mobile', async () => {
    const response = await page.goto(BASE_URL.href, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await assertResponse(response, 'Portada');
    await settle();

    const productLink = page.locator('a[href^="/libro/"]:visible').first();
    await productLink.waitFor({ state: 'visible', timeout: 20_000 });
    const href = await productLink.getAttribute('href');
    if (!href) throw new Error('La portada no expone una ficha de producto navegable');

    productUrl = absoluteUrl(href);
    await fs.writeFile(path.join(OUTPUT_DIR, 'product-url.txt'), `${productUrl}\n`, 'utf8');
    await controlMetrics('[data-action="add-to-cart"]:visible', 'Agregar al carrito — portada');
    return pageSnapshot('01-portada');
  });

  await stage('Ficha mobile', async () => {
    const response = await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await assertResponse(response, 'Ficha');
    await settle();

    const addButton = page.locator('[data-action="add-to-cart"]:visible').first();
    await addButton.waitFor({ state: 'visible', timeout: 20_000 });
    await controlMetrics('[data-action="add-to-cart"]:visible', 'Agregar al carrito — ficha');
    await addButton.click();
    await page.waitForTimeout(800);

    return pageSnapshot('02-ficha');
  });

  await stage('Carrito mobile', async () => {
    const response = await page.goto(absoluteUrl('/carrito'), {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });
    await assertResponse(response, 'Carrito');
    await settle();

    await page.locator('#cart-content').waitFor({ state: 'visible', timeout: 20_000 });
    const itemCount = await page.locator('#cart-items [role="listitem"], #cart-items .cart-item').count();
    if (itemCount < 1) throw new Error('El producto agregado no aparece en el carrito');

    await page.locator('input[name="delivery"][value="shipping"]').check();
    await page.locator('#shipping-fields').waitFor({ state: 'visible', timeout: 5_000 });
    await page.locator('#delivery-address').fill('Av. Test 1234');
    await page.locator('#delivery-barrio').fill('Centro');
    await page.locator('#delivery-departamento').selectOption({ label: 'Montevideo' });

    await page.locator('input[name="delivery"][value="pickup"]').check();
    await page.locator('#pickup-ack-box').waitFor({ state: 'visible', timeout: 5_000 });
    await page.locator('#pickup-ack').check();

    await page.locator('#buyer-name').fill('Prueba Mobile Amado');
    await page.locator('#buyer-phone').fill('099000000');
    await page.locator('#buyer-email').fill('mobile-audit@example.com');

    await controlMetrics('#btn-transfer-order', 'Comprar por transferencia');
    await controlMetrics('#btn-prepare-order', 'Pagar con tarjeta o Mercado Pago');

    return {
      itemCount,
      snapshot: await pageSnapshot('03-carrito-completo'),
    };
  });

  if (report.pageErrors.length > 0) {
    report.criticalFailures.push(`Se detectaron ${report.pageErrors.length} errores JavaScript no controlados`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (!report.criticalFailures.some((entry) => entry.includes(message))) {
    report.criticalFailures.push(message);
  }
} finally {
  if (page) {
    await page.screenshot({
      path: path.join(OUTPUT_DIR, '99-estado-final.png'),
      fullPage: true,
    }).catch(() => {});
  }
  if (browser) await browser.close();

  report.ok = report.criticalFailures.length === 0;
  report.summary = {
    stagesPassed: report.stages.filter((entry) => entry.ok).length,
    stagesTotal: report.stages.length,
    criticalFailures: report.criticalFailures.length,
    consoleErrors: report.consoleErrors.length,
    pageErrors: report.pageErrors.length,
    failedRequests: report.failedRequests.length,
  };

  await fs.writeFile(
    path.join(OUTPUT_DIR, 'mobile-commerce-audit.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );

  const markdown = [
    '# Auditoría mobile de compra',
    '',
    `- Fecha: ${report.generatedAt}`,
    `- Base: ${report.baseUrl}`,
    `- Viewport: ${VIEWPORT.width}×${VIEWPORT.height}`,
    `- Resultado: **${report.ok ? 'APROBADO' : 'FALLÓ'}**`,
    `- Etapas: ${report.summary.stagesPassed}/${report.summary.stagesTotal}`,
    `- Fallas críticas: ${report.summary.criticalFailures}`,
    `- Errores JavaScript: ${report.summary.pageErrors}`,
    `- Solicitudes fallidas: ${report.summary.failedRequests}`,
    '',
    '## Etapas',
    '',
    ...report.stages.map((entry) =>
      `- ${entry.ok ? '✅' : '❌'} ${entry.name} — ${entry.durationMs} ms${entry.error ? ` — ${entry.error}` : ''}`,
    ),
    '',
    '## Fallas críticas',
    '',
    ...(report.criticalFailures.length
      ? report.criticalFailures.map((entry) => `- ${entry}`)
      : ['- Ninguna.']),
    '',
  ].join('\n');

  await fs.writeFile(path.join(OUTPUT_DIR, 'mobile-commerce-audit.md'), markdown, 'utf8');

  if (!report.ok) process.exitCode = 1;
}
