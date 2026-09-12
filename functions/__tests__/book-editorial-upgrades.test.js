import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyBookEnrichment,
  getBookEnrichmentByIsbn,
  listBookEnrichments,
  validateBookEnrichment,
} from '../_shared/book-enrichment-registry.js';
import { BOOK_EDITORIAL_UPGRADES } from '../_shared/book-editorial-upgrades.js';
import { renderFeedItem } from '../feed.xml.js';
import { renderPage } from '../libro/[[path]].js';

const ISBN = '9791388034435';
const ID = 'MLU1453287196';

function fixture() {
  return {
    id: ID,
    isbn: ISBN,
    title: 'Grandes Clasicos Tomo 11 Disney Pixar para Colorear',
    author: 'Varios autores',
    description: 'Ficha ampliada de esta edición. El ISBN identifica esta versión concreta.',
    publisher: 'Hachette',
    pages: null,
    dimensions: { width: '22 cm', height: '30 cm', weight: '800 g' },
    price: 1990,
    currency_id: 'UYU',
    status: 'active',
    available_quantity: 1,
    condition: 'new',
    pictures: ['https://http2.mlstatic.com/D_NQ_NP_2X_example-O.jpg'],
    permalink: 'https://articulo.mercadolibre.com.uy/MLU-1453287196',
  };
}

test('la edición Disney se reclasifica como enriquecimiento editorial real', () => {
  assert.equal(BOOK_EDITORIAL_UPGRADES.length, 1);
  const record = BOOK_EDITORIAL_UPGRADES[0];
  assert.equal(record.isbn, ISBN);
  assert.equal(record.editorial.quality_level, 'editorial_real_v1');
  assert.equal(validateBookEnrichment(record), true);
  assert.equal(getBookEnrichmentByIsbn(ISBN), record);
  assert.equal(listBookEnrichments().filter(entry => entry.isbn === ISBN).length, 1);
});

test('el contenido responde qué incluye, cómo funciona y para quién sirve', () => {
  const enriched = applyBookEnrichment(fixture());
  assert.match(enriched.description, /100 ilustraciones misteriosas/i);
  assert.match(enriched.description, /coloreando números y zonas según un código de color/i);
  assert.match(enriched.description, /Frozen, Encanto, Enredados/i);
  assert.equal(enriched.pages, 128);
  assert.equal(enriched.bibliographic.translator, 'Servei Gràfic NJR');
  assert.equal(enriched.bibliographic.illustrator, 'Jérémy Mariez');
  assert.equal(enriched._amadoEnrichmentLevel, 'editorial_real');
});

test('la ficha SSR muestra estructura editorial y SEO específico sin relleno heredado', () => {
  const enriched = applyBookEnrichment(fixture());
  const html = renderPage(enriched, 'grandes-clasicos-tomo-11-disney-pixar-para-colorear', true, '', '', []);
  assert.match(html, /Libro para colorear por números Disney Pixar | Tomo 11 | Amado Libros/);
  assert.match(html, /Qué contiene Grandes Clásicos tomo 11 de Disney y Pixar/);
  assert.match(html, /Cómo funciona y qué incluye/);
  assert.match(html, /¿Para quién está recomendado?/);
  assert.match(html, /Colorear por números/);
  assert.match(html, /Servei Gráfic NJR|Servei Gràfic NJR/);
  assert.doesNotMatch(html, /La publicación incluye 11 imágenes/);
  assert.doesNotMatch(html, /El ISBN identifica esta versión concreta/);
});

test('Merchant recibe una descripción comercial útil y mantiene los datos de venta', () => {
  const xml = renderFeedItem(fixture());
  assert.match(xml, /Libro para colorear por números Disney y Pixar/);
  assert.match(xml, /100 ilustraciones misteriosas/);
  assert.match(xml, /Frozen, Encanto, Enredados/);
  assert.match(xml, /<g:price>1990 UYU<\/g:price>/);
  assert.match(xml, /<g:availability>in stock<\/g:availability>/);
  assert.match(xml, /<g:gtin>9791388034435<\/g:gtin>/);
});
