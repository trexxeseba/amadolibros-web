import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as catalogRequest, catalogImageUrl } from '../catalogo.js';
import {
  PAUSED_MANIFEST_URL,
  R2_BASE,
} from '../_shared/catalog.js';

const VERSION = '20260805120000000';
const PREFIX = `stock1-preview/versions/${VERSION}`;

function context(url) {
  return {
    request: new Request(url),
    env: { APP_ENV: 'preview' },
    waitUntil() {},
  };
}

test.beforeEach(() => {
  const activeRows = Array.from({ length: 7 }, (_, index) => [
    `MLU${index + 1}`,
    `Imagen ${index + 1}`,
    'Autora',
    `978000000000${index}`,
    index === 0
      ? 'http://http2.mlstatic.com/portada-1-I.jpg'
      : index === 6
        ? ''
        : `https://http2.mlstatic.com/portada-${index + 1}-O.jpg`,
    1000 + index,
    1,
  ]);

  globalThis.caches = {
    default: {
      async match(request) {
        if (request.url === 'https://preview.example/data/active-categories.json') {
          return Response.json({ categories: [], items: {} });
        }
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
            derived_fields: { slug: 'slugify-v1', status: 'active' },
            items: activeRows,
          });
        }
        if (request.url === `${R2_BASE}/${PREFIX}/index.json`) {
          return Response.json({
            schema_version: 1,
            fields: ['id', 'title', 'author', 'isbn', 'image'],
            derived_fields: {
              slug: 'slugify-v1', status: 'paused', block: 'numeric-id-mod-block-count',
            },
            block_count: 128,
            items: [],
          });
        }
        return null;
      },
      async put() {},
    },
  };
});

test('normaliza solamente protocolo http y sufijo final -I.jpg', () => {
  assert.equal(
    catalogImageUrl('http://http2.mlstatic.com/portada-I.jpg'),
    'https://http2.mlstatic.com/portada-O.jpg',
  );
  assert.equal(
    catalogImageUrl('https://example.com/portada.webp'),
    'https://example.com/portada.webp',
  );
  assert.equal(
    catalogImageUrl('https://example.com/I.jpg?size=small'),
    'https://example.com/I.jpg?size=small',
  );
  assert.equal(catalogImageUrl(), '');
});

test('el catálogo compacto entrega portadas nítidas con prioridad de carga acotada', async () => {
  const response = await catalogRequest(
    context('https://preview.example/catalogo?q=Imagen'),
  );
  const html = await response.text();
  const imageTags = html.match(/<img\b[^>]*>/g) || [];

  assert.equal(imageTags.length, 6);
  assert.equal(imageTags.filter(tag => /loading="eager"/.test(tag)).length, 4);
  assert.equal(imageTags.filter(tag => /loading="lazy"/.test(tag)).length, 2);
  assert.equal(imageTags.filter(tag => /fetchpriority="high"/.test(tag)).length, 1);
  assert.match(imageTags[0], /portada-1-O\.jpg/);
  assert.match(imageTags[0], /width="180" height="240"/);
  assert.doesNotMatch(html, /-I\.jpg/);
  assert.doesNotMatch(html, /-V\.jpg/);
  assert.match(html, /class="rc-no-img"/);
  assert.match(html, /object-fit:contain/);
  assert.match(
    html,
    /<link rel="preconnect" href="https:\/\/http2\.mlstatic\.com" crossorigin>/,
  );
  assert.doesNotMatch(html, /srcset=/);
});
