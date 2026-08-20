import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { SHOWCASE_PREVIEW_SAMPLE_IDS } from '../../functions/_shared/showcase-cohort.js';

const BASE_URL = (process.env.SHOWCASE_BASE_URL || 'https://www.amadolibros.com').replace(/\/$/, '');
const EXPECT_INDEXABLE = process.env.SHOWCASE_EXPECT_INDEXABLE !== 'false';
const OUTPUT_DIR = process.env.SHOWCASE_OUTPUT_DIR || 'artifacts/showcase-live';
const CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.SHOWCASE_CONCURRENCY) || 5));
const CURATED_ID = 'MLU633557235';

function decodeHtml(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function robots(html) {
  return String(html.match(/<meta\s+name="robots"\s+content="([^"]+)"/i)?.[1] || '').toLowerCase();
}

function canonical(html) {
  return String(html.match(/<link\s+rel="canonical"\s+href="([^"]+)"/i)?.[1] || '');
}

function h1(html) {
  return decodeHtml(html.match(/<h1>([\s\S]*?)<\/h1>/i)?.[1] || '');
}

function section(html, className) {
  const marker = `<section class="${className}"`;
  const start = html.indexOf(marker);
  if (start < 0) return '';

  // product-showcase contiene secciones anidadas. No se puede cortar en el
  // siguiente <section>: se toma el bloque completo hasta relacionados o main.
  const relatedBooks = html.indexOf('<section class="related-books"', start + marker.length);
  const mainEnd = html.indexOf('</main>', start + marker.length);
  const end = [relatedBooks, mainEnd]
    .filter(index => index > start)
    .sort((a, b) => a - b)[0];
  return html.slice(start, end > start ? end : undefined);
}

function schemas(html) {
  const values = [];
  for (const match of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try {
      values.push(JSON.parse(match[1]));
    } catch {
      // El reporte agrega una falla independiente si no encuentra Product/Book.
    }
  }
  return values;
}

function productSchema(html, productId) {
  return schemas(html).find(schema => {
    const rawType = schema?.['@type'];
    const types = Array.isArray(rawType) ? rawType : [rawType].filter(Boolean);
    return types.includes('Book') && String(schema.sku || '').toUpperCase() === productId;
  }) || null;
}

async function fetchProduct(productId) {
  const response = await fetch(`${BASE_URL}/libro/${productId}`, {
    redirect: 'follow',
    headers: { 'user-agent': 'AmadoLibros-Showcase-Audit/1.0' },
    signal: AbortSignal.timeout(45_000),
  });
  return {
    productId,
    status: response.status,
    finalUrl: response.url,
    headers: Object.fromEntries(response.headers.entries()),
    html: await response.text(),
  };
}

async function mapConcurrent(values, mapper) {
  const results = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, values.length) }, worker));
  return results;
}

