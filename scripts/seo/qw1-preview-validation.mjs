import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// QW1 — validación de solo lectura del criterio de aceptación real: para
// TODO el cohorte de missing_price ya identificado por Merchant, compara
// PRODUCCIÓN vs PREVIEW del PR #313 (mismo path, otro host) y clasifica el
// resultado real. No modifica nada — sólo GET a páginas públicas.

const PREVIEW_HOST = 'pr-313.amadolibros-web.pages.dev';
const FETCH_TIMEOUT_MS = 15_000;

function asText(value) {
  return String(value ?? '').trim();
}

function toPreviewUrl(productionUrl) {
  try {
    const url = new URL(productionUrl);
    url.hostname = PREVIEW_HOST;
    return url.toString();
  } catch {
    return null;
  }
}

function extractCanonical(html) {
  const match = String(html || '').match(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i);
  return match ? match[1] : null;
}

function extractOffer(html) {
  const blocks = [...String(html || '').matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const block of blocks) {
    let parsed;
    try { parsed = JSON.parse(block[1]); } catch { continue; }
    const types = Array.isArray(parsed?.['@type']) ? parsed['@type'] : [parsed?.['@type']];
    if (!types.includes('Product')) continue;
    const offer = parsed.offers;
    if (!offer) return null;
    return {
      price: asText(offer.price) || null,
      priceCurrency: asText(offer.priceCurrency) || null,
      availability: asText(offer.availability).replace('https://schema.org/', '') || null,
      url: asText(offer.url) || null,
    };
  }
  return null;
}

async function fetchSide(url) {
  if (!url) return { httpStatus: null, offer: null, canonical: null, error: 'sin URL' };
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'user-agent': 'AmadoLibros-QW1-Validation/1.0 (solo lectura)' },
    });
    const html = response.status === 200 ? await response.text() : '';
    return {
      httpStatus: response.status,
      offer: response.status === 200 ? extractOffer(html) : null,
      canonical: response.status === 200 ? extractCanonical(html) : null,
      error: null,
    };
  } catch (error) {
    return { httpStatus: null, offer: null, canonical: null, error: asText(error?.message) || 'fetch failed' };
  }
}

function offerLooksValid(side) {
  if (side.httpStatus !== 200 || !side.offer) return false;
  const price = Number(side.offer.price);
  return Number.isFinite(price) && price > 0 &&
    side.offer.priceCurrency === 'UYU' &&
    ['InStock', 'OutOfStock'].includes(side.offer.availability) &&
    Boolean(side.canonical) && side.offer.url === side.canonical;
}

// Revisión de Astra: la etiqueta anterior "B = sigue sin Offer porque no
// tiene precio real" era una INFERENCIA — desde el HTML sólo se ve que no
// hay Offer, nunca por qué. Esta comparación HTTP no puede establecer la
// causa; quien la establece es `qw1-cohort-catalog-evidence.mjs`, que cruza
// cada MLU contra el catálogo que consume cada entorno.
export function classify(production, preview) {
  if (production.httpStatus !== 200 || preview.httpStatus !== 200) {
    return 'no_comparable_http';
  }
  const productionOk = offerLooksValid(production);
  const previewOk = offerLooksValid(preview);
  if (!productionOk && previewOk) return 'corregido_por_313';
  if (productionOk && previewOk) return 'ya_correcto_en_ambos';
  if (productionOk && !previewOk) return 'regresion_en_313';
  return 'sin_offer_causa_pendiente_de_verificar';
}

async function measureOne(row) {
  const productionUrl = row.link;
  const previewUrl = toPreviewUrl(productionUrl);
  const [production, preview] = await Promise.all([fetchSide(productionUrl), fetchSide(previewUrl)]);
  return {
    offerId: row.offerId,
    productionUrl,
    previewUrl,
    production,
    preview,
    classification: classify(production, preview),
  };
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function main() {
  const inputPath = asText(process.env.QW1_VALIDATION_INPUT) || 'artifacts/merchant/merchant-readonly-report.json';
  const outputDir = asText(process.env.QW1_VALIDATION_OUTPUT_DIR) || 'artifacts/qw1-validation';
  const raw = await readFile(inputPath, 'utf8');
  const report = JSON.parse(raw);
  const rows = report.productBreakdown?.missingPrice || [];

  const results = await mapWithConcurrency(rows, 8, measureOne);

  const counts = {
    corregido_por_313: 0,
    ya_correcto_en_ambos: 0,
    regresion_en_313: 0,
    sin_offer_causa_pendiente_de_verificar: 0,
    no_comparable_http: 0,
  };
  for (const row of results) counts[row.classification] += 1;

  const summary = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    totalCohort: results.length,
    // Lo que esta comparación NO puede establecer: la causa de que falte el
    // `Offer`. Eso se resuelve en qw1-cohort-catalog-evidence.mjs.
    alcance: 'comparacion HTTP Produccion vs Preview; no infiere causas',
    counts,
    results,
  };

  const { mkdir } = await import('node:fs/promises');
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, 'qw1-preview-validation.json'), `${JSON.stringify(summary, null, 2)}\n`);

  console.log('=== QW1 PREVIEW VALIDATION (solo lectura) ===');
  console.log(JSON.stringify({ totalCohort: summary.totalCohort, counts }, null, 2));
  console.log('=== QW1 detalle: regresión introducida por #313 ===');
  console.log(JSON.stringify(results.filter(row => row.classification === 'regresion_en_313'), null, 2));
  console.log('=== QW1 detalle: no comparable por HTTP (hasta 10) ===');
  console.log(JSON.stringify(
    results.filter(row => row.classification === 'no_comparable_http').slice(0, 10),
    null,
    2,
  ));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
