import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as catalogRequest } from '../catalogo.js';
import { onRequest as bookRequest } from '../libro/[[path]].js';
import {
  CATALOG_URL,
  PAUSED_MANIFEST_URL,
  PRODUCTION_MANIFEST_URL,
  R2_BASE,
  pausedBlockNumberForId,
} from '../_shared/catalog.js';

const CATALOG = {
  total: 1,
  items: [
    {
      id: 'MLU1', title: 'Alpha disponible', author: 'Autora Uno',
      isbn: '9789991234567',
      price: 1000, status: 'active', available_quantity: 2,
      thumbnail: '', pictures: ['https://http2.mlstatic.com/D_TEST-O.jpg'],
      permalink: 'https://articulo.mercadolibre.com.uy/MLU1',
    },
  ],
};
const PAUSED = {
  id: 'MLU2', title: 'Alpha raro', author: 'Autor Dos',
  price: 98765, status: 'paused', available_quantity: 0,
  thumbnail: '', pictures: [], permalink: 'https://articulo.mercadolibre.com.uy/MLU2',
};
const VERSION = '20260730120000000';
const BLOCK = pausedBlockNumberForId(PAUSED.id, 128);
const PREFIX = `stock1-preview/versions/${VERSION}`;

function context(url, params = {}, appEnv = 'preview', envOverrides = {}) {
  return {
    request: new Request(url),
    params,
    env: {
      APP_ENV: appEnv,
      STOCK_WAITLIST_TURNSTILE_SITE_KEY: '0xpreview-test-sitekey',
      ...envOverrides,
    },
    waitUntil() {},
  };
}

const PREVIEW_COVER_HASH = 'a'.repeat(64);
const PREVIEW_COVER_MANIFEST = {
  schema_version: 1,
  updated_at: '2026-08-09T21:00:00.000Z',
  entries: {
    'MLU1:0': {
      product_id: 'MLU1',
      position: 0,
      current: {
        object_key: `covers/v1/objects/${PREVIEW_COVER_HASH}.jpg`,
        sha256: PREVIEW_COVER_HASH,
        mime: 'image/jpeg',
        source_url: 'https://http2.mlstatic.com/D_TEST-O.jpg',
      },
    },
  },
};

function previewCoverBucket() {
  return {
    async get(key) {
      if (key === 'covers/v1/manifest.json') {
        return { async text() { return JSON.stringify(PREVIEW_COVER_MANIFEST); } };
      }
      return null;
    },
  };
}

test.beforeEach(() => {
  globalThis.caches = {
    default: {
      async match(request) {
        if (request.url === CATALOG_URL) return Response.json(CATALOG);
        if (request.url === PAUSED_MANIFEST_URL) {
          return Response.json({
            schema_version: 1,
            current: {
              version: VERSION,
              index_key: `${PREFIX}/index.json`,
              active_index_key: `${PREFIX}/active-index.json`,
              block_prefix: PREFIX,
              block_count: 128,
            },
            previous: null,
          });
        }
        if (request.url === `${R2_BASE}/${PREFIX}/active-index.json`) {
          return Response.json({
            schema_version: 1,
            fields: [
              'id', 'title', 'author', 'isbn', 'image', 'price', 'available_quantity',
            ],
            derived_fields: {
              slug: 'slugify-v1',
              status: 'active',
            },
            items: [[
              CATALOG.items[0].id,
              CATALOG.items[0].title,
              CATALOG.items[0].author,
              CATALOG.items[0].isbn,
              '',
              CATALOG.items[0].price,
              CATALOG.items[0].available_quantity,
            ]],
          });
        }
        if (request.url === `${R2_BASE}/${PREFIX}/index.json`) {
          return Response.json({
            schema_version: 1,
            fields: ['id', 'title', 'author', 'isbn', 'image'],
            derived_fields: {
              slug: 'slugify-v1',
              status: 'paused',
              block: 'numeric-id-mod-block-count',
            },
            block_count: 128,
            items: [[PAUSED.id, PAUSED.title, PAUSED.author, '', '']],
          });
        }
        if (request.url === `${R2_BASE}/${PREFIX}/block-${String(BLOCK).padStart(3, '0')}.json`) {
          return Response.json({
            schema_version: 1,
            version: VERSION,
            block: BLOCK,
            items: [PAUSED],
          });
        }
        return null;
      },
      async put() {},
    },
  };
});

