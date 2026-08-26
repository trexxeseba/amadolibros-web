// FICHAS-QUALITY-GUARD-1 — pruebas de INTEGRACIÓN sobre el HTML SSR completo
// y el feed XML completo.
//
// Por qué existe este archivo aparte: la primera versión de esta corrección
// sólo probó buildAutomaticProductShowcase() y dio un falso verde. El
// generador del showcase estaba limpio, pero la página real seguía emitiendo
// "Desconocido" en el JSON-LD, la tabla de datos, el mensaje de WhatsApp, los
// relacionados y <g:description> del feed. Estas pruebas miran la salida
// completa, que es lo que ve el cliente y lo que indexa Google.

import test from 'node:test';
import assert from 'node:assert/strict';

import { renderPage, selectRelatedBooks } from '../libro/[[path]].js';
import { renderFeedItem, buildFeedDescription } from '../feed.xml.js';
import { buildAutomaticProductShowcase } from '../_shared/automatic-product-showcase.js';
import { buildBookWhatsAppMessage } from '../../shared/whatsapp-messages.js';

// Patrón único que debe estar ausente de TODA superficie visible.
const AUTOR_GENERICO_RE = /desconocid|unknown author|autor no especificado|sin especificar|varios autores|vv\.?\s*aa\.?/i;

// Caso obligatorio de regresión, con los datos reales del producto.
const MLU724888358 = Object.freeze({
  id: 'MLU724888358',
  title: 'La Biblia Palabra De Vida - Verbo Divino',
  author: 'Desconocido',
  isbn: '9788490739808',
  publisher: 'Verbo Divino',
  price: 1490,
  currency: 'UYU',
  status: 'active',
  available_quantity: 3,
  condition: 'new',
  permalink: 'https://articulo.mercadolibre.com.uy/MLU-724888358',
  thumbnail: 'https://http2.mlstatic.com/D_BIBLIA-I.jpg',
  pictures: ['https://http2.mlstatic.com/D_BIBLIA-O.jpg'],
  description: '',
  bibliographic: {},
});

// Relacionados que arrastran «De Desconocido» en el título mostrado.
const RELACIONADOS_GENERICOS = [
  { id: 'MLU900000001', title: 'Biblia de bolsillo — De Desconocido', author: 'Desconocido', status: 'active', available_quantity: 2 },
  { id: 'MLU900000002', title: 'Nuevo Testamento, de Desconocido', author: 'Desconocido', status: 'active', available_quantity: 1 },
];

const AUTOR_REAL = Object.freeze({
  ...MLU724888358,
  id: 'MLU111111111',
  title: 'Cien años de soledad',
  author: 'Gabriel García Márquez',
  isbn: '9780307474728',
  permalink: 'https://articulo.mercadolibre.com.uy/MLU-111111111',
});

// ── 1 y 2. Render SSR completo: HTML + JSON-LD + WhatsApp + relacionados ──

test('1. el HTML SSR completo de MLU724888358 no contiene ninguna autoría genérica', () => {
  // Pipeline real: selectRelatedBooks() decide qué relacionados existen. Con
  // autoría genérica devuelve [], así que el bloque no se renderiza. Inyectar
  // relacionados a mano saltearía esa lógica y probaría un escenario que en
  // producción no ocurre.
  const relacionados = selectRelatedBooks(RELACIONADOS_GENERICOS, MLU724888358, 4);
  assert.equal(relacionados.length, 0, 'una autoría genérica no debe agrupar relacionados');

  const html = renderPage(MLU724888358, 'la-biblia-palabra-de-vida-verbo-divino', false, '', '', relacionados);
  assert.doesNotMatch(html, AUTOR_GENERICO_RE);
});

test('2. la ausencia se verifica superficie por superficie', () => {
  const html = renderPage(MLU724888358, 'la-biblia-palabra-de-vida-verbo-divino', false, '', '',
    selectRelatedBooks(RELACIONADOS_GENERICOS, MLU724888358, 4));

  // JSON-LD: sin nodo author
  const bloques = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map(m => JSON.parse(m[1]));
  const producto = bloques.find(s => [].concat(s['@type'] || []).includes('Book'));
  assert.ok(producto, 'debe existir el JSON-LD del libro');
  assert.equal('author' in producto, false, 'el JSON-LD no debe declarar author');
  assert.doesNotMatch(JSON.stringify(producto), AUTOR_GENERICO_RE);

  // Tabla de datos: sin fila Autor
  assert.doesNotMatch(html, /<dt>Autor<\/dt>/);

  // Relacionados: con autoría genérica el bloque no existe.
  assert.doesNotMatch(html, /Otros libros de/);
  assert.doesNotMatch(html, /class="related-books"/);
  assert.doesNotMatch(html, /De Desconocido/i);
});

test('2b. el mensaje de WhatsApp omite la línea Autor cuando la autoría es genérica', () => {
  for (const generico of ['Desconocido', 'Unknown', 'Varios autores', 'VV. AA.', 'N/A']) {
    const msg = buildBookWhatsAppMessage({ title: 'La Biblia', author: generico, page: '/libro/MLU724888358' });
    assert.doesNotMatch(msg, /Autor:/, `no debía haber línea Autor para ${generico}`);
    assert.doesNotMatch(msg, AUTOR_GENERICO_RE);
  }
});

