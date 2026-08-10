/**
 * worker-sync/meli-catalog.js
 *
 * Obtiene el catálogo completo de MercadoLibre y lo transforma al esquema
 * que consume R2 (catalog.json). Replica la lógica de local_sync.py.
 *
 * Flujo:
 *   1. fetchAllIds()  — scroll API para obtener IDs activos y pausados
 *   2. fetchDetails() — multi-get /items?ids= en batches de 20
 *   3. buildCatalog() — slim_item, filtro de estados publicables, guarda mínima
 *
 * Esquema de salida (catalog.json):
 *   {
 *     total:      number,
 *     updated_at: ISO string,
 *     items: [{
 *       id, title, author, price, status, available_quantity,
 *       thumbnail, pictures, permalink, start_time,
 *       catalog_listing, catalog_product_id
 *     }]
 *   }
 *
 * Edge cases manejados:
 *   - Rate limit 429 y 5xx transitorios: retry acotado con Retry-After/equal jitter
 *   - scroll_id nulo o results vacíos: fin del scroll, continuar con los IDs que hay
 *   - Errores definitivos en batch de detalles: abortar para no publicar un catálogo parcial
 *   - MIN_ACTIVE_ITEMS: abortar si R2 quedaría con muy pocos items activos
 */

const SCROLL_SLEEP_MS  = 350;  // delay entre páginas de scroll (cortesía ML)
const DETAIL_SLEEP_MS  = 250;  // delay entre batches de detalles
const DETAIL_BATCH     = 20;   // ML multi-get soporta hasta 20 ids por request
const ML_ATTRIBUTES    =       // campos que necesita slim_item + AUTHOR + enriched fields
  'id,title,price,status,available_quantity,thumbnail,pictures,permalink,start_time,attributes,condition,catalog_listing,catalog_product_id';

export const ML_MAX_RETRIES = 6;
export const ML_BASE_BACKOFF_MS = 1000;
export const ML_MAX_BACKOFF_MS = 30000;
export const ML_MAX_CUMULATIVE_WAIT_MS = 120000;
export const ML_SYNC_MAX_RETRY_WAIT_MS = 180000;

const ML_TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);

export function createMlRetryTelemetry() {
  return {
    schema_version: 1,
    transient_count: 0,
    rate_limit_429_count: 0,
    rate_limit_by_phase: { scan: 0, details: 0, unknown: 0 },
    max_retry_after_ms: null,
    max_applied_delay_ms: 0,
    last_event: null,
  };
}

function normalizedRetryContext(requestContext = {}) {
  const phase = ['scan', 'details'].includes(requestContext?.phase)
    ? requestContext.phase
    : 'unknown';
  const catalogStatus = ['active', 'paused'].includes(requestContext?.catalog_status)
    ? requestContext.catalog_status
    : null;
  const positiveInt = value => Number.isInteger(value) && value > 0 ? value : null;
  return {
    phase,
    catalog_status: catalogStatus,
    page: positiveInt(requestContext?.page),
    batch: positiveInt(requestContext?.batch),
    total_batches: positiveInt(requestContext?.total_batches),
    endpoint_kind: ['items_search', 'items_details'].includes(requestContext?.endpoint_kind)
      ? requestContext.endpoint_kind
      : 'other',
  };
}

function recordRetryTelemetry(telemetry, event) {
  if (!telemetry || typeof telemetry !== 'object') return;
  const ctx = normalizedRetryContext(event.requestContext);
  telemetry.transient_count = (Number(telemetry.transient_count) || 0) + 1;
  if (event.status === 429) {
    telemetry.rate_limit_429_count = (Number(telemetry.rate_limit_429_count) || 0) + 1;
    telemetry.rate_limit_by_phase ||= { scan: 0, details: 0, unknown: 0 };
    telemetry.rate_limit_by_phase[ctx.phase] = (Number(telemetry.rate_limit_by_phase[ctx.phase]) || 0) + 1;
  }
  if (Number.isFinite(event.retryAfterMs)) {
    telemetry.max_retry_after_ms = Math.max(Number(telemetry.max_retry_after_ms) || 0, event.retryAfterMs);
  }
  if (Number.isFinite(event.appliedDelayMs)) {
    telemetry.max_applied_delay_ms = Math.max(Number(telemetry.max_applied_delay_ms) || 0, event.appliedDelayMs);
  }
  telemetry.last_event = {
    status: event.status,
    phase: ctx.phase,
    catalog_status: ctx.catalog_status,
    page: ctx.page,
    batch: ctx.batch,
    total_batches: ctx.total_batches,
    endpoint_kind: ctx.endpoint_kind,
    attempt: event.attempt,
    will_retry: Boolean(event.willRetry),
    stop_reason: event.stopReason || null,
    retry_after_ms: Number.isFinite(event.retryAfterMs) ? event.retryAfterMs : null,
    applied_delay_ms: Number.isFinite(event.appliedDelayMs) ? event.appliedDelayMs : null,
  };
}