test('COVER-R2 Preview: card y ficha usan la copia validada del mismo origen', async () => {
  const env = { COVER_R2: previewCoverBucket() };
  const catalogResponse = await catalogRequest(
    context('https://preview.example/catalogo', {}, 'preview', env)
  );
  const catalogHtml = await catalogResponse.text();
  assert.match(
    catalogHtml,
    new RegExp(`/preview-cover/MLU1/0/${PREVIEW_COVER_HASH}\\.jpg`),
  );

  const bookResponse = await bookRequest(context(
    'https://preview.example/libro/MLU1/alpha-disponible',
    { path: ['MLU1', 'alpha-disponible'] },
    'preview',
    env,
  ));
  const bookHtml = await bookResponse.text();
  assert.match(
    bookHtml,
    new RegExp(`/preview-cover/MLU1/0/${PREVIEW_COVER_HASH}\\.jpg`),
  );
});

test('COVER-R2 Producción: card y ficha usan el binding productivo', async () => {
  const env = { COVER_R2: previewCoverBucket() };
  const catalogResponse = await catalogRequest(
    context('https://www.amadolibros.com/catalogo', {}, 'production', env)
  );
  const catalogHtml = await catalogResponse.text();
  assert.match(
    catalogHtml,
    new RegExp(`/preview-cover/MLU1/0/${PREVIEW_COVER_HASH}\\.jpg`),
  );

  const bookResponse = await bookRequest(context(
    'https://www.amadolibros.com/libro/MLU1/alpha-disponible',
    { path: ['MLU1', 'alpha-disponible'] },
    'production',
    env,
  ));
  const bookHtml = await bookResponse.text();
  assert.match(
    bookHtml,
    new RegExp(`/preview-cover/MLU1/0/${PREVIEW_COVER_HASH}\\.jpg`),
  );
});

test('COVER-R2 Preview: URL origen distinta mantiene mlstatic como fallback', async () => {
  const staleManifest = structuredClone(PREVIEW_COVER_MANIFEST);
  staleManifest.entries['MLU1:0'].current.source_url =
    'https://http2.mlstatic.com/D_OLD-O.jpg';
  const staleBucket = {
    async get(key) {
      if (key === 'covers/v1/manifest.json') {
        return { async text() { return JSON.stringify(staleManifest); } };
      }
      return null;
    },
  };
  const response = await catalogRequest(
    context('https://preview.example/catalogo', {}, 'preview', { COVER_R2: staleBucket })
  );
  const html = await response.text();
  assert.doesNotMatch(html, /\/preview-cover\/MLU1\/0\//);
  assert.match(html, /https:\/\/http2\.mlstatic\.com\/D_TEST-O\.jpg/);
});

// CF-CATEGORÍAS-2D: en Preview, un pausado ya no se muestra como "No
// disponible" (esa etiqueta queda para activos sin stock) — se muestra
// como "Disponible por encargo" con CTA "Pedir este libro" por WhatsApp,
// nunca con un precio no garantizado.
test('la búsqueda muestra pausados como "Disponible por encargo", sin precio anterior', async () => {
  const response = await catalogRequest(
    context('https://preview.example/catalogo?q=Alpha+raro')
  );
  const html = await response.text();

  assert.match(html, /Disponible por encargo/);
  assert.match(html, /Pedir este libro/);
  assert.match(html, /https:\/\/preview\.example\/libro\/MLU2\/alpha-raro/);
  assert.doesNotMatch(html, /98[.,]765/);
  assert.doesNotMatch(html, /Agregar al carrito/);
  assert.doesNotMatch(html, /Ver ficha/);
});

test('la búsqueda Preview usa el índice activo compacto y conserva el precio', async () => {
  const requests = [];
  const originalMatch = globalThis.caches.default.match;
  globalThis.caches.default.match = async request => {
    requests.push(request.url);
    return originalMatch(request);
  };

  const response = await catalogRequest(
    context('https://preview.example/catalogo?q=Alpha+disponible')
  );
  const html = await response.text();

  assert.match(html, /Alpha disponible/);
  assert.match(html, /12% menos por transferencia:/);
  assert.match(html, /Precio web\/tarjeta:/);
  assert.equal(requests.includes(CATALOG_URL), false);
  assert.match(response.headers.get('server-timing'), /active_index_parse/);
  assert.match(response.headers.get('server-timing'), /search;dur=/);
  assert.match(response.headers.get('server-timing'), /render;dur=/);
  assert.match(response.headers.get('server-timing'), /total;dur=/);
});

test('el catálogo prioriza precio web y cuotas antes que transferencia', async () => {
  const response = await catalogRequest(
    context('https://preview.example/catalogo?q=Alpha+disponible')
  );
  const html = await response.text();
  const prices = html.match(/<div class="rc-prices">([\s\S]*?)<\/div>/)?.[1] || '';

  assert.match(prices, /Precio web\/tarjeta:<\/span> \$1[.,]000 UYU/);
  assert.match(prices, /Hasta 12 cuotas de aprox\. \$83 UYU/);
  assert.match(prices, /🏷️<\/span> 12% menos por transferencia: \$880 UYU/);
  assert.ok(prices.indexOf('Precio web/tarjeta:') < prices.indexOf('Hasta 12 cuotas'));
  assert.ok(prices.indexOf('Hasta 12 cuotas') < prices.indexOf('12% menos por transferencia:'));
});

test('el catálogo marca con iconos el 12% y el envío gratis sólo desde el umbral', async () => {
  const paidResponse = await catalogRequest(
    context('https://preview.example/catalogo?q=Alpha')
  );
  const paidHtml = await paidResponse.text();
  assert.match(paidHtml, /🏷️<\/span> 12% menos por transferencia/);
  assert.doesNotMatch(paidHtml, /🚚<\/span> Envío gratis/);

  const originalPrice = CATALOG.items[0].price;
  CATALOG.items[0].price = 1500;
  try {
    const freeResponse = await catalogRequest(
      context('https://preview.example/catalogo?q=Alpha')
    );
    const freeHtml = await freeResponse.text();
    assert.match(freeHtml, /🚚<\/span> Envío gratis/);
  } finally {
    CATALOG.items[0].price = originalPrice;
  }
});

test('el precio principal del catálogo tiene más fuerza visual que transferencia', async () => {
  const response = await catalogRequest(
    context('https://preview.example/catalogo?q=Alpha+disponible')
  );
  const html = await response.text();

  assert.match(html, /\.rc-base\{font-size:\.95rem[^}]*font-weight:700\}/);
  assert.match(html, /\.rc-transfer\{font-size:\.78rem[^}]*font-weight:600\}/);
});

