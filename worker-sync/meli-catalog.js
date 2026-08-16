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
 *       id, title, author, price, currency, status, available_quantity,
 *       thumbnail, pictures, permalink, start_time,
 *       category_id, domain_id, catalog_listing, catalog_product_id, bibliographic
 *     }]
 *   }
 *
 * Edge cases manejados:
 *   - Rate limit 429 y 5xx transitorios: retry acotado con Retry-After/equal jitter
 *   - scroll_id nulo o results vacíos: fin del scroll, continuar con los IDs que hay
 *   - Errores definitivos en batch de detalles: abortar para no publicar un catálogo parcial
 *   - MIN_ACTIVE_ITEMS: abortar si R2 quedaría con muy pocos items activos
 */

import { applyVerifiedBookEnrichments } from './verified-book-enrichments.js';

const SCROLL_SLEEP_MS  = 350;  // delay entre páginas de scroll (cortesía ML)
const DETAIL_SLEEP_MS  = 250;  // delay entre batches de detalles
const DETAIL_BATCH     = 20;   // ML multi-get soporta hasta 20 ids por request
const DEFAULT_DESCRIPTION_ENRICH_LIMIT = 100;
const DEFAULT_DESCRIPTION_REFRESH_DAYS = 90;
const DEFAULT_DESCRIPTION_SLEEP_MS = 100;
const DEFAULT_GALLERY_ENRICH_LIMIT = 300;
const DEFAULT_GALLERY_REFRESH_DAYS = 90;
const DEFAULT_GALLERY_SLEEP_MS = 75;
const CATALOG_GALLERY_CACHE_KEY = 'catalog-product-galleries/v1/cache.json';
const MAX_GALLERY_IMAGES = 16;
const DESCRIPTION_MAX_CHARS = 5000;
const ML_ATTRIBUTES    =       // campos que necesita slim_item + AUTHOR + enriched fields
  'id,title,price,currency_id,status,available_quantity,thumbnail,pictures,permalink,start_time,attributes,condition,category_id,domain_id,catalog_listing,catalog_product_id';

// Excepciones verificadas el 2026-08-11 sobre el catálogo productivo. Se
// reemplaza sólo la secuencia dañada y únicamente para el ID afectado. Si el
// título se corrige en ML, el fragmento deja de coincidir y el override queda
// automáticamente inerte.
const KNOWN_TITLE_REPAIRS = new Map([
  ['MLU636926011', ['Ãâ¿dãâ³nde', '¿Dónde']],
  ['MLU640799107', ['Ãâ¿y Tãâº?', '¿Y Tú?']],
  ['MLU643854765', ['Ãâ¡es', '¡Es']],
  ['MLU657172162', ['Ãâ¡ngel', 'Ángel']],
  ['MLU673139908', ['Ãâ¡esto', '¡Esto']],
  ['MLU682128938', ['Ãâ¿y', '¿Y']],
  ['MLU702548132', ['Ãâ¿que', '¿Qué']],
  ['MLU710532848', ['Â¡a', '¡A']],
]);

export const ML_MAX_RETRIES = 6;
export const ML_BASE_BACKOFF_MS = 1000;
export const ML_MAX_BACKOFF_MS = 30000;
export const ML_MAX_CUMULATIVE_WAIT_MS = 120000;
export const ML_SYNC_MAX_RETRY_WAIT_MS = 180000;

const ML_TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);

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
  enrichDescriptions = false,
  enrichCatalogPictures = false,
  retryBudget = createSyncRetryBudget(),
  mlGetDeps = {},
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
  );
  console.log(`[Catalog] IDs obtenidos: ${allIds.length}`);

  if (allIds.length === 0) {
    throw new Error('[Catalog] Scroll devolvió 0 IDs. Abortando para no vaciar R2.');
  }

  // Paso 2: obtener detalles en batches
  const rawItems = await fetchDetails(allIds, accessToken, retryBudget, mlGetDeps);
  console.log(`[Catalog] Detalles obtenidos: ${rawItems.length} de ${allIds.length}`);

  // Paso 3: slim + filtro. Closed/deleted/under_review siguen fuera del sitio.
  const dataQuality = createDataQualitySummary();
  const catalogItems = rawItems
    .filter(raw => raw.status === 'active' || raw.status === 'paused')
    .map(raw => slimItem(raw, dataQuality));

  if (enrichDescriptions) {
    dataQuality.descriptions = await enrichCatalogDescriptions(
      catalogItems,
      env,
      accessToken,
      { retryBudget, mlGetDeps },
    );
  }
  if (enrichCatalogPictures) {
    dataQuality.catalog_product_galleries = await enrichCatalogProductPictures(
      catalogItems,
      env,
      accessToken,
      { retryBudget, mlGetDeps },
    );
  }
  dataQuality.verified_book_enrichments = applyVerifiedBookEnrichments(catalogItems);
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

      const data = await mlGet(url, accessToken, { ...mlGetDeps, retryBudget });
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

