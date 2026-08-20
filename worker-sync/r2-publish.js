import {
  assignShowcaseRanking,
  DEFAULT_SHOWCASE_LIMIT,
} from '../functions/_shared/showcase-ranking.js';
import { PRODUCT_SHOWCASE_OVERRIDES } from '../functions/_shared/product-showcases.js';
import { PRODUCT_SEO_OVERRIDES } from '../functions/_shared/seo-products.js';
import { VERIFIED_BOOK_IDS } from './verified-book-enrichments.js';
import { VERIFIED_DEMAND_BOOK_IDS } from './verified-demand-bibliography.js';

/**
 * worker-sync/r2-publish.js
 *
 * Escribe catalog.json, meta.json y la cohorte compacta de fichas vidriera en
 * el bucket R2 amadolibros-catalog usando staging → validación → promote.
 */

const SHOWCASE_COHORT_STAGING_KEY = 'staging/showcase-cohort.json';
const SHOWCASE_COHORT_LIVE_KEY = 'showcase/v1/cohort.json';
const SHOWCASE_PRIORITY_IDS = new Set([
  ...Object.keys(PRODUCT_SHOWCASE_OVERRIDES),
  ...Object.keys(PRODUCT_SEO_OVERRIDES),
  ...VERIFIED_BOOK_IDS,
  ...VERIFIED_DEMAND_BOOK_IDS,
]);

function validShowcasePayload(payload) {
  return payload &&
    payload.schema_version === 1 &&
    Number.isInteger(payload.total) &&
    payload.total >= 1 &&
    payload.total <= DEFAULT_SHOWCASE_LIMIT &&
    Array.isArray(payload.ids) &&
    payload.ids.length === payload.total &&
    new Set(payload.ids).size === payload.ids.length &&
    payload.ids.every(id => /^MLU\d+$/.test(String(id || '')));
}

/**
 * Marca exactamente las mejores ediciones activas del catálogo y genera un
 * puntero liviano para Pages. La selección usa únicamente campos reales:
 * descripción, ISBN, autoría, editorial, páginas, bibliografía, imágenes,
 * identidad de catálogo y stock. Las oportunidades ya verificadas reciben un
 * bonus explícito, sin consultar conectores de publicidad.
 */
export function prepareShowcaseCatalog(catalog, syncMeta = null) {
  if (!catalog || !Array.isArray(catalog.items)) {
    throw new Error('[R2] No se puede preparar la cohorte vidriera: catálogo inválido.');
  }

  const metrics = assignShowcaseRanking(catalog.items, {
    limit: DEFAULT_SHOWCASE_LIMIT,
    priorityIds: SHOWCASE_PRIORITY_IDS,
  });
  if (metrics.selected_items < 1) {
    throw new Error('[R2] No se puede publicar una cohorte vidriera vacía.');
  }

  catalog.data_quality = {
    ...(catalog.data_quality || {}),
    showcase_selection: metrics,
  };

  const ids = catalog.items
    .filter(item => Number.isInteger(item.showcase_rank))
    .sort((a, b) => a.showcase_rank - b.showcase_rank)
    .map(item => item.id);
  const cohort = {
    schema_version: 1,
    generated_at: catalog.updated_at,
    catalog_version: catalog.updated_at,
    total: ids.length,
    ids,
  };

  if (!validShowcasePayload(cohort)) {
    throw new Error('[R2] La cohorte vidriera generada no cumple el contrato.');
  }

  if (syncMeta && typeof syncMeta === 'object') {
    syncMeta.showcase_selection = {
      schema_version: metrics.schema_version,
      limit: metrics.limit,
      selected_items: metrics.selected_items,
      selected_with_description: metrics.selected_with_description,
      selected_with_isbn: metrics.selected_with_isbn,
      selected_with_multiple_images: metrics.selected_with_multiple_images,
    };
  }

  return { cohort, metrics };
}

