import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as catalogRequest } from '../catalogo.js';
import { onRequest as bookRequest } from '../libro/[[path]].js';
import {
  CATALOG_URL,
  PAUSED_MANIFEST_URL,
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
      thumbnail: '', pictures: [], permalink: 'https://articulo.mercadolibre.com.uy/MLU1',
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

function context(url, params = {}, appEnv = 'preview') {
  return {
    request: new Request(url),
    params,
    env: {
      APP_ENV: appEnv,
      STOCK_WAITLIST_TURNSTILE_SITE_KEY: '0xpreview-test-sitekey',
    },
    waitUntil() {},
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

test('la búsqueda muestra pausados con acceso al aviso sin precio anterior', async () => {
  const response = await catalogRequest(
    context('https://preview.example/catalogo?q=Alpha+raro')
  );
  const html = await response.text();

  assert.match(html, /No disponible/);
  assert.match(html, /Avisame cuando llegue/);
  assert.match(html, /Buscarlo por encargo/);
  assert.match(html, /https:\/\/preview\.example\/libro\/MLU2\/alpha-raro/);
  assert.doesNotMatch(html, /98[.,]765/);
  assert.doesNotMatch(html, /Agregar al carrito/);
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
  assert.match(html, /Transferencia:/);
  assert.match(html, /Precio:/);
  assert.equal(requests.includes(CATALOG_URL), false);
});

test('una búsqueda sin coincidencias reales termina en cero resultados', async () => {
  const response = await catalogRequest(
    context('https://preview.example/catalogo?q=zzzinexistente999')
  );
  const html = await response.text();

  assert.match(html, /No encontramos resultados/);
  assert.doesNotMatch(html, /class="rc-card/);
});

test('la ficha pausada queda noindex, sin precio ni compra directa', async () => {
  const response = await bookRequest(
    context('https://www.amadolibros.com/libro/MLU2/alpha-raro', {
      path: ['MLU2', 'alpha-raro'],
    })
  );
  const html = await response.text();

  assert.match(html, /noindex, follow/);
  assert.match(html, /No disponible por el momento/);
  assert.match(html, /Avisame cuando llegue/);
  assert.match(html, /data-action="stock_waitlist"/);
  assert.match(html, /\/api\/stock-waitlist/);
  assert.match(html, /Buscarlo por encargo por WhatsApp/);
  assert.doesNotMatch(html, /98[.,]765/);
  assert.doesNotMatch(html, /Agregar al carrito/);
  assert.doesNotMatch(html, /Comprar en MercadoLibre/);
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