export function createSyncRetryBudget(maxWaitMs = ML_SYNC_MAX_RETRY_WAIT_MS) {
  return { remainingMs: Math.max(0, Number(maxWaitMs) || 0) };
}

// ─── Entrada pública ──────────────────────────────────────────────────────────

/**
 * Descarga el catálogo completo desde ML y devuelve el payload listo para R2.
 * @param {object} env         — Worker env (env.USER_ID, env.MIN_ACTIVE_ITEMS)
 * @param {string} accessToken — ML access token vigente
 * @returns {{ total, updated_at, items }}
 */
export async function buildCatalog(env, accessToken, {
  statuses = ['active', 'paused'],
  retryBudget = createSyncRetryBudget(),
  mlGetDeps = {},
  telemetry = createMlRetryTelemetry(),
} = {}) {
  const userId         = env.USER_ID;
  const minActiveItems = parseInt(env.MIN_ACTIVE_ITEMS || '500', 10);

  console.log(`[Catalog] Iniciando fetch para seller ${userId}`);

  // Paso 1: consultar explícitamente cada estado solicitado. Preview pide
  // activos + pausados; el catálogo público pide únicamente activos.
  const requestedStatuses = statuses.filter(status => ['active', 'paused'].includes(status));
  if (requestedStatuses.length === 0) throw new Error('[Catalog] No se solicitó un estado publicable.');
  const allIds = await fetchAllIds(
    userId,
    accessToken,
    requestedStatuses,
    retryBudget,
    mlGetDeps,
    telemetry,
  );
  console.log(`[Catalog] IDs obtenidos: ${allIds.length}`);

  if (allIds.length === 0) {
    throw new Error('[Catalog] Scroll devolvió 0 IDs. Abortando para no vaciar R2.');
  }

  // Paso 2: obtener detalles en batches
  const rawItems = await fetchDetails(allIds, accessToken, retryBudget, mlGetDeps, telemetry);
  console.log(`[Catalog] Detalles obtenidos: ${rawItems.length} de ${allIds.length}`);

  // Paso 3: slim + filtro. Closed/deleted/under_review siguen fuera del sitio.
  const dataQuality = createDataQualitySummary();
  const catalogItems = rawItems
    .filter(raw => raw.status === 'active' || raw.status === 'paused')
    .map(raw => slimItem(raw, dataQuality));
  const activeItems = catalogItems.filter(
    item => item.status === 'active' && Number(item.available_quantity) > 0
  );
  const orderItems = catalogItems.filter(
    item => item.status === 'paused' || Number(item.available_quantity) <= 0
  );

  console.log(
    `[Catalog] Disponibles: ${activeItems.length} | por encargo: ${orderItems.length} | excluidos: ${rawItems.length - catalogItems.length}`
  );

  // Guarda mínima: prevenir sobreescribir R2 con catálogo vacío o roto
  if (activeItems.length < minActiveItems) {
    throw new Error(
      `[Catalog] Solo ${activeItems.length} items activos — mínimo requerido: ${minActiveItems}. ` +
      `Abortando para preservar catalog.json en R2.`
    );
  }

  const updatedAt = new Date().toISOString();
  return {
    total:      catalogItems.length,
    active_total: activeItems.length,
    order_total:  orderItems.length,
    updated_at: updatedAt,
    data_quality: dataQuality,
    items:      catalogItems,
  };
}

// ─── Scroll de IDs ────────────────────────────────────────────────────────────

