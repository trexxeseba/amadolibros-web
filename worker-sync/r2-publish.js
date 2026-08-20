import {
  assignShowcaseRanking,
  DEFAULT_SHOWCASE_LIMIT,
  LEGACY_SHOWCASE_LIMIT,
} from '../functions/_shared/showcase-ranking.js';
import { PRODUCT_SHOWCASE_OVERRIDES } from '../functions/_shared/product-showcases.js';
import { PRODUCT_SEO_OVERRIDES } from '../functions/_shared/seo-products.js';
import { VERIFIED_BOOK_IDS } from './verified-book-enrichments.js';
import { VERIFIED_DEMAND_BOOK_IDS } from './verified-demand-bibliography.js';

/**
 * worker-sync/r2-publish.js
 *
 * Escribe catalog.json, meta.json y cohortes compactas de fichas vidriera en
 * el bucket R2 amadolibros-catalog usando staging → validación → promote.
 */

const SHOWCASE_V1_STAGING_KEY = 'staging/showcase-cohort-v1.json';
const SHOWCASE_V2_STAGING_KEY = 'staging/showcase-cohort-v2.json';
const SHOWCASE_V1_LIVE_KEY = 'showcase/v1/cohort.json';
const SHOWCASE_V2_LIVE_KEY = 'showcase/v2/cohort.json';
const SHOWCASE_PRIORITY_IDS = new Set([
  ...Object.keys(PRODUCT_SHOWCASE_OVERRIDES),
  ...Object.keys(PRODUCT_SEO_OVERRIDES),
  ...VERIFIED_BOOK_IDS,
  ...VERIFIED_DEMAND_BOOK_IDS,
]);

function validShowcasePayload(payload, { schemaVersion, limit }) {
  return payload &&
    payload.schema_version === schemaVersion &&
    Number.isInteger(payload.total) &&
    payload.total >= 1 &&
    payload.total <= limit &&
    Array.isArray(payload.ids) &&
    payload.ids.length === payload.total &&
    new Set(payload.ids).size === payload.ids.length &&
    payload.ids.every(id => /^MLU\d+$/.test(String(id || '')));
}

