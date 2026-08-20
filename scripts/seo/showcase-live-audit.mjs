import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  SHOWCASE_COHORT_V1_URL,
  SHOWCASE_COHORT_V2_URL,
  SHOWCASE_PREVIEW_SAMPLE_IDS,
} from '../../functions/_shared/showcase-cohort.js';

const BASE_URL = (process.env.SHOWCASE_BASE_URL || 'https://www.amadolibros.com').replace(/\/$/, '');
const EXPECT_INDEXABLE = process.env.SHOWCASE_EXPECT_INDEXABLE !== 'false';
const OUTPUT_DIR = process.env.SHOWCASE_OUTPUT_DIR || 'artifacts/showcase-live';
const CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.SHOWCASE_CONCURRENCY) || 5));
const SAMPLE_SIZE = Math.max(3, Math.min(12, Number(process.env.SHOWCASE_SAMPLE_SIZE) || 5));
const MAX_CANDIDATES = Math.max(SAMPLE_SIZE, Math.min(120, Number(process.env.SHOWCASE_MAX_CANDIDATES) || 60));
const CURATED_ID = 'MLU633557235';
const ACTIVE_PAGE_MARKER = 'class="badge in-stock"';

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

function documentTitle(html) {
  return decodeHtml(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || '');
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

function breadcrumbSchema(html) {
  return schemas(html).find(schema => schema?.['@type'] === 'BreadcrumbList') || null;
}

async function fetchProduct(productId) {
  try {
    const response = await fetch(`${BASE_URL}/libro/${productId}`, {
      redirect: 'follow',
      headers: {
        'user-agent': 'AmadoLibros-Showcase-Audit/2.0',
        'cache-control': 'no-cache',
      },
      signal: AbortSignal.timeout(45_000),
    });
    return {
      productId,
      status: response.status,
      finalUrl: response.url,
      headers: Object.fromEntries(response.headers.entries()),
      html: await response.text(),
      fetchError: null,
    };
  } catch (error) {
    return {
      productId,
      status: 0,
      finalUrl: '',
      headers: {},
      html: '',
      fetchError: error.message,
    };
  }
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

function validCohort(payload) {
  if (![1, 2].includes(Number(payload?.schema_version)) || !Array.isArray(payload?.ids)) return false;
  if (Number(payload.total) !== payload.ids.length || payload.ids.length < 1) return false;
  return payload.ids.every(id => /^MLU\d+$/.test(String(id || '').toUpperCase()));
}

async function fetchCohortCandidateIds() {
  const attempts = [];
  for (const [version, url] of [[2, SHOWCASE_COHORT_V2_URL], [1, SHOWCASE_COHORT_V1_URL]]) {
    try {
      const response = await fetch(url, {
        headers: {
          'user-agent': 'AmadoLibros-Showcase-Audit/2.0',
          'cache-control': 'no-cache',
        },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        attempts.push({ version, url, status: response.status, valid: false });
        continue;
      }
      const payload = await response.json();
      const valid = validCohort(payload);
      attempts.push({ version, url, status: response.status, valid, total: payload?.ids?.length || 0 });
      if (valid) {
        return {
          source: `r2-v${version}`,
          ids: payload.ids.map(id => String(id).toUpperCase()),
          attempts,
        };
      }
    } catch (error) {
      attempts.push({ version, url, status: 0, valid: false, error: error.message });
    }
  }

  // Respaldo sólo para un Preview anterior a la primera cohorte. La selección
  // real de muestras igual hace preflight y nunca convierte un pausado en falla.
  return {
    source: 'preview-fallback-ids',
    ids: [...SHOWCASE_PREVIEW_SAMPLE_IDS],
    attempts,
  };
}

function automaticSampleEligibility(result) {
  if (result.fetchError) return `fetch: ${result.fetchError}`;
  if (result.status !== 200) return `HTTP ${result.status}`;
  if (!result.html.includes(ACTIVE_PAGE_MARKER)) return 'no está activa/con stock';
  if (!result.html.includes('class="product-showcase"')) return 'no recibió vidriera';
  if (!result.html.includes('data-action="add-to-cart"')) return 'no es vendible en checkout';
  const schema = productSchema(result.html, result.productId);
  const rawTypes = schema?.['@type'];
  const types = Array.isArray(rawTypes) ? rawTypes : [rawTypes].filter(Boolean);
  if (!types.includes('Product') || !schema?.offers) return 'no tiene Product + Offer real';
  return null;
}

async function selectAutomaticSamples() {
  const cohort = await fetchCohortCandidateIds();
  const ids = [...new Set([...cohort.ids, ...SHOWCASE_PREVIEW_SAMPLE_IDS])]
    .filter(id => id !== CURATED_ID)
    .slice(0, MAX_CANDIDATES);
  const selected = [];
  const skipped = [];
  const batchSize = Math.max(CONCURRENCY, 8);

  for (let start = 0; start < ids.length && selected.length < SAMPLE_SIZE; start += batchSize) {
    const batch = ids.slice(start, start + batchSize);
    const fetched = await mapConcurrent(batch, fetchProduct);
    for (const result of fetched) {
      const reason = automaticSampleEligibility(result);
      if (reason) {
        skipped.push({ productId: result.productId, reason });
      } else if (selected.length < SAMPLE_SIZE) {
        selected.push(result);
      }
    }
  }

  return { cohort, selected, skipped, candidatesChecked: selected.length + skipped.length };
}

function inspectProduct(result, { curated = false } = {}) {
  const failures = [];
  const html = result.html;
  const showcase = section(html, 'product-showcase');
  const title = h1(html);
  const seoTitle = documentTitle(html);
  const metaRobots = robots(html);
  const xRobots = String(result.headers['x-robots-tag'] || '').toLowerCase();
  const schema = productSchema(html, result.productId);
  const breadcrumb = breadcrumbSchema(html);
  const rawTypes = schema?.['@type'];
  const types = Array.isArray(rawTypes) ? rawTypes : [rawTypes].filter(Boolean);
  const priceIndex = html.indexOf('Precio web/tarjeta:');
  const showcaseIndex = html.indexOf('class="product-showcase"');
  const showcaseWords = decodeHtml(showcase).split(/\s+/).filter(Boolean).length;

  if (result.fetchError) failures.push(`fetch: ${result.fetchError}`);
  if (result.status !== 200) failures.push(`HTTP ${result.status}`);
  if (!title) failures.push('H1 vacío');
  if (!seoTitle) failures.push('title HTML vacío');
  if (!curated && seoTitle.length > 70) failures.push(`title HTML demasiado largo (${seoTitle.length})`);
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
  if (schema && title && schema.name !== title) failures.push('schema.name no coincide con H1 limpio');
  const breadcrumbName = breadcrumb?.itemListElement?.at?.(-1)?.name;
  if (breadcrumbName && title && breadcrumbName !== title) failures.push('breadcrumb no coincide con H1 limpio');
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
    documentTitle: seoTitle,
    documentTitleLength: seoTitle.length,
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
  const selection = await selectAutomaticSamples();
  const curatedResult = await fetchProduct(CURATED_ID);
  const products = [
    ...selection.selected.map(result => inspectProduct(result)),
    inspectProduct(curatedResult, { curated: true }),
  ];
  const selectionFailures = selection.selected.length < SAMPLE_SIZE
    ? [`muestras automáticas insuficientes: ${selection.selected.length}/${SAMPLE_SIZE} después de ${selection.candidatesChecked} candidatos`]
    : [];
  const failures = [
    ...selectionFailures,
    ...products.flatMap(product =>
      product.failures.map(failure => `${product.productId}: ${failure}`)),
  ];
  const automatic = products.filter(product => !product.curated);

  const report = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    expectIndexable: EXPECT_INDEXABLE,
    cohortSource: selection.cohort.source,
    cohortAttempts: selection.cohort.attempts,
    candidatesChecked: selection.candidatesChecked,
    skippedCandidates: selection.skipped,
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
    cohortSource: report.cohortSource,
    candidatesChecked: report.candidatesChecked,
    skipped: report.skippedCandidates.length,
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