async function fetchAllIds(
  userId,
  accessToken,
  statuses = ['active'],
  retryBudget,
  mlGetDeps = {},
  telemetry = null,
) {
  const ids = [];
  for (const status of statuses) {
    let scrollId = null;
    let page = 0;

    while (true) {
      page++;
      let url =
        `https://api.mercadolibre.com/users/${userId}/items/search` +
        `?limit=100&search_type=scan&status=${encodeURIComponent(status)}`;
      if (scrollId) url += `&scroll_id=${encodeURIComponent(scrollId)}`;

      const data = await mlGet(url, accessToken, {
        ...mlGetDeps,
        retryBudget,
        telemetry,
        requestContext: {
          phase: 'scan',
          catalog_status: status,
          page,
          endpoint_kind: 'items_search',
        },
      });
      const batch = data.results || [];
      scrollId = data.scroll_id || null;
      ids.push(...batch);

      if (page === 1 || page % 20 === 0) {
        console.log(
          `[Catalog] ${status} pág ${page}: +${batch.length} IDs | acumulado: ${ids.length} | scroll: ${scrollId ? 'sí' : 'FIN'}`
        );
      }

      if (batch.length === 0 || !scrollId) break;
      await sleep(SCROLL_SLEEP_MS);
    }
  }

  const uniqueIds = [...new Set(ids)];
  console.log(`[Catalog] Scroll completo: ${uniqueIds.length} IDs únicos`);
  return uniqueIds;
}

// ─── Detalles en batch ───────────────────────────────────────────────────────

async function fetchDetails(ids, accessToken, retryBudget, mlGetDeps = {}, telemetry = null) {
  const items       = [];
  const totalBatches = Math.ceil(ids.length / DETAIL_BATCH);

  for (let i = 0; i < ids.length; i += DETAIL_BATCH) {
    const batch     = ids.slice(i, i + DETAIL_BATCH);
    const batchNum  = Math.floor(i / DETAIL_BATCH) + 1;
    const url       = `https://api.mercadolibre.com/items?ids=${batch.join(',')}&attributes=${ML_ATTRIBUTES}`;

    try {
      const data = await mlGet(url, accessToken, {
        ...mlGetDeps,
        retryBudget,
        telemetry,
        requestContext: {
          phase: 'details',
          batch: batchNum,
          total_batches: totalBatches,
          endpoint_kind: 'items_details',
        },
      });
      // data es un array de { code, body } o directamente el item
      const entries = Array.isArray(data) ? data : [data];
      for (const entry of entries) {
        const item = (entry.code === 200 && entry.body) ? entry.body : entry;
        if (item && item.id) items.push(item);
      }
    } catch (err) {
      const message =
        `[Catalog] Error definitivo en batch ${batchNum}/${totalBatches} ` +
        `(offset ${i}). Abortando para no publicar un catálogo parcial: ${err.message}`;
      console.error(message);
      throw new Error(message, { cause: err });
    }

    if (batchNum % 100 === 0 || batchNum === totalBatches) {
      console.log(`[Catalog] Detalles: batch ${batchNum}/${totalBatches} | items ok: ${items.length}`);
    }

    if (i + DETAIL_BATCH < ids.length) await sleep(DETAIL_SLEEP_MS);
  }

  return items;
}

// ─── Transformación ───────────────────────────────────────────────────────────

/**
 * Devuelve solo los campos que consumen los SSR de Pages (catalogo.js,
 * libro/[[path]].js, sitemap.xml.js, feed.xml.js, /api/catalog).
 * Versión enriquecida: incluye pictures[], ISBN, datos bibliográficos e identidad de catálogo ML.
 */
export function slimItem(raw, dataQuality = createDataQualitySummary()) {
  const attrs = raw.attributes || [];
  return {
    id:                 raw.id,
    title:              raw.title        || null,
    author:             extractAuthor(raw),
    price:              raw.price        ?? null,
    status:             raw.status       || null,
    available_quantity: raw.available_quantity ?? 0,
    condition:          raw.condition    || null,
    thumbnail:          raw.thumbnail    || null,
    pictures:           normalizePictures(raw.pictures),
    permalink:          raw.permalink    || null,
    start_time:         raw.start_time   || null,
    catalog_listing:    typeof raw.catalog_listing === 'boolean' ? raw.catalog_listing : null,
    catalog_product_id: typeof raw.catalog_product_id === 'string' && raw.catalog_product_id.trim()
      ? raw.catalog_product_id.trim()
      : null,
    isbn:               extractIsbn(attrs),
    publisher:          extractPublisher(attrs),
    pages:              extractPages(attrs),
    dimensions:         extractDimensions(attrs, dataQuality),
  };
}

