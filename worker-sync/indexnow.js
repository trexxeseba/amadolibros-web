/**
 * Notificación selectiva a IndexNow después de publicar el catálogo.
 *
 * Solo se envían URLs indexables que cambiaron de verdad. Las categorías y el
 * catálogo se incluyen tras cada publicación porque su inventario visible sí
 * cambia aunque no cambie su propia ruta.
 */

export const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';
export const INDEXNOW_MAX_URLS = 10_000;
export const INDEXNOW_CATEGORY_PATHS = Object.freeze([
  '/libros/infantil-juvenil',
  '/libros/esoterismo-tarot',
  '/libros/medicina-salud',
  '/libros/literatura-ficcion',
  '/libros/idiomas-aprendizaje',
  '/libros/psicologia',
  '/libros/desarrollo-personal',
  '/libros/religion-espiritualidad',
]);

const INDEXNOW_KEY_PATTERN = /^[A-Za-z0-9-]{8,128}$/;

function slugify(text) {
  return (text || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 60);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value ?? null;
  return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, stableValue(value[key])]),
  );
}

function itemSignature(item) {
  return JSON.stringify(stableValue({
    title: item?.title,
    author: item?.author,
    price: item?.price,
    status: item?.status,
    available_quantity: item?.available_quantity,
    condition: item?.condition,
    isbn: item?.isbn,
    publisher: item?.publisher,
    pages: item?.pages,
    description: item?.description,
    pictures: item?.pictures,
    bibliographic: item?.bibliographic,
    dimensions: item?.dimensions,
  }));
}

function isIndexableProduct(item) {
  return Boolean(
    item?.id && item?.title && item.status === 'active' && Number(item.available_quantity) > 0,
  );
}

function canonicalOrigin(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.hostname !== 'www.amadolibros.com') return null;
    return 'https://www.amadolibros.com';
  } catch {
    return null;
  }
}

export async function readPreviousPublicCatalog(env) {
  try {
    if (!env?.CATALOG_R2 || typeof env.CATALOG_R2.get !== 'function') return null;
    const object = await env.CATALOG_R2.get('catalog.json');
    if (!object) return null;
    const parsed = JSON.parse(await object.text());
    return Array.isArray(parsed?.items) ? parsed : null;
  } catch (error) {
    console.warn(`[IndexNow] Baseline anterior no disponible: ${error?.message || 'Error'}`);
    return null;
  }
}

export function buildIndexNowChangeSet(previousCatalog, nextCatalog, originValue) {
  const origin = canonicalOrigin(originValue);
  if (!origin) throw new Error('CANONICAL_ORIGIN inválido para IndexNow.');

  const evergreenUrls = [
    `${origin}/catalogo`,
    ...INDEXNOW_CATEGORY_PATHS.map(path => `${origin}${path}`),
  ];
  const previousItems = Array.isArray(previousCatalog?.items) ? previousCatalog.items : null;
  const nextItems = Array.isArray(nextCatalog?.items) ? nextCatalog.items : [];
  const previousById = previousItems
    ? new Map(previousItems.filter(item => item?.id).map(item => [String(item.id), item]))
    : null;
  const changedProducts = [];

  // Sin baseline no se finge que todo el catálogo es nuevo. La próxima corrida
  // ya podrá comparar contra el catalog.json publicado en esta ejecución.
  if (previousById) {
    for (const item of nextItems) {
      if (!isIndexableProduct(item)) continue;
      const previous = previousById.get(String(item.id));
      if (!previous || !isIndexableProduct(previous) || itemSignature(previous) !== itemSignature(item)) {
        changedProducts.push(
          `${origin}/libro/${encodeURIComponent(item.id)}/${slugify(item.title)}`,
        );
      }
    }
  }

  const urlList = [...new Set([...changedProducts, ...evergreenUrls])]
    .slice(0, INDEXNOW_MAX_URLS);
  return {
    urlList,
    changed_products: changedProducts.length,
    evergreen_urls: evergreenUrls.length,
    baseline_available: Boolean(previousById),
    truncated: changedProducts.length + evergreenUrls.length > INDEXNOW_MAX_URLS,
  };
}

export async function submitIndexNow(env, previousCatalog, nextCatalog, {
  fetchFn = fetch,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  timeoutMs = 10_000,
} = {}) {
  if (String(env?.INDEXNOW_ENABLED) !== 'true') {
    return { status: 'skipped', reason: 'disabled' };
  }
  const key = String(env?.INDEXNOW_KEY || '');
  const origin = canonicalOrigin(env?.CANONICAL_ORIGIN);
  if (!INDEXNOW_KEY_PATTERN.test(key) || !origin) {
    return { status: 'skipped', reason: 'invalid-config' };
  }

  const changes = buildIndexNowChangeSet(previousCatalog, nextCatalog, origin);
  const controller = new AbortController();
  const timer = setTimeoutFn(() => controller.abort(), Math.min(Math.max(timeoutMs, 1), 10_000));
  try {
    const response = await fetchFn(INDEXNOW_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        host: 'www.amadolibros.com',
        key,
        keyLocation: `${origin}/${key}.txt`,
        urlList: changes.urlList,
      }),
      signal: controller.signal,
    });
    if (![200, 202].includes(response.status)) {
      return { status: 'error', http_status: response.status, ...changes };
    }
    return { status: 'sent', http_status: response.status, submitted: changes.urlList.length, ...changes };
  } catch (error) {
    return {
      status: 'error',
      reason: error?.name === 'AbortError' ? 'timeout' : 'network-error',
      ...changes,
    };
  } finally {
    clearTimeoutFn(timer);
  }
}
