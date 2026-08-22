// TAROT-FINDER-1 — dataset compacto para el cliente. Cubre: 14. sólo
// activos/stock, y 18. sin campos innecesarios + guard de tamaño.
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTarotFinderDataset } from '../_shared/tarot-finder-dataset.js';

function item(id, overrides = {}) {
  return { id, title: `Item ${id}`, price: 2000, status: 'active', available_quantity: 3, ...overrides };
}

function tag(overrides = {}) {
  return {
    primary_type: 'tarot',
    deck_family: null,
    format: 'mazo',
    bundle: 'desconocido',
    level: 'desconocido',
    language: 'desconocido',
    edition_style: null,
    ...overrides,
  };
}

const imageForId = id => `https://images.example.com/${id}.jpg`;
const hrefForItem = it => `https://www.amadolibros.com/libro/${it.id}/slug`;

test('incluye un candidato válido con exactamente los campos esperados, nada más', () => {
  const dataset = buildTarotFinderDataset({
    items: [item('MLU1')],
    tagLookup: () => tag(),
    imageForId,
    hrefForItem,
  });
  assert.equal(dataset.length, 1);
  assert.deepEqual(Object.keys(dataset[0]).sort(), [
    'bundle', 'deck_family', 'edition_style', 'href', 'id', 'image', 'language',
    'level', 'price', 'primary_type', 'status', 'stock', 'title',
  ].sort());
  assert.equal(dataset[0].status, 'active');
});

// ── TAROT-FINDER-UX-2: pool status='paused' para alternativas por encargo ──

test('status=paused: incluye un candidato pausado SIN exigir stock/precio, con price/stock en null', () => {
  const dataset = buildTarotFinderDataset({
    items: [item('MLU1', { status: 'paused', available_quantity: 0, price: 0 })],
    tagLookup: () => tag(),
    imageForId,
    hrefForItem,
    status: 'paused',
  });
  assert.equal(dataset.length, 1);
  assert.equal(dataset[0].status, 'paused');
  assert.equal(dataset[0].price, null, 'nunca se inventa un precio para algo por encargo');
  assert.equal(dataset[0].stock, null, 'nunca se inventa stock para algo por encargo');
});

test('status=paused: sigue excluyendo accesorios, libros sobre tarot y sistemas fuera de alcance', () => {
  const dataset = buildTarotFinderDataset({
    items: [item('MLU1', { status: 'paused' }), item('MLU2', { status: 'paused' })],
    tagLookup: (id) => id === 'MLU1' ? tag({ format: 'libro' }) : tag({ primary_type: 'lenormand' }),
    imageForId,
    hrefForItem,
    status: 'paused',
  });
  assert.deepEqual(dataset.map(d => d.id), ['MLU2']);
});

test('status=paused: no filtra por item.status del catálogo (una fila "paused" real igual entra)', () => {
  const dataset = buildTarotFinderDataset({
    items: [item('MLU1', { status: 'paused', available_quantity: 0, price: 0 })],
    tagLookup: () => tag(),
    imageForId,
    hrefForItem,
    status: 'paused',
  });
  assert.equal(dataset.length, 1);
});

// ── 14. Sólo activos con stock ────────────────────────────────────────────

test('14. excluye items pausados', () => {
  const dataset = buildTarotFinderDataset({
    items: [item('MLU1', { status: 'paused' })],
    tagLookup: () => tag(),
    imageForId,
    hrefForItem,
  });
  assert.equal(dataset.length, 0);
});

test('14b. excluye items activos sin stock', () => {
  const dataset = buildTarotFinderDataset({
    items: [item('MLU1', { available_quantity: 0 })],
    tagLookup: () => tag(),
    imageForId,
    hrefForItem,
  });
  assert.equal(dataset.length, 0);
});

test('14c. excluye items con precio inválido (0, negativo o no numérico)', () => {
  const dataset = buildTarotFinderDataset({
    items: [item('MLU1', { price: 0 }), item('MLU2', { price: null }), item('MLU3', { price: -5 })],
    tagLookup: () => tag(),
    imageForId,
    hrefForItem,
  });
  assert.equal(dataset.length, 0);
});