async function fetchDetails(ids, accessToken, retryBudget, mlGetDeps = {}) {
  const items       = [];
  const totalBatches = Math.ceil(ids.length / DETAIL_BATCH);

  for (let i = 0; i < ids.length; i += DETAIL_BATCH) {
    const batch     = ids.slice(i, i + DETAIL_BATCH);
    const batchNum  = Math.floor(i / DETAIL_BATCH) + 1;
    const url       = `https://api.mercadolibre.com/items?ids=${batch.join(',')}&attributes=${ML_ATTRIBUTES}`;

    try {
      const data = await mlGet(url, accessToken, { ...mlGetDeps, retryBudget });
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
    title:              repairKnownTitle(raw.id, raw.title),
    author:             extractAuthor(raw),
    price:              raw.price        ?? null,
    currency:           normalizeUpperCode(raw.currency_id),
    status:             raw.status       || null,
    available_quantity: raw.available_quantity ?? 0,
    condition:          raw.condition    || null,
    thumbnail:          raw.thumbnail    || null,
    pictures:           normalizePictures(raw.pictures),
    permalink:          raw.permalink    || null,
    start_time:         raw.start_time   || null,
    category_id:        normalizeUpperCode(raw.category_id),
    domain_id:          normalizeUpperCode(raw.domain_id),
    catalog_listing:    typeof raw.catalog_listing === 'boolean' ? raw.catalog_listing : null,
    catalog_product_id: typeof raw.catalog_product_id === 'string' && raw.catalog_product_id.trim()
      ? raw.catalog_product_id.trim()
      : null,
    isbn:               extractIsbn(attrs),
    publisher:          extractPublisher(attrs),
    pages:              extractPages(attrs),
    bibliographic:      extractBibliographicDetails(attrs),
    dimensions:         extractDimensions(attrs, dataQuality),
  };
}

function normalizeUpperCode(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return normalized || null;
}

export function repairKnownTitle(id, title) {
  if (!title) return null;
  const repair = KNOWN_TITLE_REPAIRS.get(String(id || ''));
  if (!repair) return title;
  const [broken, corrected] = repair;
  return String(title).includes(broken)
    ? String(title).replace(broken, corrected)
    : title;
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
    // Mercado Libre representa "No aplica" con value_id=-1. No debe terminar
    // como un dato visible en la ficha.
    if (String(attr.value_id || '') === '-1' && !attr.value_name) continue;
    if (attr.value_name) return String(attr.value_name).trim() || null;
    if (attr.value_struct && attr.value_struct.number != null) {
      const unit = attr.value_struct.unit ? ` ${attr.value_struct.unit}` : '';
      return `${attr.value_struct.number}${unit}`;
    }
    if (attr.value_id) return String(attr.value_id);
    if (attr.value)    return String(attr.value);
  }
  return null;
}

const BIBLIOGRAPHIC_ATTRS = {
  language: ['LANGUAGE'],
  format: ['BOOK_FORMAT', 'FORMAT'],
  edition: ['EDITION'],
  publication_year: ['PUBLICATION_YEAR', 'PUBLISHING_YEAR', 'RELEASE_YEAR'],
  genre: ['BOOK_GENRE', 'GENRE'],
  collection: ['BOOK_COLLECTION', 'COLLECTION'],
  translator: ['TRANSLATOR'],
  illustrator: ['ILLUSTRATOR'],
  subtitle: ['BOOK_SUBTITLE', 'SUBTITLE'],
};

/**
 * Conserva únicamente atributos bibliográficos útiles ya presentes en ML.
 * No genera texto ni completa faltantes con inferencias.
 */
