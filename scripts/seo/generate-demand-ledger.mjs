#!/usr/bin/env node

/**
 * scripts/seo/generate-demand-ledger.mjs
 *
 * DEMAND-LEDGER-1: convierte los exports ya existentes de Search Console
 * (scripts/seo/gsc-export.mjs, mismo pipeline de siempre — este script no
 * abre ninguna integración nueva) en un artefacto versionado, determinista y
 * revisable en Git, siguiendo el mismo patrón que
 * scripts/seo/generate-paused-cohort.mjs / functions/_shared/paused-seo-cohort.js.
 *
 * El ledger NO decide ni aplica cambios de title, meta ni redirects — sólo
 * calcula oportunidad por URL para que otros lotes (merchandising, hubs,
 * consolidación) lo consuman con criterio propio.
 *
 * Reglas de diseño, explícitas porque cada una es una decisión auditable:
 *
 *  - CTR esperado por posición: se calcula desde los propios datos del sitio
 *    (nunca un benchmark de industria hardcodeado), y EXCLUYE toda página
 *    cuya demanda es 100% de marca — una query de marca infla el CTR de esa
 *    posición y contamina la curva para el resto de las URLs.
 *  - Una URL sólo recibe opportunity_score cuando tiene impresiones
 *    suficientes (por debajo del umbral, el ruido de muestra pequeña no
 *    justifica ninguna acción — ver dictamen previo sobre cola larga).
 *  - El ledger cubre TODO tipo de página presente en el export de GSC (home,
 *    catálogo, hubs de categoría/autor/especialidad, fichas) — no sólo
 *    fichas de producto — porque alimenta tanto priorización de fichas como
 *    gates de hubs.
 *  - Enriquecimiento de producto (estado, stock, ISBN, categoría) viene del
 *    catálogo — en esta primera versión sólo catalog.json (activos). Una
 *    ficha cuyo MLU no está en catalog.json queda con product_status
 *    'unknown': todavía no se integra el índice pausado completo acá. Eso
 *    es una limitación conocida de v1, no un bug — documentarlo es mejor
 *    que fingir que "unknown" significa otra cosa.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { normalizeIsbnToGtin } from '../../functions/feed.xml.js';

const MIN_IMPRESSIONS_FOR_SCORE = 20;
const MIN_BUCKET_IMPRESSIONS = 50;
const MAX_POSITION_BUCKET = 20;

// ---------------------------------------------------------------------------
// Marca — exclusión explícita, nunca implícita
// ---------------------------------------------------------------------------

const BRAND_QUERY_RE = /\bamado[\s-]*libros?\b/i;

export function isBrandQuery(query) {
  return BRAND_QUERY_RE.test(String(query || ''));
}

// ---------------------------------------------------------------------------
// Clasificación de página por URL — sin acoplarse a las allowlists de cada
// hub (seo-categories.js, seo-specialties.js, seo-authors.js): el propio
// segmento de path ya es el identificador, y el ledger no necesita saber si
// ese id está autorizado hoy — sólo describe lo que Google ya está viendo.
// ---------------------------------------------------------------------------

export function productIdFromPage(url) {
  return String(url || '').match(/\/libro\/(MLU\d+)(?:\/|$)/i)?.[1]?.toUpperCase() || null;
}

export function classifyPage(url) {
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return { pageType: 'otro', productId: null, categorySlug: null };
  }
  const clean = pathname.replace(/\/+$/, '') || '/';
  let match;
  if ((match = clean.match(/^\/libro\/(MLU\d+)(?:\/.*)?$/i))) {
    return { pageType: 'ficha', productId: match[1].toUpperCase(), categorySlug: null };
  }
  if (clean === '/catalogo') {
    return { pageType: 'catalogo', productId: null, categorySlug: null };
  }
  if ((match = clean.match(/^\/libros\/([a-z0-9-]+)$/i))) {
    return { pageType: 'categoria_hub', productId: null, categorySlug: match[1] };
  }
  if ((match = clean.match(/^\/especialidades\/([a-z0-9-]+)$/i))) {
    return { pageType: 'especialidad_hub', productId: null, categorySlug: match[1] };
  }
  if ((match = clean.match(/^\/libros-([a-z0-9-]+)-uruguay$/i))) {
    return { pageType: 'autor_hub', productId: null, categorySlug: match[1] };
  }
  if (clean === '/') {
    return { pageType: 'home', productId: null, categorySlug: null };
  }
  return { pageType: 'otro', productId: null, categorySlug: null };
}

// ---------------------------------------------------------------------------
// Curva de CTR esperado por posición — propia del sitio, ventana simétrica
// que se ensancha hasta juntar muestra suficiente. Determinista: mismo input
// siempre produce la misma curva, sin aleatoriedad ni dependencias externas.
// ---------------------------------------------------------------------------

export function buildCtrCurve(rows, { minBucketImpressions = MIN_BUCKET_IMPRESSIONS } = {}) {
  const buckets = new Map();
  for (const row of rows) {
    if (!(row.impressions > 0) || !(row.position > 0)) continue;
    const bucket = Math.min(MAX_POSITION_BUCKET, Math.max(1, Math.round(row.position)));
    const current = buckets.get(bucket) || { impressions: 0, clicks: 0 };
    current.impressions += row.impressions;
    current.clicks += row.clicks;
    buckets.set(bucket, current);
  }

  let globalImpressions = 0;
  let globalClicks = 0;
  for (const b of buckets.values()) {
    globalImpressions += b.impressions;
    globalClicks += b.clicks;
  }
  const globalCtr = globalImpressions > 0 ? globalClicks / globalImpressions : 0;

  const curve = {};
  for (let pos = 1; pos <= MAX_POSITION_BUCKET; pos++) {
    let impressions = 0;
    let clicks = 0;
    let radius = 0;
    while (radius <= MAX_POSITION_BUCKET) {
      impressions = 0;
      clicks = 0;
      const from = Math.max(1, pos - radius);
      const to = Math.min(MAX_POSITION_BUCKET, pos + radius);
      for (let p = from; p <= to; p++) {
        const b = buckets.get(p);
        if (b) {
          impressions += b.impressions;
          clicks += b.clicks;
        }
      }
      if (impressions >= minBucketImpressions) break;
      radius++;
    }
    curve[pos] = impressions > 0 ? clicks / impressions : globalCtr;
  }

  return { curve, globalCtr, sampleImpressions: globalImpressions };
}

export function expectedCtrForPosition(curveResult, position) {
  if (!curveResult || curveResult.sampleImpressions === 0) return null;
  if (!Number.isFinite(position) || position <= 0) return null;
  const bucket = Math.min(MAX_POSITION_BUCKET, Math.max(1, Math.round(position)));
  const value = curveResult.curve[bucket];
  return Number.isFinite(value) ? value : curveResult.globalCtr;
}

// ---------------------------------------------------------------------------
// Score de oportunidad — siempre con un motivo legible, nunca un número sin
// explicación. product_status/stock se pasan ya resueltos por el caller.
// ---------------------------------------------------------------------------

function stockWeight(productStatus, stock) {
  if (productStatus === 'active' && Number(stock) > 0) return 1;
  if (productStatus === 'active') return 0.6;
  if (productStatus === 'paused') return 0.5;
  return 0.4; // hub, home, catálogo u otra página que no es una ficha
}

export function scoreRow({ impressions, ctr, position, productStatus, stock, brandExcluded }, expectedCtr, minImpressionsForScore = MIN_IMPRESSIONS_FOR_SCORE) {
  if (brandExcluded) {
    return { score: null, reason: 'marca: la demanda de esta URL es toda de queries de marca, excluida del score' };
  }
  if (impressions < minImpressionsForScore) {
    return { score: null, reason: `impresiones insuficientes (${impressions} < ${minImpressionsForScore}/28d) para un score confiable` };
  }
  if (expectedCtr == null) {
    return { score: null, reason: 'sin curva de CTR confiable para esta posición (sin muestra no-marca en todo el sitio)' };
  }
  const gap = expectedCtr - ctr;
  const posLabel = Number.isFinite(position) ? position.toFixed(1) : String(position);
  if (gap <= 0) {
    return {
      score: 0,
      reason: `CTR observado (${(ctr * 100).toFixed(1)}%) ya iguala o supera el esperado (${(expectedCtr * 100).toFixed(1)}%) para posición ${posLabel}`,
    };
  }
  const weight = stockWeight(productStatus, stock);
  const score = Math.round(gap * impressions * weight * 100) / 100;
  return {
    score,
    reason: `CTR observado (${(ctr * 100).toFixed(1)}%) ${(gap * 100).toFixed(1)}pt bajo el esperado (${(expectedCtr * 100).toFixed(1)}%) para posición ${posLabel}, ${impressions} impresiones/28d, peso stock ${weight}`,
  };
}

// ---------------------------------------------------------------------------
// Ensamblado principal — puro: mismo input siempre produce el mismo output
// (sin timestamps, sin I/O). generated_at se agrega recién en main().
// ---------------------------------------------------------------------------

export function buildDemandLedger({
  pageRows = [],
  pageQueryRows = [],
  catalogItems = [],
  categoryIndex = {},
  minImpressionsForScore = MIN_IMPRESSIONS_FOR_SCORE,
  minBucketImpressions = MIN_BUCKET_IMPRESSIONS,
} = {}) {
  if (!Array.isArray(pageRows)) throw new Error('pageRows debe ser un array.');
  if (!Array.isArray(pageQueryRows)) throw new Error('pageQueryRows debe ser un array.');
  if (!Array.isArray(catalogItems)) throw new Error('catalogItems debe ser un array.');
  if (!categoryIndex || typeof categoryIndex !== 'object') throw new Error('categoryIndex debe ser un objeto.');

  const catalogById = new Map();
  for (const item of catalogItems) {
    if (item?.id) catalogById.set(String(item.id).toUpperCase(), item);
  }

  // Queries no-marca por página: sólo de datos válidos (page y query como
  // strings no vacíos). Filas malformadas del export se descartan en vez de
  // romper el cálculo — el export ya es la fuente de verdad de GSC; si trae
  // basura puntual, el ledger no debe caerse por eso.
  const queryStatsByPage = new Map();
  for (const row of pageQueryRows) {
    const page = row?.keys?.[0];
    const query = row?.keys?.[1];
    if (typeof page !== 'string' || !page || typeof query !== 'string' || !query) continue;
    const impressions = Number(row.impressions) || 0;
    const clicks = Number(row.clicks) || 0;
    const stats = queryStatsByPage.get(page) || {
      totalImpressions: 0, nonBrandImpressions: 0, nonBrandClicks: 0, topNonBrand: null,
    };
    stats.totalImpressions += impressions;
    if (!isBrandQuery(query)) {
      stats.nonBrandImpressions += impressions;
      stats.nonBrandClicks += clicks;
      if (!stats.topNonBrand || impressions > stats.topNonBrand.impressions) {
        stats.topNonBrand = { query, impressions, clicks };
      }
    }
    queryStatsByPage.set(page, stats);
  }

  const baseRows = [];
  for (const row of pageRows) {
    const url = row?.keys?.[0];
    if (typeof url !== 'string' || !url) continue;
    const impressions = Number(row.impressions) || 0;
    const clicks = Number(row.clicks) || 0;
    const ctr = Number.isFinite(Number(row.ctr)) && row.ctr != null
      ? Number(row.ctr)
      : (impressions > 0 ? clicks / impressions : 0);
    const position = Number(row.position) || 0;
    const qs = queryStatsByPage.get(url);
    // Sólo se declara brand_excluded cuando HAY datos de query para esta
    // página y NINGUNA de esas queries es no-marca. Sin datos de query
    // (página sin desglose disponible) no se asume nada sobre marca.
    const brandExcluded = Boolean(qs) && qs.totalImpressions > 0 && qs.nonBrandImpressions === 0;
    const { pageType, productId, categorySlug } = classifyPage(url);
    baseRows.push({
      url, impressions, clicks, ctr, position, pageType, productId, categorySlug,
      brandExcluded, topQuery: qs?.topNonBrand?.query || null,
    });
  }

  const curveInput = baseRows.filter(r => !r.brandExcluded);
  const curveResult = buildCtrCurve(curveInput, { minBucketImpressions });

  const rows = baseRows.map(r => {
    const product = r.productId ? catalogById.get(r.productId) : null;
    const productStatus = r.productId
      ? (product ? (product.status || 'unknown') : 'unknown')
      : null;
    const stock = product ? (Number(product.available_quantity) || 0) : null;
    const isbn = product ? (normalizeIsbnToGtin(product.isbn).gtin || null) : null;
    const catMap = r.productId ? categoryIndex[r.productId] : null;
    const categoryId = r.pageType === 'categoria_hub'
      ? r.categorySlug
      : (Array.isArray(catMap) ? (catMap[0] || null) : null);
    const subcategoryId = Array.isArray(catMap) ? (catMap[1] || null) : null;

    const expectedCtr = r.brandExcluded ? null : expectedCtrForPosition(curveResult, r.position);
    const ctrGap = expectedCtr != null ? expectedCtr - r.ctr : null;
    const { score, reason } = scoreRow(
      { impressions: r.impressions, ctr: r.ctr, position: r.position, productStatus, stock, brandExcluded: r.brandExcluded },
      expectedCtr,
      minImpressionsForScore,
    );

    return {
      url: r.url,
      page_type: r.pageType,
      product_id: r.productId,
      top_query: r.topQuery,
      brand_excluded: r.brandExcluded,
      impressions: r.impressions,
      clicks: r.clicks,
      ctr: r.ctr,
      position: r.position,
      expected_ctr: expectedCtr,
      ctr_gap: ctrGap,
      product_status: productStatus,
      stock,
      isbn,
      category_id: categoryId,
      subcategory_id: subcategoryId,
      opportunity_score: score,
      score_reason: reason,
    };
  });

  rows.sort((a, b) => {
    const scoreA = a.opportunity_score ?? -Infinity;
    const scoreB = b.opportunity_score ?? -Infinity;
    if (scoreA !== scoreB) return scoreB - scoreA;
    if (a.impressions !== b.impressions) return b.impressions - a.impressions;
    return a.url.localeCompare(b.url);
  });

  return {
    rows,
    meta: {
      total_rows: rows.length,
      ficha_rows: rows.filter(r => r.page_type === 'ficha').length,
      brand_excluded_rows: rows.filter(r => r.brand_excluded).length,
      scored_rows: rows.filter(r => (r.opportunity_score ?? 0) > 0).length,
      unscored_insufficient_data_rows: rows.filter(r => r.opportunity_score == null && !r.brand_excluded).length,
      ctr_curve: curveResult.curve,
      ctr_curve_sample_impressions: curveResult.sampleImpressions,
      ctr_curve_global: curveResult.globalCtr,
      min_impressions_for_score: minImpressionsForScore,
      min_bucket_impressions: minBucketImpressions,
    },
  };
}

// ---------------------------------------------------------------------------
// Artefacto generado — mismo patrón que cohortModuleSource() en
// generate-paused-cohort.mjs: cabecera de "no editar a mano", metadata y
// filas congeladas con Object.freeze, más un par de lookups de conveniencia
// para los consumidores (merchandising, priorización, gates de hub).
// ---------------------------------------------------------------------------

export function ledgerModuleSource({ rows, metadata }) {
  const serializedRows = rows.map(row => `  Object.freeze(${JSON.stringify(row)}),`);
  return `// Archivo generado por scripts/seo/generate-demand-ledger.mjs.\n` +
    `// No editar a mano: regenerar desde el export de GSC (scripts/seo/gsc-export.mjs)\n` +
    `// + catalog.json + active-categories.json.\n\n` +
    `export const DEMAND_LEDGER_META = Object.freeze(${JSON.stringify(metadata, null, 2)});\n\n` +
    `export const DEMAND_LEDGER = Object.freeze([\n${serializedRows.join('\n')}\n]);\n\n` +
    `const DEMAND_LEDGER_BY_URL = new Map(DEMAND_LEDGER.map(row => [row.url, row]));\n` +
    `const DEMAND_LEDGER_BY_PRODUCT_ID = new Map(\n` +
    `  DEMAND_LEDGER.filter(row => row.product_id).map(row => [row.product_id, row]),\n` +
    `);\n\n` +
    `export function opportunityForUrl(url) {\n` +
    `  return DEMAND_LEDGER_BY_URL.get(String(url || '')) || null;\n` +
    `}\n\n` +
    `export function opportunityForProductId(id) {\n` +
    `  return DEMAND_LEDGER_BY_PRODUCT_ID.get(String(id || '').toUpperCase()) || null;\n` +
    `}\n\n` +
    `/** Top N filas con score positivo, ya vienen ordenadas por score desc. */\n` +
    `export function topOpportunities(limit = 20, { pageType } = {}) {\n` +
    `  const filtered = pageType\n` +
    `    ? DEMAND_LEDGER.filter(row => row.page_type === pageType)\n` +
    `    : DEMAND_LEDGER;\n` +
    `  return filtered.filter(row => (row.opportunity_score || 0) > 0).slice(0, limit);\n` +
    `}\n`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function cliOptions(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error(`Falta valor para ${flag}.`);
    if (flag === '--gsc-page') result.gscPage = value;
    else if (flag === '--gsc-page-query') result.gscPageQuery = value;
    else if (flag === '--catalog') result.catalog = value;
    else if (flag === '--categories') result.categories = value;
    else if (flag === '--output') result.output = value;
    else throw new Error(`Argumento desconocido: ${flag}`);
  }
  if (!result.gscPage || !result.gscPageQuery || !result.catalog || !result.output) {
    throw new Error(
      'Uso: --gsc-page search-analytics-page.json --gsc-page-query search-analytics-page-query.json ' +
      '--catalog catalog.json --output demand-ledger.js [--categories active-categories.json]',
    );
  }
  return result;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function main() {
  const options = cliOptions(process.argv.slice(2));
  const [gscPage, gscPageQuery, catalog, categories] = await Promise.all([
    readJson(options.gscPage),
    readJson(options.gscPageQuery),
    readJson(options.catalog),
    options.categories ? readJson(options.categories) : Promise.resolve(null),
  ]);

  const { rows, meta } = buildDemandLedger({
    pageRows: Array.isArray(gscPage.rows) ? gscPage.rows : [],
    pageQueryRows: Array.isArray(gscPageQuery.rows) ? gscPageQuery.rows : [],
    catalogItems: Array.isArray(catalog.items) ? catalog.items : [],
    categoryIndex: categories?.items && typeof categories.items === 'object' ? categories.items : {},
  });

  const metadata = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    gsc_site_url: gscPage.siteUrl || null,
    gsc_date_range: gscPage.dateRange || null,
    ...meta,
  };

  await writeFile(options.output, ledgerModuleSource({ rows, metadata }));
  console.log(JSON.stringify(metadata, null, 2));
  console.log(`Escrito: ${path.resolve(options.output)}`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