// ── 3. Feed completo ──────────────────────────────────────────────────────

test('3. el bloque de feed de MLU724888358 no contiene autoría genérica', () => {
  const xml = renderFeedItem(MLU724888358);
  assert.doesNotMatch(xml, AUTOR_GENERICO_RE);
  assert.doesNotMatch(xml, /de Desconocido/i);
});

test('3b. el feed conserva GTIN, precio, disponibilidad, link e imagen', () => {
  const xml = renderFeedItem(MLU724888358);
  assert.match(xml, /<g:gtin>9788490739808<\/g:gtin>/);
  assert.match(xml, /<g:price>1490 UYU<\/g:price>/);
  assert.match(xml, /<g:availability>in stock<\/g:availability>/);
  assert.match(xml, /<g:link>https:\/\/www\.amadolibros\.com\/libro\/MLU724888358\//);
  assert.match(xml, /<g:image_link>/);
  assert.match(xml, /<g:id>MLU724888358<\/g:id>/);
});

test('3c. buildFeedDescription omite autor genérico y usa datos de la edición verificada', () => {
  const d = buildFeedDescription(MLU724888358);
  assert.doesNotMatch(d, AUTOR_GENERICO_RE);
  assert.match(d, /Verbo Divino/);
  assert.match(d, /ISBN 9788490739808/);
  assert.match(d, /1\.600 páginas/);
  assert.match(d, /Lectio Divina/);
});

// ── 4. Control: un autor real se conserva en todas las superficies ────────

test('4. un autor real sigue apareciendo en HTML, JSON-LD, WhatsApp y feed', () => {
  const html = renderPage(AUTOR_REAL, 'cien-anos-de-soledad', false, '', '', []);
  assert.match(html, /Gabriel García Márquez/);
  assert.match(html, /<dt>Autor<\/dt>/);

  const bloques = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map(m => JSON.parse(m[1]));
  const producto = bloques.find(s => [].concat(s['@type'] || []).includes('Book'));
  assert.equal(producto.author.name, 'Gabriel García Márquez');

  const msg = buildBookWhatsAppMessage({ title: AUTOR_REAL.title, author: AUTOR_REAL.author, page: '/x' });
  assert.match(msg, /Autor: Gabriel García Márquez/);

  assert.match(buildFeedDescription(AUTOR_REAL), /de Gabriel García Márquez/);
});

test('4b. con autor real los relacionados conservan "Otros libros de"', () => {
  const html = renderPage(AUTOR_REAL, 'cien-anos-de-soledad', false, '', '', [
    { id: 'MLU900000003', title: 'El amor en los tiempos del cólera', author: 'Gabriel García Márquez', status: 'active', available_quantity: 1 },
  ]);
  assert.match(html, /Otros libros de/);
  assert.doesNotMatch(html, /Libros relacionados/);
});

// ── 5. El feed sigue siendo XML válido ───────────────────────────────────

test('5. el bloque del feed es XML bien formado y sin etiquetas rotas', () => {
  const xml = renderFeedItem(MLU724888358);
  assert.match(xml.trim(), /^<item>/);
  assert.match(xml.trim(), /<\/item>$/);
  // Cada etiqueta g: abierta se cierra.
  const abiertas = [...xml.matchAll(/<(g:[a-z_]+)>/g)].map(m => m[1]);
  for (const tag of new Set(abiertas)) {
    const a = (xml.match(new RegExp(`<${tag}>`, 'g')) || []).length;
    const c = (xml.match(new RegExp(`</${tag}>`, 'g')) || []).length;
    assert.equal(a, c, `${tag}: ${a} aperturas vs ${c} cierres`);
  }
  assert.doesNotMatch(xml, /undefined|\[object Object\]|null<\//);
});

// ── Preservación exigida ─────────────────────────────────────────────────

test('6. se preservan ISBN, precio, stock, imagen, slug/canonical, título y CTA', () => {
  const html = renderPage(MLU724888358, 'la-biblia-palabra-de-vida-verbo-divino', false, '', '',
    selectRelatedBooks(RELACIONADOS_GENERICOS, MLU724888358, 4));
  assert.match(html, /9788490739808/);
  assert.match(html, /1[.,]?490/);
  assert.match(html, /La Biblia Palabra De Vida - Verbo Divino/);
  assert.match(html, /la-biblia-palabra-de-vida-verbo-divino/);
  assert.match(html, /<link rel="canonical"/);
  // En producción la portada se sirve por el proxy propio, no por mlstatic.
  assert.match(html, /\/book-cover\/MLU724888358\/cover\.jpg/);
});

// El CTA contextual (#240) lo genera la capa del showcase, no renderPage: se
// verifica donde realmente se produce.
test('6b. el CTA contextual de Biblias se preserva intacto', () => {
  const s = buildAutomaticProductShowcase(MLU724888358, { classificationTags: ['biblia'] });
  assert.equal(s.requestHelp.question, '¿Buscás otra Biblia o una edición específica?');
  assert.equal(s.requestHelp.label, 'Contanos qué buscás');
  assert.match(s.requestHelp.href, /^\/pedir-libro\/\?/);
  assert.match(s.requestHelp.href, /libro=MLU724888358/);
});
