// OPS-CATALOG-DEGRADATION-1 (issue #85) — /catalogo nunca debe responder
// HTTP 200 con una grilla vacía o comercialmente falsa cuando la fuente
// activa que esa vista necesita está temporalmente indisponible. Tampoco
// debe convertir esa falla temporal en 404/410: la URL sigue siendo válida,
// el problema es de origen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as catalogRequest } from '../catalogo.js';
import { CATALOG_URL, PAUSED_MANIFEST_URL, PRODUCTION_MANIFEST_URL, R2_BASE } from '../_shared/catalog.js';

const BASE_URL = 'https://www.amadolibros.com/catalogo';

const VALID_CATALOG = {
  total: 2,
  items: [
    {
      id: 'MLU0001', title: 'Libro disponible', author: 'Autora Uno',
      isbn: '9780000000001', price: 1000, status: 'active', available_quantity: 3,
      thumbnail: '', pictures: [], permalink: 'https://x/MLU0001',
    },
    {
      id: 'MLU0002', title: 'Otro libro disponible', author: 'Autor Dos',
      isbn: '9780000000002', price: 1200, status: 'active', available_quantity: 1,
      thumbnail: '', pictures: [], permalink: 'https://x/MLU0002',
    },
  ],
};

const ACTIVE_MANIFEST_CURRENT = {
  version: 'v1',
  index_key: 'stock1-preview/index.json',
  active_index_key: 'stock1-preview/active-index.json',
  block_prefix: 'stock1-preview/blocks',
  block_count: 1,
};

const VALID_ACTIVE_INDEX = {
  schema_version: 1,
  fields: ['id', 'title', 'author', 'isbn', 'image', 'price', 'available_quantity'],
  derived_fields: { slug: 'slugify-v1', status: 'active' },
  items: [
    ['MLU0009', 'Libro del índice compacto', 'Autora Compacta', '9780000000009', '', 1500, 2],
  ],
};

function context(url, appEnv = 'test') {
  return {
    request: new Request(url),
    params: {},
    env: { APP_ENV: appEnv },
    waitUntil() {},
  };
}

// Instala un mock de `caches.default` donde cada URL listada en `hits`
// responde con ese valor (cache HIT) y todo lo demás es un cache MISS —
// el fallback a `fetch` real de _shared/catalog.js entonces decide.
function installCacheHits(hits) {
  globalThis.caches = {
    default: {
      async match(request) {
        const entry = hits[request.url];
        return entry === undefined ? null : Response.json(entry);
      },
      async put() {},
    },
  };
}

async function render(url, appEnv = 'test') {
  const response = await catalogRequest(context(url, appEnv));
  const html = response.status === 200 || response.status === 503
    ? await response.text()
    : '';
  return { response, html };
}

test.afterEach(() => {
  delete globalThis.fetch;
});

// ── 1. catalog.json caído en /catalogo limpio → 503 ─────────────────────────

test('1. /catalogo limpio: catalog.json responde error de red → 503, no-store, noindex', async () => {
  installCacheHits({}); // todo cache MISS
  globalThis.fetch = async () => new Response('bad gateway', { status: 502 });
  const { response, html } = await render(BASE_URL);

  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(html, /catálogo está actualizándose/);
});

test('1b. /catalogo limpio: el fetch de catalog.json lanza una excepción real (origen inalcanzable) → 503, no crashea', async () => {
  installCacheHits({});
  globalThis.fetch = async () => { throw new Error('network down'); };
  const { response } = await render(BASE_URL);
  assert.equal(response.status, 503);
});

// ── 2. catálogo con estructura inválida → 503 ───────────────────────────────

test('2. /catalogo limpio: catalog.json responde 200 pero sin items[] → 503', async () => {
  installCacheHits({});
  globalThis.fetch = async () => Response.json({ total: 0 }); // sin `items`
  const { response } = await render(BASE_URL);
  assert.equal(response.status, 503);
});

test('2b. /catalogo limpio: catalog.json responde JSON no parseable → 503', async () => {
  installCacheHits({});
  globalThis.fetch = async () => new Response('esto no es JSON', { status: 200 });
  const { response } = await render(BASE_URL);
  assert.equal(response.status, 503);
});

test('2c. /catalogo limpio: items no es array → 503', async () => {
  installCacheHits({});
  globalThis.fetch = async () => Response.json({ total: 3, items: 'no-es-array' });
  const { response } = await render(BASE_URL);
  assert.equal(response.status, 503);
});

// ── 3. filtro que depende del catálogo completo → misma política 503 ───────