/**
 * Extrae el atributo AUTHOR del array de atributos de ML.
 */
function extractAuthor(raw) {
  return getAttrValue(raw.attributes || [], ['AUTHOR']);
}

// ─── Attribute helpers ────────────────────────────────────────────────────────

/**
 * Busca el primer atributo cuyo id (normalizado a mayúsculas) esté en `ids`
 * y devuelve su valor como string.
 * Prioridad: value_name → value_struct (number + unit) → value_id → value
 */
function getAttrValue(attrs, ids) {
  const upper = ids.map(s => s.toUpperCase());
  for (const attr of (attrs || [])) {
    if (!upper.includes(String(attr.id || '').toUpperCase())) continue;
    if (attr.value_name) return attr.value_name;
    if (attr.value_struct && attr.value_struct.number != null) {
      const unit = attr.value_struct.unit ? ` ${attr.value_struct.unit}` : '';
      return `${attr.value_struct.number}${unit}`;
    }
    if (attr.value_id) return String(attr.value_id);
    if (attr.value)    return String(attr.value);
  }
  return null;
}

function extractIsbn(attrs) {
  return getAttrValue(attrs, ['ISBN', 'EAN', 'GTIN', 'BAR_CODE', 'ISBN_13', 'ISBN_10']);
}

function extractPublisher(attrs) {
  return getAttrValue(attrs, ['PUBLISHER', 'EDITORIAL', 'BRAND']);
}

function extractPages(attrs) {
  const v = getAttrValue(attrs, ['NUMBER_OF_PAGES', 'PAGES']);
  if (!v) return null;
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
}

export function createDataQualitySummary() {
  return {
    items_with_valid_measurements: 0,
    valid_dimension_fields: 0,
    valid_weight_fields: 0,
    omitted_dimension_fields: 0,
    omitted_weight_fields: 0,
    unknown_unit_fields: 0,
  };
}

const DIMENSION_ATTRS = [
  ['height', ['HEIGHT']],
  ['width', ['WIDTH']],
  ['length', ['LENGTH', 'DEPTH']],
];

function findAttr(attrs, ids) {
  const allowed = new Set(ids.map(value => value.toUpperCase()));
  return (attrs || []).find(attr => allowed.has(String(attr?.id || '').toUpperCase())) || null;
}

function parseMeasurement(attr) {
  if (!attr) return { present: false };
  if (attr.value_struct?.number != null) {
    return {
      present: true,
      number: Number(attr.value_struct.number),
      unit: String(attr.value_struct.unit || '').trim(),
    };
  }

  const raw = String(attr.value_name ?? attr.value ?? '').trim();
  if (!raw) return { present: true, number: NaN, unit: '' };
  const match = raw.replace(',', '.').match(/^(-?\d+(?:\.\d+)?)\s*([^\d\s].*)?$/u);
  return {
    present: true,
    number: match ? Number(match[1]) : NaN,
    unit: match ? String(match[2] || '').trim() : '',
  };
}

function normalizedUnit(unit) {
  return String(unit || '')
    .trim()
    .toLowerCase()
    .replaceAll('.', '')
    .replace(/\s+/g, '');
}

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function normalizeDimension(attr) {
  const parsed = parseMeasurement(attr);
  if (!parsed.present) return { present: false };
  const unit = normalizedUnit(parsed.unit);
  const factors = {
    mm: 0.1,
    millimeter: 0.1,
    millimeters: 0.1,
    milimetro: 0.1,
    milimetros: 0.1,
    cm: 1,
    centimeter: 1,
    centimeters: 1,
    centimetro: 1,
    centimetros: 1,
    m: 100,
    meter: 100,
    meters: 100,
    metro: 100,
    metros: 100,
  };
  if (!Object.hasOwn(factors, unit)) return { present: true, valid: false, unknownUnit: true };
  const centimeters = parsed.number * factors[unit];
  if (!Number.isFinite(centimeters) || centimeters < 0.1 || centimeters > 100) {
    return { present: true, valid: false, unknownUnit: false };
  }
  return { present: true, valid: true, value: `${round(centimeters)} cm` };
}

