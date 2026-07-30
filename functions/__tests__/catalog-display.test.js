import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as catalogRequest } from '../catalogo.js';
import { onRequest as bookRequest } from '../libro/[[path]].js';

const CATALOG = {
  total: 2,
  items: [
    {
      id: 'MLU1', title: 'Alpha disponible', author: 'Autora Uno',
      isbn: '9789991234567',
      price: 1000, status: 'active', available_quantity: 2,
      thumbnail: '', pictures: [], permalink: 'https://articulo.mercadolibre.com.uy/MLU1',
    },
    {
      id: 'MLU2', title: 'Alpha raro', author: 'Autor Dos',
      price: 98765, status: 'paused', available_quantity: 0,
      thumbnail: '', pictures: [], permalink: 'https://articulo.mercadolibre.com.uy/MLU2',
    },
  ],
};

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
      async match() {
        return Response.json(CATALOG);
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