test('3. filtro por categoría (sin q) también depende del catálogo completo → 503 si falla', async () => {
  installCacheHits({
    [PRODUCTION_MANIFEST_URL]: { current: null, previous: null },
  });
  globalThis.fetch = async url => {
    if (String(url) === CATALOG_URL) return new Response('down', { status: 503 });
    return new Response('not found', { status: 404 });
  };
  const { response } = await render(`${BASE_URL}?categoria=filosofia-ciencias-sociales`, 'production');
  assert.equal(response.status, 503);
});

test('3b. búsqueda con ?q en entorno sin índice compacto (test/dev) también depende del catálogo completo → 503', async () => {
  installCacheHits({});
  globalThis.fetch = async () => new Response('down', { status: 503 });
  // appEnv por defecto ('test') nunca activa useCompactSearch — cae siempre
  // a fetchCatalog(), igual que antes de este cambio.
  const { response } = await render(`${BASE_URL}?q=cualquiera`);
  assert.equal(response.status, 503);
});

test('3c. ?q en preview/producción con índice activo compacto caído también cae al catálogo completo → 503 si ese también falla', async () => {
  installCacheHits({
    [PAUSED_MANIFEST_URL]: { current: null, previous: null }, // manifest inválido -> activeIndex null
  });
  globalThis.fetch = async url => {
    if (String(url) === CATALOG_URL) return new Response('down', { status: 502 });
    return new Response('not found', { status: 404 });
  };
  const { response } = await render(`${BASE_URL}?q=murdoku`, 'preview');
  assert.equal(response.status, 503);
});

// ── 4. búsqueda resuelta por completo con el índice compacto sigue 200 ─────

test('4. índice activo compacto válido resuelve la búsqueda sin necesitar catalog.json (que ni se llega a pedir)', async () => {
  installCacheHits({
    [PAUSED_MANIFEST_URL]: { schema_version: 1, current: ACTIVE_MANIFEST_CURRENT, previous: null },
    [`${R2_BASE}/${ACTIVE_MANIFEST_CURRENT.active_index_key}`]: VALID_ACTIVE_INDEX,
  });
  const requestedUrls = [];
  globalThis.fetch = async url => {
    requestedUrls.push(String(url));
    // Si el código igual intentara pedir catalog.json completo, esto
    // fallaría — probando que la búsqueda compacta lo evita del todo.
    if (String(url) === CATALOG_URL) return new Response('no debería pedirse', { status: 500 });
    return new Response('not found', { status: 404 });
  };
  const { response, html } = await render(`${BASE_URL}?q=compacto`, 'preview');

  assert.equal(response.status, 200);
  assert.match(html, /MLU0009/);
  assert.equal(requestedUrls.includes(CATALOG_URL), false, 'catalog.json no debía pedirse');
});

// ── 5. cero coincidencias legítimas sigue 200 ───────────────────────────────

test('5. catalog.json válido pero sin coincidencias para la búsqueda → 200 con cero resultados', async () => {
  installCacheHits({ [CATALOG_URL]: VALID_CATALOG });
  const { response, html } = await render(`${BASE_URL}?q=zzzqqxyw999nadaquever`);
  assert.equal(response.status, 200);
  assert.match(html, /No encontramos resultados\./);
});

test('5b. catalog.json válido y sin filtros con catálogo realmente vacío → 200, no 503', async () => {
  installCacheHits({ [CATALOG_URL]: { total: 0, items: [] } });
  const { response, html } = await render(BASE_URL);
  assert.equal(response.status, 200, 'una fuente válida con cero libros no es una falla');
  assert.match(html, /No encontramos resultados\./);
});

// ── 6. un fallo temporal jamás se convierte en 404 o 410 ───────────────────

test('6. catalog.json caído con ?page=5 nunca degrada a 404 (totalPages=0 no debe leerse antes del 503)', async () => {
  installCacheHits({});
  globalThis.fetch = async () => new Response('down', { status: 502 });
  const { response } = await render(`${BASE_URL}?page=5`);
  assert.equal(response.status, 503);
  assert.notEqual(response.status, 404);
});

test('6b. catalog.json caído con categoría + página fuera de rango tampoco degrada a 404', async () => {
  installCacheHits({
    [PRODUCTION_MANIFEST_URL]: { current: null, previous: null },
  });
  globalThis.fetch = async () => new Response('down', { status: 502 });
  const { response } = await render(`${BASE_URL}?categoria=cualquiera&page=9`, 'production');
  assert.equal(response.status, 503);
});

// ── 7. Cache-Control: no-store en todo 503 ──────────────────────────────────

test('7. cualquier 503 de /catalogo lleva Cache-Control: no-store', async () => {
  installCacheHits({});
  globalThis.fetch = async () => Response.json({ total: 0 });
  const { response } = await render(BASE_URL);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
