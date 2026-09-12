import test from 'node:test';
import assert from 'node:assert/strict';

import { curatedIsRetired } from '../../scripts/seo/showcase-curated-policy.mjs';

const sano = [0, 0, 0, 0, 0];

test('el único caso que se perdona: la ficha no está y el catálogo lo confirma', () => {
  assert.equal(curatedIsRetired({
    status: 404, publishedInCatalog: false, automaticFailureCounts: sano,
  }), true);
});

test('si la ficha responde, se le exige todo igual que antes', () => {
  // Este es el caso que el control existe para agarrar: la ficha curada está
  // publicada pero alguien le pisó el H1 o el texto. No se perdona nunca.
  for (const status of [200, 301, 500, 503]) {
    assert.equal(curatedIsRetired({
      status, publishedInCatalog: false, automaticFailureCounts: sano,
    }), false, `HTTP ${status} no puede eximir al piloto`);
  }
});

test('si el libro SIGUE activo en el catálogo, un 404 es una falla real', () => {
  assert.equal(curatedIsRetired({
    status: 404, publishedInCatalog: true, automaticFailureCounts: sano,
  }), false);
});

test('si no se pudo leer el catálogo, no se perdona: no saber no alcanza', () => {
  assert.equal(curatedIsRetired({
    status: 404, publishedInCatalog: null, automaticFailureCounts: sano,
  }), false);
  // Ni siquiera con formas raras que podrían colarse como "falsy".
  for (const desconocido of [undefined, 0, '', NaN]) {
    assert.equal(curatedIsRetired({
      status: 404, publishedInCatalog: desconocido, automaticFailureCounts: sano,
    }), false, `${String(desconocido)} no es un "no está publicado" confirmado`);
  }
});

test('si el sitio está roto, el 404 del piloto no se tapa', () => {
  // Si las fichas automáticas también fallan, ese 404 es del sitio entero y
  // hay que verlo. Perdonarlo acá sería esconder una caída.
  assert.equal(curatedIsRetired({
    status: 404, publishedInCatalog: false, automaticFailureCounts: [0, 0, 3, 0, 0],
  }), false);
  assert.equal(curatedIsRetired({
    status: 404, publishedInCatalog: false, automaticFailureCounts: [2, 2, 2, 2, 2],
  }), false);
});

test('sin muestras automáticas no hay con qué comparar, así que no se perdona', () => {
  for (const muestras of [[], null, undefined, 'nada']) {
    assert.equal(curatedIsRetired({
      status: 404, publishedInCatalog: false, automaticFailureCounts: muestras,
    }), false, 'sin muestras sanas no se puede afirmar que el sitio funciona');
  }
});
