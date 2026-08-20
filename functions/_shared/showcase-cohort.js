import { R2_BASE } from './catalog.js';
import { perfNow, recordPerf } from './perf.js';

export const SHOWCASE_COHORT_V2_URL = `${R2_BASE}/showcase/v2/cohort.json`;
export const SHOWCASE_COHORT_V1_URL = `${R2_BASE}/showcase/v1/cohort.json`;
export const SHOWCASE_COHORT_URL = SHOWCASE_COHORT_V2_URL;
export const LEGACY_SHOWCASE_COHORT_LIMIT = 1000;
export const SHOWCASE_COHORT_LIMIT = 3000;

// Sólo permite comprobar el renderer en un Preview anterior al primer sync que
// publique la cohorte. Producción jamás usa esta lista de respaldo.
export const SHOWCASE_PREVIEW_SAMPLE_IDS = Object.freeze([
  'MLU644161565',
  'MLU678034726',
  'MLU1467827214',
  'MLU633677061',
  'MLU1304008698',
]);

let memoryCache = {
  expiresAt: 0,
  value: null,
};

function validProductId(value) {
  return /^MLU\d+$/.test(String(value || '').toUpperCase());
}

function limitForSchema(schemaVersion) {
  if (schemaVersion === 2) return SHOWCASE_COHORT_LIMIT;
  if (schemaVersion === 1) return LEGACY_SHOWCASE_COHORT_LIMIT;
  return 0;
}

export function normalizeShowcaseCohort(payload) {
  const schemaVersion = Number(payload?.schema_version);
  const limit = limitForSchema(schemaVersion);
  if (!limit || !Array.isArray(payload?.ids)) return null;
  const ids = payload.ids.map(value => String(value || '').toUpperCase());
  if (ids.length < 1 || ids.length > limit) return null;
  if (ids.some(id => !validProductId(id))) return null;
  if (new Set(ids).size !== ids.length) return null;
  if (Number(payload.total) !== ids.length) return null;

  return {
    schema_version: schemaVersion,
    generated_at: typeof payload.generated_at === 'string' ? payload.generated_at : null,
    catalog_version: typeof payload.catalog_version === 'string' ? payload.catalog_version : null,
    total: ids.length,
    ids: new Set(ids),
    source: `r2-v${schemaVersion}`,
  };
}

function previewFallback(context) {
  if (context?.env?.APP_ENV !== 'preview') return null;
  return {
    schema_version: 2,
    generated_at: null,
    catalog_version: null,
    total: SHOWCASE_PREVIEW_SAMPLE_IDS.length,
    ids: new Set(SHOWCASE_PREVIEW_SAMPLE_IDS),
    source: 'preview-fallback',
  };
}

async function fetchCohortUrl(context, url, timingSuffix) {
  const cache = caches.default;
  const cacheKey = new Request(url);
  const readStartedAt = perfNow();
  const cacheStartedAt = perfNow();
  let response = await cache.match(cacheKey);
  recordPerf(context, `showcase_cohort_${timingSuffix}_cache`, cacheStartedAt, {
    cache: response ? 'hit' : 'miss',
  });

  if (!response) {
    const originStartedAt = perfNow();
    const fetched = await fetch(url);
    recordPerf(context, `showcase_cohort_${timingSuffix}_origin`, originStartedAt);
    if (!fetched.ok) return null;
    response = new Response(fetched.body, {
      status: fetched.status,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300',
      },
    });
    if (typeof context?.waitUntil === 'function') {
      context.waitUntil(cache.put(cacheKey, response.clone()));
    }
  }

  try {
    const bodyStartedAt = perfNow();
    const body = await response.arrayBuffer();
    recordPerf(context, `showcase_cohort_${timingSuffix}_body`, bodyStartedAt, {
      bytes: body.byteLength,
    });
    recordPerf(context, `showcase_cohort_${timingSuffix}_read`, readStartedAt, {
      bytes: body.byteLength,
    });
    const parseStartedAt = perfNow();
    const payload = JSON.parse(new TextDecoder().decode(body));
    recordPerf(context, `showcase_cohort_${timingSuffix}_parse`, parseStartedAt);
    return normalizeShowcaseCohort(payload);
  } catch {
    return null;
  }
}

async function fetchCohort(context) {
  // Rollout sin ventana rota: Pages nuevo intenta v2 (3.000) y conserva v1
  // (1.000) como fallback. Un rollback de Pages también sigue leyendo v1.
  const current = await fetchCohortUrl(context, SHOWCASE_COHORT_V2_URL, 'v2');
  if (current) return current;

  const legacy = await fetchCohortUrl(context, SHOWCASE_COHORT_V1_URL, 'v1');
  return legacy || previewFallback(context);
}

export async function fetchShowcaseCohort(context) {
  if (!['preview', 'production'].includes(context?.env?.APP_ENV)) return null;
  const now = Date.now();
  if (memoryCache.value && memoryCache.expiresAt > now) return memoryCache.value;

  if (!context.data || typeof context.data !== 'object') context.data = {};
  if (!context.data.__showcaseCohortPromise) {
    context.data.__showcaseCohortPromise = fetchCohort(context);
  }
  const value = await context.data.__showcaseCohortPromise;
  if (value) {
    memoryCache = {
      expiresAt: now + 5 * 60 * 1000,
      value,
    };
  }
  return value;
}

export async function isProductInShowcaseCohort(context, productId) {
  const id = String(productId || '').toUpperCase();
  if (!validProductId(id)) return false;
  const cohort = await fetchShowcaseCohort(context);
  return Boolean(cohort?.ids?.has(id));
}

export function resetShowcaseCohortMemoryForTests() {
  memoryCache = { expiresAt: 0, value: null };
}