test('una búsqueda sin coincidencias reales termina en cero resultados', async () => {
  const response = await catalogRequest(
    context('https://preview.example/catalogo?q=zzzinexistente999')
  );
  const html = await response.text();

  assert.match(html, /No encontramos resultados/);
  assert.doesNotMatch(html, /class="rc-card/);
  assert.match(html, /Que no aparezca acá no significa que no podamos encontrarlo/);
  assert.match(html, /href="\/pedir-libro\?tipo=sin-resultados&amp;q=zzzinexistente999"/);
  assert.match(html, />Pedir que lo busquemos</);
  assert.match(html, />Ir directo a WhatsApp</);
});

test('el catálogo indexable comunica el umbral real de envío gratis', async () => {
  const response = await catalogRequest(
    context('https://preview.example/catalogo')
  );
  const html = await response.text();
  const description = html.match(/<meta name="description" content="([^"]+)">/)?.[1] || '';

  assert.match(description, /envío gratis desde \$1\.500/);
  assert.doesNotMatch(description, /envío gratis desde \$2\.000/);
});

test('la ficha pausada queda noindex, sin precio ni compra directa', async () => {
  const response = await bookRequest(
    context('https://www.amadolibros.com/libro/MLU2/alpha-raro', {
      path: ['MLU2', 'alpha-raro'],
    })
  );
  const html = await response.text();

  assert.match(html, /noindex, follow/);
  assert.match(html, /¿Buscás este libro\?/);
  assert.match(html, /Podemos intentar conseguirlo por encargo\./);
  assert.match(html, /Consultar si podemos conseguirlo/);
  assert.match(html, /Avisame cuando llegue/);
  assert.match(html, /data-action="stock_waitlist"/);
  assert.match(html, /\/api\/stock-waitlist/);
  assert.doesNotMatch(html, /98[.,]765/);
  assert.doesNotMatch(html, /Agregar al carrito/);
  assert.doesNotMatch(html, /Comprar en MercadoLibre/);
  // CF-STOCK-1-UX-FIX: no repetir el problema — sin badge "No disponible"
  // ni fila "Disponibilidad" en la ficha técnica.
  assert.doesNotMatch(html, /No disponible/);
  assert.doesNotMatch(html, /<dt>Disponibilidad<\/dt>/);
  // Jerarquía: el WhatsApp principal debe aparecer antes que el
  // formulario de aviso secundario.
  assert.ok(html.indexOf('Consultar si podemos conseguirlo') < html.indexOf('id="aviso-stock"'));

  const expectedWaMsg = encodeURIComponent(
    'Hola, me interesa conseguir “Alpha raro”, de Autor Dos. ¿Podrían buscarlo por encargo?'
  );
  assert.ok(html.includes(`https://wa.me/59899841325?text=${expectedWaMsg}`));
});