test('excluye accesorios y libros sobre tarot — el Finder busca un mazo', () => {
  const dataset = buildTarotFinderDataset({
    items: [item('MLU1'), item('MLU2'), item('MLU3')],
    tagLookup: (id) => {
      if (id === 'MLU1') return tag({ primary_type: 'accesorio', format: 'accesorio' });
      if (id === 'MLU2') return tag({ primary_type: 'tarot', format: 'libro' });
      return tag({ primary_type: 'tarot', format: 'mazo' });
    },
    imageForId,
    hrefForItem,
  });
  assert.deepEqual(dataset.map(d => d.id), ['MLU3']);
});

test('excluye items sin clasificación (tagLookup devuelve null)', () => {
  const dataset = buildTarotFinderDataset({
    items: [item('MLU1')],
    tagLookup: () => null,
    imageForId,
    hrefForItem,
  });
  assert.equal(dataset.length, 0);
});

test('excluye primary_type=otro_sistema y desconocido — el Finder es sólo tarot/oráculo/lenormand/kipper', () => {
  const dataset = buildTarotFinderDataset({
    items: [item('MLU1'), item('MLU2')],
    tagLookup: (id) => tag({ primary_type: id === 'MLU1' ? 'otro_sistema' : 'desconocido' }),
    imageForId,
    hrefForItem,
  });
  assert.equal(dataset.length, 0);
});

test('no duplica un id repetido en items', () => {
  const dataset = buildTarotFinderDataset({
    items: [item('MLU1'), item('MLU1')],
    tagLookup: () => tag(),
    imageForId,
    hrefForItem,
  });
  assert.equal(dataset.length, 1);
});

test('el href de cada candidato viene del inyectado hrefForItem, nunca reconstruido acá', () => {
  const dataset = buildTarotFinderDataset({
    items: [item('MLU1')],
    tagLookup: () => tag(),
    imageForId,
    hrefForItem: () => 'https://www.amadolibros.com/libro/MLU1/titulo-exacto',
  });
  assert.equal(dataset[0].href, 'https://www.amadolibros.com/libro/MLU1/titulo-exacto');
});

test('valida tipos de entrada', () => {
  assert.throws(() => buildTarotFinderDataset({ items: 'no-array', tagLookup: () => null, imageForId, hrefForItem }), /items debe ser un array/);
  assert.throws(() => buildTarotFinderDataset({ items: [], tagLookup: null, imageForId, hrefForItem }), /tagLookup debe ser una función/);
  assert.throws(() => buildTarotFinderDataset({ items: [], tagLookup: () => null, imageForId: null, hrefForItem }), /imageForId debe ser una función/);
  assert.throws(() => buildTarotFinderDataset({ items: [], tagLookup: () => null, imageForId, hrefForItem: null }), /hrefForItem debe ser una función/);
});

// ── 18. Tamaño del payload — guard contra crecimiento accidental ────────

test('18. el dataset serializado se mantiene liviano por candidato (guard de tamaño)', () => {
  const items = Array.from({ length: 200 }, (_, i) => item(`MLU${1000 + i}`, {
    title: 'Un Título De Mazo Razonablemente Largo Con Autor Incluido',
  }));
  const dataset = buildTarotFinderDataset({
    items,
    tagLookup: () => tag({ deck_family: 'rider_waite_smith', language: 'espanol', bundle: 'mazo_mas_guia', edition_style: 'ilustrada_especial' }),
    imageForId,
    hrefForItem: it => `https://www.amadolibros.com/libro/${it.id}/un-titulo-de-mazo-razonablemente-largo-con-autor-incluido`,
  });
  const json = JSON.stringify(dataset);
  const bytesPerCandidate = json.length / dataset.length;
  // Guard conservador: si esto falla, alguien agregó un campo pesado
  // (descripción completa, galería de imágenes, etc.) sin querer.
  assert.ok(bytesPerCandidate < 450, `cada candidato pesa ${bytesPerCandidate.toFixed(1)} bytes en JSON, se esperaba <450`);
  // Con el universo real actual (~190 candidatos), el payload total debe
  // quedar muy por debajo de 120KB — cómodo para mobile.
  assert.ok(json.length < 120_000, `el dataset completo pesa ${json.length} bytes, se esperaba <120000`);
});

test('18b. el dataset nunca incluye description ni pictures/galería completa', () => {
  const dataset = buildTarotFinderDataset({
    items: [item('MLU1', { description: 'Un texto muy largo '.repeat(50), pictures: ['a', 'b', 'c', 'd', 'e'] })],
    tagLookup: () => tag(),
    imageForId,
    hrefForItem,
  });
  assert.ok(!('description' in dataset[0]));
  assert.ok(!('pictures' in dataset[0]));
});