export async function publishToR2(env, catalog, syncMeta) {
  const { cohort, metrics } = prepareShowcaseCatalog(catalog, syncMeta);
  const catalogBody = JSON.stringify(catalog);
  const metaBody = JSON.stringify(syncMeta);
  const cohortBody = JSON.stringify(cohort);

  // ── 1. Escribir staging ────────────────────────────────────────────────────
  await env.CATALOG_R2.put('staging/catalog.json', catalogBody, {
    httpMetadata: {
      contentType: 'application/json',
      cacheControl: 'no-store',
    },
  });

  await env.CATALOG_R2.put('staging/meta.json', metaBody, {
    httpMetadata: {
      contentType: 'application/json',
      cacheControl: 'no-store',
    },
  });

  await env.CATALOG_R2.put(SHOWCASE_COHORT_STAGING_KEY, cohortBody, {
    httpMetadata: {
      contentType: 'application/json',
      cacheControl: 'no-store',
    },
  });

  console.log('[R2] Staging escrito. Validando readback...');

  // ── 2. Leer de vuelta y validar ────────────────────────────────────────────
  const [stagingObj, stagingShowcaseObj] = await Promise.all([
    env.CATALOG_R2.get('staging/catalog.json'),
    env.CATALOG_R2.get(SHOWCASE_COHORT_STAGING_KEY),
  ]);
  if (!stagingObj) {
    throw new Error('[R2] Readback de staging/catalog.json devolvió null — R2 inconsistente. Abortando promote.');
  }
  if (!stagingShowcaseObj) {
    throw new Error('[R2] Readback de staging/showcase-cohort.json devolvió null. Abortando promote.');
  }

  let parsed;
  let parsedShowcase;
  try {
    const [catalogText, showcaseText] = await Promise.all([
      stagingObj.text(),
      stagingShowcaseObj.text(),
    ]);
    parsed = JSON.parse(catalogText);
    parsedShowcase = JSON.parse(showcaseText);
  } catch (error) {
    throw new Error(`[R2] El staging no es JSON válido: ${error.message}`);
  }

  const errs = [];
  if (typeof parsed.total !== 'number') errs.push('total no es number');
  if (typeof parsed.updated_at !== 'string') errs.push('updated_at no es string');
  if (!Array.isArray(parsed.items)) errs.push('items no es array');
  if (Array.isArray(parsed.items) && parsed.items.length === 0) errs.push('items está vacío');
  if (Array.isArray(parsed.items) && typeof parsed.total === 'number' && parsed.items.length !== parsed.total) {
    errs.push(`items.length (${parsed.items.length}) !== total (${parsed.total})`);
  }
  if (!validShowcasePayload(parsedShowcase)) errs.push('cohorte vidriera inválida');
  if (validShowcasePayload(parsedShowcase) && parsedShowcase.total !== metrics.selected_items) {
    errs.push(`cohorte.total (${parsedShowcase.total}) !== selected_items (${metrics.selected_items})`);
  }

  if (errs.length > 0) {
    throw new Error(`[R2] Validación fallida — archivos live NO modificados. Errores: ${errs.join('; ')}`);
  }

  console.log(
    `[R2] Validación OK: ${parsed.total} items; ` +
    `${parsedShowcase.total} fichas vidriera; updated_at: ${parsed.updated_at}`,
  );

  // ── 3. Promote a live ──────────────────────────────────────────────────────
  // La cohorte se publica antes del catálogo. Si un put posterior fallara, la
  // cohorte contiene sólo IDs de libros activos que también existían en la foto
  // anterior; Pages degrada de forma segura si algún ID no resuelve.
  await env.CATALOG_R2.put(SHOWCASE_COHORT_LIVE_KEY, cohortBody, {
    httpMetadata: {
      contentType: 'application/json',
      cacheControl: 'public, max-age=3600',
    },
  });

  await env.CATALOG_R2.put('catalog.json', catalogBody, {
    httpMetadata: {
      contentType: 'application/json',
      cacheControl: 'public, max-age=3600',
    },
  });

  await env.CATALOG_R2.put('meta.json', metaBody, {
    httpMetadata: {
      contentType: 'application/json',
      cacheControl: 'public, max-age=300',
    },
  });

  const bytes = new TextEncoder().encode(catalogBody).length;
  console.log(
    `[R2] Promote completado: ${catalog.total} items, ` +
    `${cohort.total} fichas vidriera, ` +
    `${(bytes / 1024 / 1024).toFixed(2)} MB, updated_at: ${catalog.updated_at}`,
  );
}
