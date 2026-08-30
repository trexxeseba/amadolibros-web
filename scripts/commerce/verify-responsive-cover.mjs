import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  bookCoverUrl,
  cloudflareImageUrl,
  PRODUCT_IMAGE_SIZES,
  responsiveImage,
} from '../../functions/_shared/cloudflare-images.js';

const OUTPUT_DIR = process.env.MOBILE_AUDIT_OUTPUT_DIR || 'artifacts/mobile-commerce';
const PRODUCT_ID = process.env.MOBILE_AUDIT_PRODUCT_ID || 'MLU699238537';
const VIEWPORT = { width: 390, height: 844 };

await fs.mkdir(OUTPUT_DIR, { recursive: true });

const source = bookCoverUrl(PRODUCT_ID);
const responsive = responsiveImage(source, {
  widths: [320, 480, 768, 1024],
  defaultWidth: 480,
  sizes: PRODUCT_IMAGE_SIZES,
});

if (!responsive.srcset.includes(' 640w')) {
  throw new Error('La portada no ofrece la variante intermedia de 640 px');
}
if (responsive.sizes !== '(max-width: 291px) calc(100vw - 32px), 260px') {
  throw new Error(`Declaración sizes inesperada: ${responsive.sizes}`);
}

const html = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Responsive cover probe</title>
  <style>html,body{margin:0} img{display:block;width:260px;height:auto}</style>
</head>
<body>
  <img id="cover"
    src="${responsive.src}"
    srcset="${responsive.srcset}"
    sizes="${responsive.sizes}"
    alt="Portada de prueba"
    width="360"
    height="540"
    fetchpriority="high">
</body>
</html>`;

const server = http.createServer((request, response) => {
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(html);
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

const address = server.address();
if (!address || typeof address === 'string') throw new Error('No se pudo iniciar el servidor de prueba');

let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || undefined,
  });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();

  let selectedResponseBytes = null;
  let selectedResponseUrl = null;
  page.on('response', async (response) => {
    if (!response.url().includes('/cdn-cgi/image/')) return;
    selectedResponseUrl = response.url();
    selectedResponseBytes = await response.body().then(body => body.length).catch(() => null);
  });

  await page.goto(`http://127.0.0.1:${address.port}/`, {
    waitUntil: 'networkidle',
    timeout: 45_000,
  });
  await page.locator('#cover').waitFor({ state: 'visible', timeout: 15_000 });

  const browserSelection = await page.locator('#cover').evaluate((image) => ({
    currentSrc: image.currentSrc,
    naturalWidth: image.naturalWidth,
    naturalHeight: image.naturalHeight,
    clientWidth: image.clientWidth,
    clientHeight: image.clientHeight,
    complete: image.complete,
  }));

  if (!browserSelection.complete || browserSelection.naturalWidth < 1) {
    throw new Error('Chrome no pudo cargar la portada de verificación');
  }
  if (!browserSelection.currentSrc.includes('width=640')) {
    throw new Error(`Chrome eligió una variante inesperada: ${browserSelection.currentSrc}`);
  }

  const url640 = cloudflareImageUrl(source, { width: 640, quality: 85, fit: 'scale-down' });
  const url768 = cloudflareImageUrl(source, { width: 768, quality: 85, fit: 'scale-down' });
  const [response640, response768] = await Promise.all([fetch(url640), fetch(url768)]);
  if (!response640.ok || !response768.ok) {
    throw new Error(`Cloudflare Images respondió ${response640.status}/${response768.status}`);
  }

  const [buffer640, buffer768] = await Promise.all([
    response640.arrayBuffer(),
    response768.arrayBuffer(),
  ]);
  const bytes640 = buffer640.byteLength;
  const bytes768 = buffer768.byteLength;
  const bytesSaved = bytes768 - bytes640;
  const percentSaved = bytes768 > 0 ? Number(((bytesSaved / bytes768) * 100).toFixed(1)) : 0;

  if (bytesSaved <= 0) {
    throw new Error(`La variante 640 px no ahorra bytes (${bytes640} frente a ${bytes768})`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    productId: PRODUCT_ID,
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    declaredSizes: responsive.sizes,
    srcset: responsive.srcset,
    browserSelection,
    selectedResponseUrl,
    selectedResponseBytes,
    comparison: {
      url640,
      url768,
      bytes640,
      bytes768,
      bytesSaved,
      percentSaved,
    },
    ok: true,
  };

  await fs.writeFile(
    path.join(OUTPUT_DIR, 'responsive-cover-verification.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  await page.screenshot({
    path: path.join(OUTPUT_DIR, 'responsive-cover-verification.png'),
    fullPage: true,
  });
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
