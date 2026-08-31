import test from 'node:test';
import assert from 'node:assert/strict';

import { applyBookEnrichment } from '../_shared/book-enrichment-registry.js';
import {
  applyShowcaseTitleQuality,
  hasCuratedEditorialCopy,
} from '../_shared/showcase-title-quality.js';
import {
  buildAutomaticProductShowcase,
  productItemFromProductHtml,
} from '../_shared/automatic-product-showcase.js';
import { enrichAutomaticProductShowcaseHtml } from '../libro/_middleware.js';
import { renderPage } from '../libro/[[path]].js';

const PRODUCT_ID = 'MLU1453287196';
const ISBN = '9791388034435';
const SLUG = 'grandes-clasicos-tomo-11-disney-pixar-para-colorear';

function originalBook() {
  return {
    id: PRODUCT_ID,
    isbn: ISBN,
    title: 'Grandes Clasicos Tomo 11 Disney Pixar para Colorear',
    author: 'Varios autores',
    description: '',
    publisher: 'Hachette',
    pages: null,
    price: 1890,
    currency: 'UYU',
    status: 'active',
    available_quantity: 1,
    condition: 'new',
    permalink: 'https://articulo.mercadolibre.com.uy/MLU-1453287196',
    pictures: ['https://http2.mlstatic.com/D_NQ_NP_test-O.webp'],
    dimensions: { width: '22 cm', height: '30 cm', weight: '800 g' },
    bibliographic: { publication_year: '2026' },
  };
}

function editorialPage() {
  return renderPage(
    applyBookEnrichment(originalBook()),
    SLUG,
    false,
    '',
    '',
    [],
  );
}

test('reconoce el copy editorial curado y no lo envía a la vidriera automática', () => {
  const source = editorialPage();
  const parsed = productItemFromProductHtml(source, PRODUCT_ID);
  const enrichment = applyBookEnrichment(originalBook())._amadoEditorial;
  const config = buildAutomaticProductShowcase(parsed, {
    enrichment: {
      editorial: enrichment,
      provenance: [{ type: 'publisher', provider: 'Hachette Heroes' }],
    },
  });

  assert.equal(hasCuratedEditorialCopy(config), true);
  assert.equal(applyShowcaseTitleQuality(config, parsed), null);
});

test('el middleware conserva una sola ficha editorial, su title y su meta específicos', () => {
  const source = editorialPage();
  const result = enrichAutomaticProductShowcaseHtml(source, PRODUCT_ID);

  assert.equal(result, source);
  assert.equal((result.match(/class="editorial-enrichment"/g) || []).length, 1);
  assert.equal((result.match(/class="product-showcase"/g) || []).length, 0);
  assert.match(
    result,
    /<title>Libro para colorear por números Disney Pixar \| Tomo 11 \| Amado Libros<\/title>/,
  );
  assert.match(
    result,
    /<meta name="description" content="Libro para colorear por números Disney y Pixar, tomo 11: 100 dibujos misteriosos, códigos de color, escenas a doble página y 128 páginas\.">/,
  );
  assert.match(result, /100 ilustraciones misteriosas/);
  assert.match(result, /¿Para quién está recomendado\?/);
  assert.doesNotMatch(result, /Ficha ampliada de esta edición/);
  assert.doesNotMatch(result, /identifica esta versión concreta para compararla/);
  assert.doesNotMatch(result, /La publicación incluye 11 imágenes/);
});

test('las fichas automáticas sin copy editorial siguen usando limpieza de título y snippet', () => {
  const item = {
    ...originalBook(),
    isbn: '9788496836693',
    title: 'Manual De Emdr, De Louise Shapiro. Editorial Pléyades En Español',
    author: 'Louise Shapiro',
    description: '',
    publisher: 'Ediciones Pléyades',
    pages: 320,
    bibliographic: { language: 'Español', format: 'Tapa blanda' },
  };
  const source = renderPage(item, 'manual-de-emdr', false, '', '', []);
  const result = enrichAutomaticProductShowcaseHtml(source, PRODUCT_ID);

  assert.notEqual(result, source);
  assert.match(result, /class="product-showcase"/);
  assert.match(result, /<title>Manual de EMDR \| Amado Libros<\/title>/);
  assert.match(result, /12% menos por transferencia/);
});
