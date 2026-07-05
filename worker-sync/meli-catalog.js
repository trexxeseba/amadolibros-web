/**
 * worker-sync/meli-catalog.js
 *
 * Obtiene el catálogo completo de MercadoLibre y lo transforma al esquema
 * que consume R2 (catalog.json). Replica la lógica de local_sync.py.
 *
 * Flujo:
 *   1. fetchAllIds()  — scroll API (search_type=scan) para obtener todos los IDs
 *   2. fetchDetails() — multi-get /items?ids= en batches de 20
 *   3. buildCatalog() — slim_item, filtro activos, guarda mínimo
 *
 * Esquema de salida (catalog.json):
 *   {
 *     total:      number,
 *     updated_at: ISO string,
 *     items: [{
 *       id, title, author, price, status, available_quantity,
 *       thumbnail, pictures, permalink, start_time
 *     }]
 *   }
 *
 * Edge cases manejados:
 *   - Rate limit 429: retry con 2s de delay
 *   - scroll_id nulo o results vacíos: fin del scroll, continuar con los IDs que hay
 *   - Errores en batch de detalles: loguear y continuar (no abortar sync completo)
 *   - MIN_ACTIVE_ITEMS: abortar si R2 quedaría con muy pocos items activos
 */

const SCROLL_SLEEP_MS  = 350;  // delay entre páginas de scroll (cortesía ML)
const DETAIL_SLEEP_MS  = 250;  // delay entre batches de detalles
const DETAIL_BATCH     = 20;   // ML multi-get soporta hasta 20 ids por request
const ML_ATTRIBUTES    =       // campos que necesita slim_item + AUTHOR + enriched fields
  'id,title,price,status,available_quantity,thumbnail,pictures,permalink,start_time,attributes,condition';

// ─── Entrada pública ──────────────────────────────────────────────────────────

/**
 * Descarga el catálogo completo desde ML y devuelve el payload listo para R2.
 * @param {object} env         — Worker env (env.USER_ID, env.MIN_ACTIVE_ITEMS)
 * @param {string} accessToken — ML access token vigente
 * @returns {{ total, updated_at, items }}
 */
export async function buildCatalog(env, accessToken) {
  const userId         = env.USER_ID;
  const minActiveItems = parseInt(env.MIN_ACTIVE_ITEMS || '500', 10);

  console.log(`[Catalog] Iniciando fetch para seller ${userId}`);

  // Paso 1: obtener todos los IDs
  const allIds = await fetchAllIds(userId, accessToken);
  console.log(`[Catalog] IDs obtenidos: ${allIds.length}`);

  if (allIds.length === 0) {
    throw new Error('[Catalog] Scroll devolvió 0 IDs. Abortando para no vaciar R2.');
  }

  // Paso 2: obtener detalles en batches
  const rawItems = await fetchDetails(allIds, accessToken);
  console.log(`[Catalog] Detalles obtenidos: ${rawItems.length} de ${allIds.length}`);

  // Paso 3: slim + filtro activos
  const activeItems = [];
  for (const raw of rawItems) {
    if (raw.status === 'active') {
      activeItems.push(slimItem(raw));
    }
  }

  console.log(`[Catalog] Items activos: ${activeItems.length} | pausados/otros: ${rawItems.length - activeItems.length}`);

  // Guarda mínima: prevenir sobreescribir R2 con catálogo vacío o roto
  if (activeItems.length < minActiveItems) {
    throw new Error(
      `[Catalog] Solo ${activeItems.length} items activos — mínimo requerido: ${minActiveItems}. ` +
      `Abortando para preservar catalog.json en R2.`
    );
  }

  const updatedAt = new Date().toISOString();
  return {
    total:      activeItems.length,
    updated_at: updatedAt,
    items:      activeItems,
  };
}

// ─── Scroll de IDs ────────────────────────────────────────────────────────────

async function fetchAllIds(userId, accessToken) {
  const ids = [];
  let scrollId = null;
  let page     = 0;

  while (true) {
    page++;
    let url = `https://api.mercadolibre.com/users/${userId}/items/search?limit=100&search_type=scan`;
    if (scrollId) url += `&scroll_id=${encodeURIComponent(scrollId)}`;

    const data = await mlGet(url, accessToken);

    const batch = data.results || [];
    scrollId = data.scroll_id || null;
    ids.push(...batch);

    if (page === 1 || page % 20 === 0) {
      console.log(`[Catalog] Scroll pág ${page}: +${batch.length} IDs | total: ${ids.length} | scroll: ${scrollId ? 'sí' : 'FIN'}`);
    }

    // Fin del scroll: sin más resultados o sin cursor
    if (batch.length === 0 || !scrollId) break;

    await sleep(SCROLL_SLEEP_MS);
  }

  console.log(`[Catalog] Scroll completo: ${ids.length} IDs en ${page} páginas`);
  return ids;
}

// ─── Detalles en batch ───────────────────────────────────────────────────────

async function fetchDetails(ids, accessToken) {
  const items       = [];
  const totalBatches = Math.ceil(ids.length / DETAIL_BATCH);

  for (let i = 0; i < ids.length; i += DETAIL_BATCH) {
    const batch     = ids.slice(i, i + DETAIL_BATCH);
    const batchNum  = Math.floor(i / DETAIL_BATCH) + 1;
    const url       = `https://api.mercadolibre.com/items?ids=${batch.join(',')}&attributes=${ML_ATTRIBUTES}`;

    try {
      const data = await mlGet(url, accessToken);
      // data es un array de { code, body } o directamente el item
      const entries = Array.isArray(data) ? data : [data];
      for (const entry of entries) {
        const item = (entry.code === 200 && entry.body) ? entry.body : entry;
        if (item && item.id) items.push(item);
      }
    } catch (err) {
      // Error en un batch individual: loguear y continuar
      // Perder un batch de 20 items es preferible a abortar todo el sync
      console.error(`[Catalog] Error en batch ${batchNum}/${totalBatches} (offset ${i}): ${err.message}`);
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
 * Versión enriquecida: incluye pictures[], isbn, publisher, pages, dimensions, condition.
 */
function slimItem(raw) {
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
    isbn:               extractIsbn(attrs),
    publisher:          extractPublisher(attrs),
    pages:              extractPages(attrs),
    dimensions:         extractDimensions(attrs),
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

function extractDimensions(attrs) {
  const weight = getAttrValue(attrs, ['WEIGHT']);
  const height = getAttrValue(attrs, ['HEIGHT']);
  const width  = getAttrValue(attrs, ['WIDTH']);
  const length = getAttrValue(attrs, ['LENGTH', 'DEPTH']);
  if (!weight && !height && !width && !length) return null;
  return {
    ...(weight && { weight }),
    ...(height && { height }),
    ...(width  && { width  }),
    ...(length && { length }),
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
 * GET a la API de MercadoLibre con retry automático en 429.
 */
async function mlGet(url, accessToken, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });

    if (resp.status === 429) {
      // Rate limit: esperar 2 segundos antes de reintentar
      const delay = 2000 * (attempt + 1);
      console.warn(`[Catalog] Rate limit 429 en ${url.slice(0, 80)}. Esperando ${delay}ms.`);
      await sleep(delay);
      continue;
    }

    if (!resp.ok) {
      throw new Error(`[Catalog] HTTP ${resp.status} en ${url.slice(0, 100)}`);
    }

    return await resp.json();
  }

  throw new Error(`[Catalog] Agotados ${retries} reintentos por rate limit en ${url.slice(0, 100)}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