function inspectProduct(result, { curated = false } = {}) {
  const failures = [];
  const html = result.html;
  const showcase = section(html, 'product-showcase');
  const title = h1(html);
  const metaRobots = robots(html);
  const xRobots = String(result.headers['x-robots-tag'] || '').toLowerCase();
  const schema = productSchema(html, result.productId);
  const rawTypes = schema?.['@type'];
  const types = Array.isArray(rawTypes) ? rawTypes : [rawTypes].filter(Boolean);
  const priceIndex = html.indexOf('Precio web/tarjeta:');
  const showcaseIndex = html.indexOf('class="product-showcase"');
  const showcaseWords = decodeHtml(showcase).split(/\s+/).filter(Boolean).length;

  if (result.status !== 200) failures.push(`HTTP ${result.status}`);
  if (!title) failures.push('H1 vacío');
  if (!showcase) failures.push('falta .product-showcase');
  if (showcase && showcaseWords < 80) failures.push(`vidriera demasiado breve (${showcaseWords} palabras)`);
  if (!html.includes('class="book-subtitle"')) failures.push('falta subtítulo visible');
  if (!html.includes('Datos destacados') && !html.includes('Qué vas a encontrar')) {
    failures.push('falta bloque de datos destacados');
  }
  if (!html.includes('Ficha de esta edición')) failures.push('falta ficha de edición');
  if (!html.includes('data-action="add-to-cart"')) failures.push('falta agregar al carrito');
  if (!html.includes('wa.me/')) failures.push('falta WhatsApp');
  if (!html.includes('mercadolibre.com.uy')) failures.push('falta enlace Mercado Libre');
  if (priceIndex < 0) failures.push('falta precio web/tarjeta');
  if (priceIndex >= 0 && showcaseIndex >= 0 && priceIndex > showcaseIndex) {
    failures.push('la vidriera desplazó el precio debajo del contenido');
  }
  if (!schema) failures.push('falta schema Book/Product');
  if (schema && !types.includes('Product')) failures.push('ficha vendible perdió Product');
  if (schema && !schema.offers) failures.push('ficha vendible perdió Offer real');
  if (schema?.review || schema?.aggregateRating) failures.push('apareció review/rating no autorizado');
  if (/class="product-showcase"[\s\S]*?(?:★★★★★|5\/5|rating)/i.test(showcase)) {
    failures.push('la vidriera contiene una calificación no autorizada');
  }

  try {
    const finalOrigin = new URL(result.finalUrl).origin;
    if (finalOrigin !== new URL(BASE_URL).origin) failures.push(`redirect fuera de Preview: ${finalOrigin}`);
  } catch {
    failures.push('URL final inválida');
  }
  if (!canonical(html).startsWith('https://www.amadolibros.com/libro/')) {
    failures.push(`canonical inválido: ${canonical(html) || 'vacío'}`);
  }

  if (EXPECT_INDEXABLE) {
    if (!metaRobots.includes('index') || metaRobots.includes('noindex')) failures.push('robots no es index, follow');
    if (xRobots.includes('noindex')) failures.push('X-Robots-Tag noindex en producción');
  } else {
    if (!metaRobots.includes('noindex')) failures.push('meta robots noindex ausente en Preview');
    if (!xRobots.includes('noindex')) failures.push('X-Robots-Tag noindex ausente en Preview');
  }

  if (curated) {
    if (title !== 'Padres fuertes, hijas felices') failures.push('el piloto curado perdió su H1');
    if (!html.includes('Guía práctica sobre el vínculo entre padres e hijas')) {
      failures.push('el piloto curado fue reemplazado por contenido automático');
    }
  }

  return {
    productId: result.productId,
    status: result.status,
    finalUrl: result.finalUrl,
    title,
    canonical: canonical(html),
    robots: metaRobots,
    xRobotsTag: xRobots,
    showcaseWords,
    curated,
    hasCart: html.includes('data-action="add-to-cart"'),
    hasWhatsApp: html.includes('wa.me/'),
    hasMercadoLibre: html.includes('mercadolibre.com.uy'),
    hasOffer: Boolean(schema?.offers),
    failures,
  };
}

async function main() {
  const ids = [...SHOWCASE_PREVIEW_SAMPLE_IDS, CURATED_ID];
  const fetched = await mapConcurrent(ids, fetchProduct);
  const products = fetched.map(result => inspectProduct(result, {
    curated: result.productId === CURATED_ID,
  }));
  const failures = products.flatMap(product =>
    product.failures.map(failure => `${product.productId}: ${failure}`));
  const automatic = products.filter(product => !product.curated);

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    expectIndexable: EXPECT_INDEXABLE,
    automaticSamples: automatic.length,
    automaticPassed: automatic.filter(product => product.failures.length === 0).length,
    curatedPassed: products.find(product => product.curated)?.failures.length === 0,
    failures,
    products,
  };

  await mkdir(OUTPUT_DIR, { recursive: true });
  const outputPath = path.join(OUTPUT_DIR, 'showcase-live-audit.json');
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    automaticSamples: report.automaticSamples,
    automaticPassed: report.automaticPassed,
    curatedPassed: report.curatedPassed,
    failures: report.failures.length,
  }));
  console.log(`Escrito: ${outputPath}`);

  if (failures.length) {
    throw new Error(`Auditoría de fichas vidriera falló: ${failures.join(' | ')}`);
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