function normalizeWeight(attr) {
  const parsed = parseMeasurement(attr);
  if (!parsed.present) return { present: false };
  const unit = normalizedUnit(parsed.unit);
  const factors = {
    mg: 0.001,
    milligram: 0.001,
    milligrams: 0.001,
    miligramo: 0.001,
    miligramos: 0.001,
    g: 1,
    gr: 1,
    gram: 1,
    grams: 1,
    gramo: 1,
    gramos: 1,
    kg: 1000,
    kilogram: 1000,
    kilograms: 1000,
    kilogramo: 1000,
    kilogramos: 1000,
  };
  if (!Object.hasOwn(factors, unit)) return { present: true, valid: false, unknownUnit: true };
  const grams = parsed.number * factors[unit];
  if (!Number.isFinite(grams) || grams < 1 || grams > 15000) {
    return { present: true, valid: false, unknownUnit: false };
  }
  const value = grams >= 1000
    ? `${round(grams / 1000, 3)} kg`
    : `${round(grams)} g`;
  return { present: true, valid: true, value };
}

export function extractDimensions(attrs, dataQuality = createDataQualitySummary()) {
  const dimensions = {};
  let validFields = 0;

  for (const [field, ids] of DIMENSION_ATTRS) {
    const result = normalizeDimension(findAttr(attrs, ids));
    if (!result.present) continue;
    if (result.valid) {
      dimensions[field] = result.value;
      dataQuality.valid_dimension_fields++;
      validFields++;
    } else {
      dataQuality.omitted_dimension_fields++;
      if (result.unknownUnit) dataQuality.unknown_unit_fields++;
    }
  }

  const weight = normalizeWeight(findAttr(attrs, ['WEIGHT']));
  if (weight.present) {
    if (weight.valid) {
      dimensions.weight = weight.value;
      dataQuality.valid_weight_fields++;
      validFields++;
    } else {
      dataQuality.omitted_weight_fields++;
      if (weight.unknownUnit) dataQuality.unknown_unit_fields++;
    }
  }

  if (validFields > 0) dataQuality.items_with_valid_measurements++;
  if (validFields === 0) return null;
  return {
    ...dimensions,
  };
}

/**
 * Convierte el array pictures de ML a un array de URLs https, máximo 6.
 * Acepta objetos {secure_url, url} o strings directos.
 */
function normalizePictures(pictures, max = 6) {
  if (!Array.isArray(pictures) || pictures.length === 0) return [];
  return pictures
    .slice(0, max)
    .map(p => {
      let url = '';
      if (typeof p === 'string') {
        url = p;
      } else if (p && typeof p === 'object') {
        url = p.secure_url || p.url || '';
      }
      return url.replace('http://', 'https://') || null;
    })
    .filter(Boolean);
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

/**
 * Interpreta Retry-After en segundos enteros o fecha HTTP y lo acota al
 * máximo de espera individual. Devuelve null si el header no es válido.
 */
export function parseRetryAfterMs(value, {
  nowMs = Date.now(),
  maxBackoffMs = ML_MAX_BACKOFF_MS,
} = {}) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  if (/^\d+$/.test(raw)) {
    return Math.min(Number(raw) * 1000, maxBackoffMs);
  }

  const parsedDate = Date.parse(raw);
  if (!Number.isFinite(parsedDate)) return null;
  return Math.min(Math.max(0, parsedDate - nowMs), maxBackoffMs);
}

/** Equal jitter: conserva un piso de la mitad del backoff exponencial. */
export function computeBackoffMs(attempt, {
  random = Math.random,
  baseBackoffMs = ML_BASE_BACKOFF_MS,
  maxBackoffMs = ML_MAX_BACKOFF_MS,
} = {}) {
  const ceiling = Math.min(maxBackoffMs, baseBackoffMs * (2 ** attempt));
  const half = ceiling / 2;
  return Math.floor(half + Math.max(0, Math.min(1, random())) * half);
}

export function sanitizeEndpoint(value) {
  try {
    const url = new URL(String(value));
    return `${url.origin}${url.pathname}`;
  } catch {
    return '[endpoint inválido]';
  }
}

function retryBudgetError(scope, endpoint) {
  const label = scope === 'global' ? 'global del sync' : 'por request';
  return new Error(`[Catalog] Presupuesto de espera ${label} agotado en ${endpoint}`);
}

