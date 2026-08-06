import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as catalogRequest } from '../catalogo.js';
import { CATALOG_URL } from '../_shared/catalog.js';

const catalog = {
  total: 100,
  items: Array.from({ length: 100 }, (_, index) => {
    const number = index + 1;
    return {
      id: `MLU${String(number).padStart(4, '0')}`,
      title: `Libro integrado ${number}`,
      author: `Autor ${number}`,
      isbn: `978000000${String(number).padStart(4, '0')}`,
      price: 1500 + number,
      status: 'active',
      available_quantity: 1,
      thumbnail: `http://http2.mlstatic.com/libro-${number}-I.jpg`,
      pictures: [],
    };
  }),
};

function context() {
  return {
    request: new Request('https://preview.example/catalogo?page=2'),
    params: {},
    env: { APP_ENV: 'test' },
    waitUntil() {},
  };
}

test.beforeEach(() => {
  globalThis.caches = {
    default: {
      async match(request) {
        if (request.url === CATALOG_URL) return Response.json(catalog);
        return null;
      },
      async put() {},
    },
  };
});

test('integración comercial: página 2 conserva paginación, portadas nítidas y layout móvil estable', async () => {
  const response = await catalogRequest(context());
  const html = await response.text();
  const imageTags = html.match(/<img\b[^>]*>/g) || [];

  assert.equal(response.status, 200);
  assert.match(html, /Mostrando 49–96 de 100 resultados\./);
  assert.match(html, /<nav class="pg" aria-label="Paginación de resultados">/);
  assert.match(html, /<span class="pg-status">Página 2 de 3<\/span>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/www\.amadolibros\.com\/catalogo\?page=2">/);

  assert.equal(imageTags.length, 48);
  assert.equal(imageTags.filter(tag => /loading="eager"/.test(tag)).length, 4);
  assert.equal(imageTags.filter(tag => /loading="lazy"/.test(tag)).length, 44);
  assert.equal(imageTags.filter(tag => /fetchpriority="high"/.test(tag)).length, 1);
  assert.doesNotMatch(html, /-I\.jpg/);
  assert.match(html, /libro-49-O\.jpg/);
  assert.match(html, /<link rel="preconnect" href="https:\/\/http2\.mlstatic\.com" crossorigin>/);

  assert.match(html, /html,body\{max-width:100%;overflow-x:hidden\}/);
  assert.match(html, /@media\(max-width:499px\)\{/);
  assert.match(html, /\.rc-card\{display:grid;grid-template-columns:minmax\(108px,34%\) minmax\(0,1fr\)\}/);
  assert.match(html, /\.pg-ctl,\.pg-num,\.pg-gap\{min-width:44px;min-height:44px;/);
});