/**
 * Marca las mejores ediciones activas y genera dos punteros livianos:
 * - v2: hasta 3.000 fichas, consumida por Pages nuevo;
 * - v1: primeras 1.000, compatible con Pages anterior y rollback inmediato.
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
  const common = {
    generated_at: catalog.updated_at,
    catalog_version: catalog.updated_at,
  };
  const cohort = {
    schema_version: 2,
    ...common,
    total: ids.length,
    ids,
  };
  const legacyIds = ids.slice(0, LEGACY_SHOWCASE_LIMIT);
  const legacyCohort = {
    schema_version: 1,
    ...common,
    total: legacyIds.length,
    ids: legacyIds,
  };

  if (!validShowcasePayload(cohort, {
    schemaVersion: 2,
    limit: DEFAULT_SHOWCASE_LIMIT,
  })) {
    throw new Error('[R2] La cohorte vidriera v2 generada no cumple el contrato.');
  }
  if (!validShowcasePayload(legacyCohort, {
    schemaVersion: 1,
    limit: LEGACY_SHOWCASE_LIMIT,
  })) {
    throw new Error('[R2] La cohorte vidriera v1 de compatibilidad no cumple el contrato.');
  }

  if (syncMeta && typeof syncMeta === 'object') {
    syncMeta.showcase_selection = {
      schema_version: metrics.schema_version,
      limit: metrics.limit,
      selected_items: metrics.selected_items,
      legacy_selected_items: legacyCohort.total,
      selected_with_description: metrics.selected_with_description,
      selected_with_isbn: metrics.selected_with_isbn,
      selected_with_multiple_images: metrics.selected_with_multiple_images,
      selected_editorial: metrics.selected_editorial,
      selected_descriptive: metrics.selected_descriptive,
      selected_bibliographic: metrics.selected_bibliographic,
      selected_title_cleaned: metrics.selected_title_cleaned,
      selected_title_over_70_before: metrics.selected_title_over_70_before,
      selected_title_over_70_after: metrics.selected_title_over_70_after,
    };
  }

  return { cohort, legacyCohort, metrics };
}

export async function publishToR2(env, catalog, syncMeta) {
  const { cohort, legacyCohort, metrics } = prepareShowcaseCatalog(catalog, syncMeta);
  const catalogBody = JSON.stringify(catalog);
  const metaBody = JSON.stringify(syncMeta);
  const cohortBody = JSON.stringify(cohort);
  const legacyCohortBody = JSON.stringify(legacyCohort);

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

  await env.CATALOG_R2.put(SHOWCASE_V1_STAGING_KEY, legacyCohortBody, {
    httpMetadata: {
      contentType: 'application/json',
      cacheControl: 'no-store',
    },
  });

  await env.CATALOG_R2.put(SHOWCASE_V2_STAGING_KEY, cohortBody, {
    httpMetadata: {
      contentType: 'application/json',
      cacheControl: 'no-store',
    },
  });

  console.log('[R2] Staging escrito. Validando readback...');

  // ── 2. Leer de vuelta y validar ────────────────────────────────────────────
  const [stagingObj, stagingV1Obj, stagingV2Obj] = await Promise.all([
    env.CATALOG_R2.get('staging/catalog.json'),
    env.CATALOG_R2.get(SHOWCASE_V1_STAGING_KEY),
    env.CATALOG_R2.get(SHOWCASE_V2_STAGING_KEY),
  ]);
  if (!stagingObj) {
    throw new Error('[R2] Readback de staging/catalog.json devolvió null — R2 inconsistente. Abortando promote.');
  }
  if (!stagingV1Obj || !stagingV2Obj) {
    throw new Error('[R2] Readback de cohortes vidriera devolvió null. Abortando promote.');
  }

  let parsed;
  let parsedV1;
  let parsedV2;
  try {
    const [catalogText, v1Text, v2Text] = await Promise.all([
      stagingObj.text(),
      stagingV1Obj.text(),
      stagingV2Obj.text(),
    ]);
    parsed = JSON.parse(catalogText);
    parsedV1 = JSON.parse(v1Text);
    parsedV2 = JSON.parse(v2Text);
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
  if (!validShowcasePayload(parsedV1, {
    schemaVersion: 1,
    limit: LEGACY_SHOWCASE_LIMIT,
  })) errs.push('cohorte vidriera v1 inválida');
  if (!validShowcasePayload(parsedV2, {
    schemaVersion: 2,
    limit: DEFAULT_SHOWCASE_LIMIT,
  })) errs.push('cohorte vidriera v2 inválida');
  if (parsedV2?.total !== metrics.selected_items) {
    errs.push(`cohorte v2 total (${parsedV2?.total}) !== selected_items (${metrics.selected_items})`);
  }
  if (parsedV1?.total !== Math.min(metrics.selected_items, LEGACY_SHOWCASE_LIMIT)) {
    errs.push(`cohorte v1 total (${parsedV1?.total}) no coincide con compatibilidad esperada`);
  }
  if (Array.isArray(parsedV1?.ids) && Array.isArray(parsedV2?.ids) &&
      JSON.stringify(parsedV1.ids) !== JSON.stringify(parsedV2.ids.slice(0, parsedV1.ids.length))) {
    errs.push('cohorte v1 no es prefijo exacto de v2');
  }

  if (errs.length > 0) {
    throw new Error(`[R2] Validación fallida — archivos live NO modificados. Errores: ${errs.join('; ')}`);
  }

  console.log(
    `[R2] Validación OK: ${parsed.total} items; ` +
    `${parsedV2.total} fichas v2; ${parsedV1.total} fichas v1; updated_at: ${parsed.updated_at}`,
  );

  // ── 3. Promote a live ──────────────────────────────────────────────────────
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

  // Compatibilidad primero: Pages viejo y rollback siempre conservan 1.000.
  await env.CATALOG_R2.put(SHOWCASE_V1_LIVE_KEY, legacyCohortBody, {
    httpMetadata: {
      contentType: 'application/json',
      cacheControl: 'public, max-age=300',
    },
  });

  // v2 último: nunca anuncia una edición antes de catálogo/meta ni deja sin
  // fallback a Pages. Si este put falla, el sitio conserva la cohorte v1.
  await env.CATALOG_R2.put(SHOWCASE_V2_LIVE_KEY, cohortBody, {
    httpMetadata: {
      contentType: 'application/json',
      cacheControl: 'public, max-age=300',
    },
  });

  const bytes = new TextEncoder().encode(catalogBody).length;
  console.log(
    `[R2] Promote completado: ${catalog.total} items, ` +
    `${cohort.total} fichas v2 (${legacyCohort.total} compatibles v1), ` +
    `${(bytes / 1024 / 1024).toFixed(2)} MB, updated_at: ${catalog.updated_at}`,
  );
}
