import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBookSeoTitle,
  deriveBookDisplayTitle,
} from '../_shared/book-display-title.js';

function item(title, overrides = {}) {
  return {
    title,
    author: 'Autora Real',
    publisher: 'Editorial Real',
    bibliographic: {
      format: 'Tapa blanda',
      language: 'Español',
      edition: '2.ª edición',
      publication_year: '2020',
      collection: 'Biblioteca de Psicología',
    },
    ...overrides,
  };
}

test('retira autoría genérica, editorial, formato, idioma y año del sufijo comercial', () => {
  const raw = 'Terapia Psicodinamica Para La Patologia De La Personalidad, De Vv. Aa.. Editorial Ddb, Tapa Blanda En Español, 2020';
  const result = deriveBookDisplayTitle(item(raw, {
    author: 'Eve Caligor, Otto F. Kernberg, John F. Clarkin y Frank E. Yeomans',
    publisher: 'DDB',
  }));

  assert.equal(result.rawTitle, raw);
  assert.equal(result.title, 'Terapia Psicodinamica para la Patologia de la Personalidad');
  assert.equal(result.changed, true);
  assert.equal(result.reason, 'metadata-suffix');
  assert.ok(result.removedParts.some(value => /Editorial Ddb/i.test(value)));
  assert.ok(result.removedParts.some(value => /2020/.test(value)));
});

test('limpia la ficha observada de EMDR y conserva la sigla', () => {
  const raw = 'Manual De Emdr Y Procesos De Terapia Familiar, De Louise Shapiro. Editorial Ediciones Pléyades En Español';
  const result = deriveBookDisplayTitle(item(raw, {
    author: 'Francine Shapiro, Florence W. Kaslow y Louise Maxfield',
    publisher: 'Ediciones Pléyades',
  }));

  assert.equal(result.title, 'Manual de EMDR y Procesos de Terapia Familiar');
  assert.ok(result.removedParts.length >= 2);
});

test('mueve número y colección fuera del título sin cortar el título de obra', () => {
  const result = deriveBookDisplayTitle(item(
    'Psicoterapia Centrada En La Transferenci: 213 Biblioteca De Psicología',
  ));

  assert.equal(result.title, 'Psicoterapia Centrada en la Transferenci');
  assert.deepEqual(result.removedParts, ['213 Biblioteca De Psicología']);
});

test('conserva subtítulos legítimos después de dos puntos', () => {
  const raw = 'El Hombre En Busca De Sentido: Un Psicólogo En Un Campo De Concentración';
  const result = deriveBookDisplayTitle(item(raw, {
    bibliographic: {},
  }));

  assert.equal(result.title, 'El Hombre en Busca de Sentido: un Psicólogo en un Campo de Concentración');
  assert.equal(result.removedParts.length, 0);
});

test('no interpreta De Profundis ni una frase interna con de como autoría', () => {
  assert.equal(deriveBookDisplayTitle(item('De Profundis', { bibliographic: {} })).title, 'De Profundis');
  assert.equal(
    deriveBookDisplayTitle(item('La Librería De Los Finales Felices', { bibliographic: {} })).title,
    'La Librería de los Finales Felices',
  );
});

test('normaliza conectores y siglas sin reescribir las palabras de la obra', () => {
  assert.equal(
    deriveBookDisplayTitle(item('Harry Potter Y La Piedra Filosofal', { bibliographic: {} })).title,
    'Harry Potter y la Piedra Filosofal',
  );
  assert.equal(
    deriveBookDisplayTitle(item('Manual Tcc Para Tdah', { bibliographic: {} })).title,
    'Manual TCC para TDAH',
  );
});

test('no muta el título fuente y genera un title SEO de máximo 70 caracteres', () => {
  const source = item(
    'Manual De Emdr Y Procesos De Terapia Familiar, De Louise Shapiro. Editorial Ediciones Pléyades En Español',
    { publisher: 'Ediciones Pléyades' },
  );
  const before = source.title;
  const display = deriveBookDisplayTitle(source);
  const seoTitle = buildBookSeoTitle(display.title);

  assert.equal(source.title, before);
  assert.ok(seoTitle.length <= 70);
  assert.match(seoTitle, / \| Amado Libros$/);
});

test('rechaza una poda que dejaría un candidato irrazonablemente corto', () => {
  const raw = 'De Luz, De Ana María Pérez';
  const result = deriveBookDisplayTitle(item(raw, {
    author: 'Ana María Pérez',
    bibliographic: {},
  }));

  assert.equal(result.title, raw);
});