export function extractBibliographicDetails(attrs) {
  const details = Object.fromEntries(
    Object.entries(BIBLIOGRAPHIC_ATTRS)
      .map(([field, ids]) => [field, getAttrValue(attrs, ids)])
      .filter(([, value]) => value != null && value !== ''),
  );
  return Object.keys(details).length ? details : null;
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

export function sanitizeDescription(value, maxChars = DESCRIPTION_MAX_CHARS) {
  if (value == null) return null;
  const clean = String(value)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!clean) return null;
  return clean.slice(0, Math.max(0, maxChars)).trim() || null;
}

function validCheckedAt(value, refreshDays, nowMs) {
  const checkedMs = Date.parse(String(value || ''));
  return Number.isFinite(checkedMs) && nowMs - checkedMs < refreshDays * 86400000;
}

async function readPreviousDescriptions(bucket) {
  const previous = new Map();
  if (!bucket || typeof bucket.get !== 'function') return previous;
  try {
    const object = await bucket.get('catalog.json');
    if (!object) return previous;
    const catalog = JSON.parse(await object.text());
    for (const item of (catalog.items || [])) {
      if (!item?.id || !item.description_checked_at) continue;
      previous.set(item.id, {
        description: sanitizeDescription(item.description),
        description_checked_at: item.description_checked_at,
      });
    }
  } catch (error) {
    console.warn(`[Catalog] No se pudo reutilizar el caché de descripciones: ${error.message}`);
  }
  return previous;
}

/**
 * ML expone /items/:id/description de a una publicación. Para no sumar miles
 * de requests a cada sync, reutiliza el catálogo live y completa un cupo
 * incremental. La descripción es opcional: un fallo nunca bloquea catálogo.
 */