/**
 * GET a la API de MercadoLibre con retry acotado para 429 y 5xx transitorios.
 */
export async function mlGet(url, accessToken, {
  fetchFn = globalThis.fetch,
  sleepFn = sleep,
  random = Math.random,
  now = Date.now,
  retryBudget = null,
  maxRetries = ML_MAX_RETRIES,
  baseBackoffMs = ML_BASE_BACKOFF_MS,
  maxBackoffMs = ML_MAX_BACKOFF_MS,
  maxCumulativeWaitMs = ML_MAX_CUMULATIVE_WAIT_MS,
  telemetry = null,
  requestContext = null,
} = {}) {
  const endpoint = sanitizeEndpoint(url);
  let cumulativeWaitMs = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resp = await fetchFn(url, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });

    if (resp.ok) return await resp.json();

    if (!ML_TRANSIENT_STATUSES.has(resp.status)) {
      throw new Error(`[Catalog] HTTP ${resp.status} no reintentable en ${endpoint}`);
    }

    // Observamos el Retry-After anunciado sin alterar la política vigente:
    // mlGet sigue aplicando el cap maxBackoffMs (30 s por defecto). Guardamos
    // ambos valores para poder distinguir "ML pidió 60 s" de "esperamos 30 s".
    const retryAfterObservedMs = parseRetryAfterMs(resp.headers?.get?.('Retry-After'), {
      nowMs: now(),
      maxBackoffMs: Number.MAX_SAFE_INTEGER,
    });

    if (attempt >= maxRetries) {
      recordRetryTelemetry(telemetry, {
        status: resp.status,
        requestContext,
        attempt: attempt + 1,
        willRetry: false,
        stopReason: 'max_retries',
        retryAfterMs: retryAfterObservedMs,
        appliedDelayMs: null,
      });
      throw new Error(
        `[Catalog] Agotados ${maxRetries} reintentos tras HTTP ${resp.status} en ${endpoint}`
      );
    }

    const requestRemainingMs = maxCumulativeWaitMs - cumulativeWaitMs;
    if (requestRemainingMs <= 0) {
      recordRetryTelemetry(telemetry, {
        status: resp.status, requestContext, attempt: attempt + 1,
        willRetry: false, stopReason: 'request_budget',
        retryAfterMs: retryAfterObservedMs, appliedDelayMs: null,
      });
      throw retryBudgetError('request', endpoint);
    }

    const globalRemainingMs = retryBudget == null
      ? Number.POSITIVE_INFINITY
      : Number(retryBudget.remainingMs);
    if (globalRemainingMs <= 0) {
      recordRetryTelemetry(telemetry, {
        status: resp.status, requestContext, attempt: attempt + 1,
        willRetry: false, stopReason: 'global_budget',
        retryAfterMs: retryAfterObservedMs, appliedDelayMs: null,
      });
      throw retryBudgetError('global', endpoint);
    }

    const retryAfterAppliedMs = Number.isFinite(retryAfterObservedMs)
      ? Math.min(retryAfterObservedMs, maxBackoffMs)
      : null;
    const calculatedDelayMs = retryAfterAppliedMs ?? computeBackoffMs(attempt, {
      random,
      baseBackoffMs,
      maxBackoffMs,
    });
    const delayMs = Math.max(0, Math.floor(Math.min(
      calculatedDelayMs,
      maxBackoffMs,
      requestRemainingMs,
      globalRemainingMs,
    )));

    recordRetryTelemetry(telemetry, {
      status: resp.status,
      requestContext,
      attempt: attempt + 1,
      willRetry: true,
      stopReason: null,
      retryAfterMs: retryAfterObservedMs,
      appliedDelayMs: delayMs,
    });

    console.warn(
      `[Catalog] HTTP ${resp.status} transitorio en ${endpoint}. ` +
      `Reintento ${attempt + 1}/${maxRetries} en ${delayMs}ms.`
    );

    if (delayMs > 0) {
      await sleepFn(delayMs);
      cumulativeWaitMs += delayMs;
      if (retryBudget != null) retryBudget.remainingMs -= delayMs;
    }
  }

  throw new Error(`[Catalog] Reintentos agotados en ${endpoint}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
