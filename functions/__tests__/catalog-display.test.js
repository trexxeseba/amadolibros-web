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

function context(url, params = {}) {
  return {
    request: new Request(url),
    params,
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

test('la búsqueda muestra pausados como encargo sin precio anterior', async () => {
  const response = await catalogRequest(
    context('https://preview.example/catalogo?q=Alpha+raro')
  );
  const html = await response.text();

  assert.match(html, /Por encargo/);
  assert.match(html, /Entrega estimada: 15–20 días/);
  assert.match(html, /Consultar disponibilidad/);
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
  assert.match(html, /Entrega estimada: 15–20 días/);
  assert.match(html, /Consultar disponibilidad/);
  assert.doesNotMatch(html, /98[.,]765/);
  assert.doesNotMatch(html, /Agregar al carrito/);
  assert.doesNotMatch(html, /Comprar en MercadoLibre/);
});

test('la ficha activa conserva precio y carrito en producción', async () => {
  const response = await bookRequest(
    context('https://www.amadolibros.com/libro/MLU1/alpha-disponible', {
      path: ['MLU1', 'alpha-disponible'],
    })
  );
  const html = await response.text();

  assert.match(html, /index, follow/);
  assert.match(html, /Agregar al carrito/);
  assert.match(html, /Precio web \/ tarjeta:<\/span> \$1[.,]000 UYU/);
  assert.match(html, /Transferencia: \$880 UYU · ahorrás 12%/);
  assert.ok(
    html.indexOf('Precio web / tarjeta:') < html.indexOf('Transferencia:'),
    'el precio cobrable debe aparecer antes que el beneficio por transferencia'
  );
  assert.match(html, /"price":"1000"/);
  assert.match(html, /data-price="1000"/);
});

test('el catálogo muestra primero el mismo precio base que usa la compra', async () => {
  const response = await catalogRequest(
    context('https://www.amadolibros.com/catalogo?q=Alpha+disponible')
  );
  const html = await response.text();

  assert.match(html, /Precio web \/ tarjeta:<\/span> \$1[.,]000/);
  assert.match(html, /Transferencia: \$880 · ahorrás 12%/);
  assert.ok(
    html.indexOf('Precio web / tarjeta:') < html.indexOf('Transferencia:'),
    'el catálogo debe priorizar el precio web'
  );
});