export async function enrichCatalogDescriptions(items, env, accessToken, {
  retryBudget = createSyncRetryBudget(),
  mlGetDeps = {},
  now = new Date(),
} = {}) {
  const limit = Math.max(0, parseInt(
    env?.ML_DESCRIPTION_ENRICH_LIMIT || String(DEFAULT_DESCRIPTION_ENRICH_LIMIT),
    10,
  ) || 0);
  const refreshDays = Math.max(1, parseInt(
    env?.ML_DESCRIPTION_REFRESH_DAYS || String(DEFAULT_DESCRIPTION_REFRESH_DAYS),
    10,
  ) || DEFAULT_DESCRIPTION_REFRESH_DAYS);
  const checkedAt = now.toISOString();
  const previous = await readPreviousDescriptions(env?.CATALOG_R2);
  const candidates = [];
  let reused = 0;

  for (const item of items) {
    const cached = previous.get(item.id);
    if (cached && validCheckedAt(cached.description_checked_at, refreshDays, now.getTime())) {
      item.description = cached.description;
      item.description_checked_at = cached.description_checked_at;
      reused++;
    } else if (item.status === 'active' && Number(item.available_quantity) > 0) {
      candidates.push(item);
    }
  }

  let fetched = 0;
  let failed = 0;
  const selected = candidates.slice(0, limit);
  const interRequestSleepMs = Math.max(0, parseInt(
    env?.ML_DESCRIPTION_SLEEP_MS || String(DEFAULT_DESCRIPTION_SLEEP_MS),
    10,
  ) || 0);
  for (let index = 0; index < selected.length; index++) {
    const item = selected[index];
    try {
      const payload = await mlGet(
        `https://api.mercadolibre.com/items/${encodeURIComponent(item.id)}/description`,
        accessToken,
        { ...mlGetDeps, retryBudget },
      );
      item.description = sanitizeDescription(payload?.plain_text);
      item.description_checked_at = checkedAt;
      fetched++;
    } catch (error) {
      // Un 404 equivale a "sin descripción" y se cachea para no insistir a
      // diario. Otros errores quedan pendientes para la próxima corrida.
      if (/HTTP 404\b/.test(String(error?.message || ''))) {
        item.description = null;
        item.description_checked_at = checkedAt;
        fetched++;
      } else {
        failed++;
        console.warn(`[Catalog] Descripción ${item.id} pendiente: ${error.message}`);
      }
    }
    if (index + 1 < selected.length && interRequestSleepMs > 0) {
      await (mlGetDeps.sleepFn || sleep)(interRequestSleepMs);
    }
  }

  const checked = items.filter(item => item.description_checked_at).length;
  const present = items.filter(item => sanitizeDescription(item.description)).length;
  return {
    limit,
    reused,
    fetched,
    failed,
    checked,
    present,
    pending: Math.max(0, candidates.length - fetched),
    refresh_days: refreshDays,
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
 * Convierte el array pictures de ML a URLs https. El tope 16 coincide con la
 * guarda del proxy y evita truncar galerías especiales a las seis fotos que
 * admitía históricamente la ficha.
 * Acepta objetos {secure_url, url} o strings directos.
 */
export function normalizePictures(pictures, max = MAX_GALLERY_IMAGES) {
  if (!Array.isArray(pictures) || pictures.length === 0) return [];
  const normalized = pictures
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
  return [...new Set(normalized)].slice(0, Math.max(0, Number(max) || 0));
}

function freshGalleryEntry(entry, refreshDays, nowMs) {
  return Array.isArray(entry?.pictures) &&
    validCheckedAt(entry.checked_at, refreshDays, nowMs);
}

function galleryPriorityIds(env) {
  return new Set(String(env?.ML_CATALOG_GALLERY_PRIORITY_IDS || '')
    .split(',')
    .map(value => value.trim().toUpperCase())
    .filter(value => /^MLU\d+$/.test(value)));
}

async function readCatalogGalleryCache(bucket) {
  if (!bucket || typeof bucket.get !== 'function') {
    return { schema_version: 1, updated_at: null, entries: {} };
  }
  try {
    const object = await bucket.get(CATALOG_GALLERY_CACHE_KEY);
    if (!object) return { schema_version: 1, updated_at: null, entries: {} };
    const parsed = JSON.parse(await object.text());
    if (parsed?.schema_version !== 1 || !parsed.entries ||
        typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) {
      throw new Error('esquema inválido');
    }
    return parsed;
  } catch (error) {
    console.warn(`[Catalog] No se pudo reutilizar la caché de galerías: ${error.message}`);
    return { schema_version: 1, updated_at: null, entries: {} };
  }
}

function mergeOfficialGallery(item, pictures) {
  const merged = normalizePictures([
    ...(Array.isArray(item?.pictures) ? item.pictures : []),
    ...normalizePictures(pictures),
  ]);
  if (merged.length > 0) item.pictures = merged;
}

/**
 * Las publicaciones de catálogo pueden exponer una sola foto en /items aunque
 * la página de producto de ML tenga una galería completa. Reutiliza una caché
 * R2 y consulta incrementalmente /products/:catalog_product_id para completar
 * hasta dieciséis imágenes oficiales sin sumar miles de requests a cada sync.
 */
export async function enrichCatalogProductPictures(items, env, accessToken, {
  retryBudget = createSyncRetryBudget(),
  mlGetDeps = {},
  now = new Date(),
} = {}) {
  const limit = Math.max(0, parseInt(
    env?.ML_CATALOG_GALLERY_ENRICH_LIMIT || String(DEFAULT_GALLERY_ENRICH_LIMIT),
    10,
  ) || 0);
  const refreshDays = Math.max(1, parseInt(
    env?.ML_CATALOG_GALLERY_REFRESH_DAYS || String(DEFAULT_GALLERY_REFRESH_DAYS),
    10,
  ) || DEFAULT_GALLERY_REFRESH_DAYS);
  const sleepMs = Math.max(0, parseInt(
    env?.ML_CATALOG_GALLERY_SLEEP_MS || String(DEFAULT_GALLERY_SLEEP_MS),
    10,
  ) || 0);
  const checkedAt = now.toISOString();
  const cache = await readCatalogGalleryCache(env?.CATALOG_R2);
  const groups = new Map();

  for (const item of items) {
    const productId = String(item?.catalog_product_id || '').trim().toUpperCase();
    if (!/^MLU\d+$/.test(productId)) continue;
    if (!groups.has(productId)) groups.set(productId, []);
    groups.get(productId).push(item);
  }

  const priorityIds = galleryPriorityIds(env);
  const candidates = [];
  let reused = 0;
  for (const [productId, productItems] of groups) {
    const cached = cache.entries[productId];
    if (freshGalleryEntry(cached, refreshDays, now.getTime())) {
      for (const item of productItems) mergeOfficialGallery(item, cached.pictures);
      reused++;
      continue;
    }
    const newestStart = Math.max(...productItems.map(item => Date.parse(item.start_time || '') || 0));
    const fewestPictures = Math.min(...productItems.map(item => normalizePictures(item.pictures).length));
    candidates.push({ productId, productItems, newestStart, fewestPictures });
  }

  candidates.sort((a, b) => {
    const priorityA = priorityIds.has(a.productId) ? 1 : 0;
    const priorityB = priorityIds.has(b.productId) ? 1 : 0;
    if (priorityA !== priorityB) return priorityB - priorityA;
    if (a.fewestPictures !== b.fewestPictures) return a.fewestPictures - b.fewestPictures;
    if (a.newestStart !== b.newestStart) return b.newestStart - a.newestStart;
    return a.productId.localeCompare(b.productId);
  });

  let fetched = 0;
  let failed = 0;
  let galleriesWithMultipleImages = 0;
  const selected = candidates.slice(0, limit);
  for (let index = 0; index < selected.length; index++) {
    const candidate = selected[index];
    try {
      const payload = await mlGet(
        `https://api.mercadolibre.com/products/${encodeURIComponent(candidate.productId)}`,
        accessToken,
        { ...mlGetDeps, retryBudget },
      );
      const pictures = normalizePictures(payload?.pictures);
      cache.entries[candidate.productId] = { pictures, checked_at: checkedAt };
      for (const item of candidate.productItems) mergeOfficialGallery(item, pictures);
      if (pictures.length > 1) galleriesWithMultipleImages++;
      fetched++;
    } catch (error) {
      failed++;
      const stale = cache.entries[candidate.productId];
      if (Array.isArray(stale?.pictures)) {
        for (const item of candidate.productItems) mergeOfficialGallery(item, stale.pictures);
      }
      console.warn(`[Catalog] Galería ${candidate.productId} pendiente: ${error.message}`);
    }
    if (index + 1 < selected.length && sleepMs > 0) {
      await (mlGetDeps.sleepFn || sleep)(sleepMs);
    }
  }

  let cacheWriteError = null;
  if (fetched > 0 && env?.CATALOG_R2 && typeof env.CATALOG_R2.put === 'function') {
    try {
      cache.updated_at = checkedAt;
      await env.CATALOG_R2.put(CATALOG_GALLERY_CACHE_KEY, JSON.stringify(cache), {
        httpMetadata: {
          contentType: 'application/json',
          cacheControl: 'no-store',
        },
      });
    } catch (error) {
      // La caché acelera la siguiente corrida, pero nunca debe impedir que el
      // catálogo enriquecido que ya está en memoria llegue a producción.
      cacheWriteError = String(error?.message || 'Error').slice(0, 240);
      console.warn(`[Catalog] No se pudo guardar la caché de galerías: ${cacheWriteError}`);
    }
  }

  return {
    limit,
    products: groups.size,
    reused,
    fetched,
    failed,
    multiple_image_galleries: galleriesWithMultipleImages,
    pending: Math.max(0, candidates.length - fetched),
    refresh_days: refreshDays,
    cache_write_error: cacheWriteError,
  };
}

export const CATALOG_PRODUCT_GALLERY_CACHE_KEY = CATALOG_GALLERY_CACHE_KEY;

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

    if (attempt >= maxRetries) {
      throw new Error(
        `[Catalog] Agotados ${maxRetries} reintentos tras HTTP ${resp.status} en ${endpoint}`
      );
    }

    const requestRemainingMs = maxCumulativeWaitMs - cumulativeWaitMs;
    if (requestRemainingMs <= 0) throw retryBudgetError('request', endpoint);

    const globalRemainingMs = retryBudget == null
      ? Number.POSITIVE_INFINITY
      : Number(retryBudget.remainingMs);
    if (globalRemainingMs <= 0) throw retryBudgetError('global', endpoint);

    const retryAfterMs = parseRetryAfterMs(resp.headers?.get?.('Retry-After'), {
      nowMs: now(),
      maxBackoffMs,
    });
    const calculatedDelayMs = retryAfterMs ?? computeBackoffMs(attempt, {
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