test('CF-R2-2C: schema Book de una ficha pausada no incluye Offer', async () => {
  const response = await bookRequest(
    context('https://www.amadolibros.com/libro/MLU2/alpha-raro', {
      path: ['MLU2', 'alpha-raro'],
    })
  );
  const html = await response.text();
  const match = html.match(/<script type="application\/ld\+json">(\{"@context":"https:\/\/schema\.org","@type":\["Product","Book"\].*?)<\/script>/);
  assert.ok(match, 'no se encontró el JSON-LD de Product/Book');
  const schema = JSON.parse(match[1]);
  assert.equal(schema.offers, undefined);
  assert.equal(schema.sku, 'MLU2');
});

test('la ficha activa conserva precio y carrito en producción', async () => {
  const response = await bookRequest(
    context('https://www.amadolibros.com/libro/MLU1/alpha-disponible', {
      path: ['MLU1', 'alpha-disponible'],
    }, 'production')
  );
  const html = await response.text();

  assert.match(html, /index, follow/);
  assert.match(html, /Agregar al carrito/);
  assert.match(html, /Transferencia:/);
});

test('la ficha sin slug redirige dentro del mismo Preview', async () => {
  const response = await bookRequest(
    context('https://preview.example/libro/MLU2', {
      path: ['MLU2'],
    })
  );

  assert.equal(response.status, 301);
  assert.equal(response.headers.get('location'), 'https://preview.example/libro/MLU2/alpha-raro');
});

test('CF-R2-2B: una URL histórica con slug viejo resuelve por ID y redirige al slug canónico actual', async () => {
  // Si el título cambió después de que una URL histórica quedara indexada,
  // la entidad sigue resolviéndose por MLU. La variante vieja no da 404 ni
  // sirve un 200 duplicado: consolida en un solo salto a la URL canónica.
  const response = await bookRequest(
    context('https://www.amadolibros.com/libro/MLU2/titulo-historico-que-ya-no-existe', {
      path: ['MLU2', 'titulo-historico-que-ya-no-existe'],
    })
  );

  assert.equal(response.status, 301);
  assert.equal(
    response.headers.get('location'),
    'https://www.amadolibros.com/libro/MLU2/alpha-raro',
  );
});

test('CF-R2-2B: el mismo MLU nunca da 404 solo por pasar de activo a pausado', async () => {
  // MLU1 existe como activo en CATALOG; MLU2 existe como pausado en el
  // índice separado. Ambos deben resolver 200 por el mismo mecanismo de
  // búsqueda por ID — el estado (activo/pausado) no es motivo de 404.
  const activeResponse = await bookRequest(
    context('https://www.amadolibros.com/libro/MLU1/alpha-disponible', {
      path: ['MLU1', 'alpha-disponible'],
    })
  );
  const pausedResponse = await bookRequest(
    context('https://www.amadolibros.com/libro/MLU2/alpha-raro', {
      path: ['MLU2', 'alpha-raro'],
    })
  );

  assert.equal(activeResponse.status, 200);
  assert.equal(pausedResponse.status, 200);
});

// ── CF-R2-2-BRIDGE: catálogo pausado en producción ───────────────────────────

const PROD_VERSION = '20260801090000000';
const PROD_PREFIX = `catalog/versions/${PROD_VERSION}`;
const PROD_ACTIVE = {
  id: 'MLU10', title: 'Beta productivo', author: 'Autora Prod',
  isbn: '9789990001112',
  price: 1500, status: 'active', available_quantity: 3,
  thumbnail: '', pictures: [], permalink: 'https://articulo.mercadolibre.com.uy/MLU10',
};
const PROD_PAUSED = {
  id: 'MLU11', title: 'Gamma pausado productivo', author: 'Autor Prod Dos',
  price: 50000, status: 'paused', available_quantity: 0,
  thumbnail: '', pictures: [], permalink: 'https://articulo.mercadolibre.com.uy/MLU11',
};
const PROD_BLOCK = pausedBlockNumberForId(PROD_PAUSED.id, 128);

function installProductionCatalogMock() {
  const requestedUrls = [];
  globalThis.caches = {
    default: {
      async match(request) {
        requestedUrls.push(request.url);
        if (request.url === CATALOG_URL) {
          return Response.json({ total: 1, items: [PROD_ACTIVE] });
        }
        if (request.url === PRODUCTION_MANIFEST_URL) {
          return Response.json({
            schema_version: 1,
            current: {
              version: PROD_VERSION,
              index_key: `${PROD_PREFIX}/index.json`,
              active_index_key: `${PROD_PREFIX}/active-index.json`,
              block_prefix: PROD_PREFIX,
              block_count: 128,
            },
            previous: null,
          });
        }
        if (request.url === PAUSED_MANIFEST_URL) {
          // Nunca debería pedirse en producción — si esto se sirve, algo
          // está mal (el test que lo detecta corre por separado).
          return null;
        }
        if (request.url === `${R2_BASE}/${PROD_PREFIX}/active-index.json`) {
          return Response.json({
            schema_version: 1,
            fields: ['id', 'title', 'author', 'isbn', 'image', 'price', 'available_quantity'],
            derived_fields: { slug: 'slugify-v1', status: 'active' },
            items: [[
              PROD_ACTIVE.id, PROD_ACTIVE.title, PROD_ACTIVE.author, PROD_ACTIVE.isbn,
              '', PROD_ACTIVE.price, PROD_ACTIVE.available_quantity,
            ]],
          });
        }
        if (request.url === `${R2_BASE}/${PROD_PREFIX}/index.json`) {
          return Response.json({
            schema_version: 1,
            fields: ['id', 'title', 'author', 'isbn', 'image'],
            derived_fields: {
              slug: 'slugify-v1',
              status: 'paused',
              block: 'numeric-id-mod-block-count',
            },
            block_count: 128,
            items: [[PROD_PAUSED.id, PROD_PAUSED.title, PROD_PAUSED.author, '', '']],
          });
        }
        if (request.url === `${R2_BASE}/${PROD_PREFIX}/block-${String(PROD_BLOCK).padStart(3, '0')}.json`) {
          return Response.json({
            schema_version: 1,
            version: PROD_VERSION,
            block: PROD_BLOCK,
            items: [PROD_PAUSED],
          });
        }
        return null;
      },
      async put() {},
    },
  };
  return requestedUrls;
}

test('CF-R2-2-BRIDGE: búsqueda productiva encuentra un libro pausado', async () => {
  const requestedUrls = installProductionCatalogMock();
  const response = await catalogRequest(
    context('https://www.amadolibros.com/catalogo?q=Gamma+pausado', {}, 'production')
  );
  const html = await response.text();

  assert.match(html, /Gamma pausado productivo/);
  assert.doesNotMatch(html, /Agregar al carrito/);
  assert.equal(requestedUrls.includes(PAUSED_MANIFEST_URL), false);
});

test('CF-R2-2-BRIDGE: ficha productiva por ID encuentra un libro pausado', async () => {
  const requestedUrls = installProductionCatalogMock();
  const response = await bookRequest(
    context('https://www.amadolibros.com/libro/MLU11/gamma-pausado-productivo', {
      path: ['MLU11', 'gamma-pausado-productivo'],
    }, 'production')
  );

  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /noindex, follow/);
  assert.match(html, /¿Buscás este libro\?/);
  assert.doesNotMatch(html, /Agregar al carrito/);
  assert.doesNotMatch(html, /Comprar en MercadoLibre/);
  assert.equal(requestedUrls.includes(PAUSED_MANIFEST_URL), false);
});

test('CF-R2-2-BRIDGE: ficha productiva de un activo sigue funcionando normalmente', async () => {
  const requestedUrls = installProductionCatalogMock();
  const response = await bookRequest(
    context('https://www.amadolibros.com/libro/MLU10/beta-productivo', {
      path: ['MLU10', 'beta-productivo'],
    }, 'production')
  );

  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /index, follow/);
  assert.match(html, /Agregar al carrito/);
  assert.match(html, /Transferencia:/);
  assert.equal(requestedUrls.includes(PAUSED_MANIFEST_URL), false);
});
