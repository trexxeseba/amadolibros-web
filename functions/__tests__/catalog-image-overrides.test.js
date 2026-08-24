// CATALOG-IMAGE-QUALITY-1 — correcciones explícitas y verificadas para dos
// imágenes puntuales del catálogo. Estos tests prueban el contrato exacto
// pedido: sólo los IDs listados reciben override, MLU717791364 deja de
// mostrar el logo de "El Yelmo de Mambrino", el resto de los datos del
// producto (isbn, título, precio, stock, galería) queda intacto, un
// producto no listado conserva su imagen original, y nunca se inventa una
// imagen para un candidato que no pudo validarse (CASO 2).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATALOG_IMAGE_OVERRIDES,
  overrideImageForProduct,
  applyCatalogImageOverride,
} from '../_shared/catalog-image-overrides.js';
import { coverSource, primaryCoverSource } from '../book-cover/[[path]].js';

const YELMO_LOGO_URL = 'https://http2.mlstatic.com/D_YELMO_LOGO-O.jpg';
const VERIFIED_REPLACEMENT_URL = 'https://http2.mlstatic.com/D_821791-MLU83069485320_032025-O.jpg';

const santaBiblia = Object.freeze({
  id: 'MLU717791364',
  title: 'Santa Biblia',
  author: 'Martín Nieto, Evaristo',
  isbn: '9788428543231',
  price: 15000,
  status: 'active',
  available_quantity: 2,
  thumbnail: YELMO_LOGO_URL.replace('-O.', '-I.'),
  pictures: [YELMO_LOGO_URL, 'https://http2.mlstatic.com/D_OTRA-O.jpg'],
  permalink: 'https://articulo.mercadolibre.com.uy/MLU717791364',
});

// CASO 2 — imagen de baja calidad, explícitamente NO implementado: no hay
// evidencia de comparación visual/bytes real disponible (ver PR), así que
// este producto nunca debe recibir un override inventado.
const evangelioEsenios = Object.freeze({
  id: 'MLU683276890',
  title: 'El Evangelio de los Esenios 1',
  author: 'Edmon Bordeaux Szekely',
  isbn: '9789995471234',
  price: 8000,
  status: 'active',
  available_quantity: 5,
  thumbnail: 'https://http2.mlstatic.com/D_890906-MLA49286758306_032022-I.jpg',
  pictures: ['https://http2.mlstatic.com/D_890906-MLA49286758306_032022-O.jpg'],
  permalink: 'https://articulo.mercadolibre.com.uy/MLU683276890',
});

// ── 1. Sólo los IDs listados explícitamente pueden recibir un override ─────

test('1. sólo MLU717791364 tiene override explícito; ningún otro ID lo tiene, ni siquiera MLU683276890 (CASO 2)', () => {
  assert.deepEqual(Object.keys(CATALOG_IMAGE_OVERRIDES), ['MLU717791364']);
  assert.ok(overrideImageForProduct('MLU717791364'));
  assert.equal(overrideImageForProduct('MLU683276890'), null);
  assert.equal(overrideImageForProduct('MLU000000000'), null);
  assert.equal(overrideImageForProduct(''), null);
  assert.equal(overrideImageForProduct(undefined), null);
});

test('1b. overrideImageForProduct es insensible a mayúsculas/minúsculas pero no matchea por título ni similitud', () => {
  assert.ok(overrideImageForProduct('mlu717791364'));
  // Un producto con título parecido pero id distinto nunca recibe override.
  assert.equal(overrideImageForProduct('MLU717791365'), null);
});

// ── 2. MLU717791364 deja de mostrar la imagen del Yelmo de Mambrino ────────

test('2. applyCatalogImageOverride reemplaza pictures[0] de MLU717791364 por la portada verificada, no por el logo del Yelmo', () => {
  const result = applyCatalogImageOverride(santaBiblia);
  assert.notEqual(result.pictures[0], YELMO_LOGO_URL);
  assert.equal(result.pictures[0], VERIFIED_REPLACEMENT_URL);
});

