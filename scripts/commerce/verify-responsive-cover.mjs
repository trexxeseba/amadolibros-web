import fs from 'node:fs/promises';
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
const sourceOrigin = new URL(source).origin;
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

  // La zona aplica protección same-origin a las imágenes. La prueba debe
  // ejecutarse dentro de amadolibros.com, igual que una ficha real, y no desde
  // localhost: de lo contrario Chrome bloquea correctamente el recurso.
  await page.goto(`${sourceOrigin}/`, {
    waitUntil: 'domcontentloaded',
    timeout: 45_000,
  });

  let selectedResponseBytes = null;
  let selectedResponseUrl = null;
  page.on('response', async (response) => {
    if (!response.url().includes(`/book-cover/${PRODUCT_ID}/`)) return;
    selectedResponseUrl = response.url();
    selectedResponseBytes = await response.body().then(body => body.length).catch(() => null);
  });

  await page.evaluate(({ src, srcset, sizes }) => {
    document.head.innerHTML = `
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Responsive cover probe</title>
      <style>html,body{margin:0} img{display:block;width:260px;height:auto}</style>
    `;
    document.body.innerHTML = '';

    const image = document.createElement('img');
    image.id = 'cover';
    image.alt = 'Portada de prueba';
    image.width = 360;
    image.height = 540;
    image.fetchPriority = 'high';
    image.sizes = sizes;
    image.srcset = srcset;
    image.src = src;
    document.body.append(image);
  }, responsive);

  const cover = page.locator('#cover');
  await cover.waitFor({ state: 'visible', timeout: 15_000 });
  await cover.evaluate((image) => {
    if (image.complete && image.naturalWidth > 0) return;
    return new Promise((resolve, reject) => {
      image.addEventListener('load', resolve, { once: true });
      image.addEventListener('error', () => reject(new Error(`No cargó ${image.currentSrc || image.src}`)), {
        once: true,
      });
    });
  });

  const browserSelection = await cover.evaluate((image) => ({
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
  const requestOptions = {
    headers: {
      accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    },
  };
  const [response640, response768] = await Promise.all([
    fetch(url640, requestOptions),
    fetch(url768, requestOptions),
  ]);
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
}