test('2b. coverSource()/primaryCoverSource() (capa compartida real de tarjetas y ficha) tampoco sirven el logo del Yelmo para MLU717791364', () => {
  const source = primaryCoverSource(santaBiblia);
  assert.notEqual(source, YELMO_LOGO_URL);
  assert.equal(source, VERIFIED_REPLACEMENT_URL);
  assert.equal(coverSource(santaBiblia, 0), VERIFIED_REPLACEMENT_URL);
});

// ── 3. El ISBN y los demás datos permanecen intactos ────────────────────────

test('3. applyCatalogImageOverride no toca título, isbn, slug-source, precio, stock, id ni permalink', () => {
  const result = applyCatalogImageOverride(santaBiblia);
  assert.equal(result.id, santaBiblia.id);
  assert.equal(result.title, santaBiblia.title);
  assert.equal(result.isbn, santaBiblia.isbn);
  assert.equal(result.price, santaBiblia.price);
  assert.equal(result.available_quantity, santaBiblia.available_quantity);
  assert.equal(result.status, santaBiblia.status);
  assert.equal(result.permalink, santaBiblia.permalink);
});

test('3b. sólo pictures[0] cambia; el resto de la galería original queda igual', () => {
  const result = applyCatalogImageOverride(santaBiblia);
  assert.equal(result.pictures.length, santaBiblia.pictures.length);
  assert.equal(result.pictures[1], santaBiblia.pictures[1]);
});

test('3c. el objeto original pasado a applyCatalogImageOverride no se muta', () => {
  const before = JSON.stringify(santaBiblia);
  applyCatalogImageOverride(santaBiblia);
  assert.equal(JSON.stringify(santaBiblia), before);
});

test('3d. coverSource() para posiciones distintas de 0 nunca aplica el override (sólo la portada)', () => {
  assert.equal(coverSource(santaBiblia, 1), 'https://http2.mlstatic.com/D_OTRA-O.jpg');
});

// ── 4. Un producto no listado conserva su imagen original ──────────────────

test('4. un producto sin override (MLU683276890, CASO 2) conserva su imagen y objeto originales sin cambios', () => {
  const result = applyCatalogImageOverride(evangelioEsenios);
  assert.equal(result, evangelioEsenios); // misma referencia: no se copia si no hay override
  assert.equal(result.pictures[0], evangelioEsenios.pictures[0]);
});

test('4b. coverSource()/primaryCoverSource() para un producto no listado resuelven la imagen original sin tocarla', () => {
  assert.equal(
    primaryCoverSource(evangelioEsenios),
    'https://http2.mlstatic.com/D_890906-MLA49286758306_032022-O.jpg',
  );
});

// ── 5. No se inventa una imagen si la candidata no pudo validarse (CASO 2) ─

test('5. CASO 2 (MLU683276890) no tiene override: la falta de verificación visual/de bytes nunca se completa con una imagen inventada', () => {
  assert.equal(overrideImageForProduct('MLU683276890'), null);
  assert.equal(Object.prototype.hasOwnProperty.call(CATALOG_IMAGE_OVERRIDES, 'MLU683276890'), false);
});

test('5b. applyCatalogImageOverride es idempotente: aplicarla dos veces da el mismo resultado que una vez', () => {
  const once = applyCatalogImageOverride(santaBiblia);
  const twice = applyCatalogImageOverride(once);
  assert.deepEqual(once, twice);
});

test('5c. applyCatalogImageOverride tolera entradas no válidas sin inventar nada (null, undefined, objeto sin id)', () => {
  assert.equal(applyCatalogImageOverride(null), null);
  assert.equal(applyCatalogImageOverride(undefined), undefined);
  const noId = { title: 'sin id' };
  assert.equal(applyCatalogImageOverride(noId), noId);
});
