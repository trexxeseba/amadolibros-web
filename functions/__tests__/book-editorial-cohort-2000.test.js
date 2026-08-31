import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_EDITORIAL_COHORT_LIMIT,
  authorsCompatible,
  buildEditorialDossier,
  classifyEditorialReadiness,
  titlesCompatible,
} from '../../scripts/seo/book-editorial-cohort-2000.mjs';

const candidate = {
  id: 'MLU1453287196',
  isbn: '9791388034435',
  title: 'Grandes Clasicos Tomo 11 Disney Pixar para Colorear',
  author: 'Varios autores',
  listing_ids: ['MLU1453287196'],
  listing_count: 1,
  total_stock: 3,
  priority_score: 900,
  research: { description_length: 40 },
};

function source(overrides = {}) {
  return {
    source: 'google_books',
    source_url: 'https://example.test/book',
    isbn: candidate.isbn,
    title: 'Dibujos para colorear, ¡qué misterio! Grandes clásicos. Tomo 11',
    author: '',
    description: 'Esta edición reúne cien ilustraciones misteriosas de Disney y Pixar. Cada lámina se completa siguiendo números y códigos de color hasta revelar una escena. Incluye composiciones detalladas y actividades creativas guiadas para dedicar tiempo a cada imagen.',
    publisher: 'Hachette Heroes',
    pages: 128,
    language: 'Español',
    format: 'Tapa blanda',
    publication_year: '2026',
    topics: ['Disney y Pixar', 'Colorear por números', 'Arteterapia'],
    ...overrides,
  };
}

test('la unidad de trabajo queda fijada en 2.000 ISBN', () => {
  assert.equal(DEFAULT_EDITORIAL_COHORT_LIMIT, 2000);
});

test('acepta variaciones de título y autor compatibles sin exigir coincidencia literal', () => {
  assert.equal(titlesCompatible(candidate.title, source().title), true);
  assert.equal(authorsCompatible('Julia Quinn', 'Quinn, Julia'), true);
});

test('dos fuentes compatibles con descripción sustancial habilitan redacción, no publicación', () => {
  const records = [
    source(),
    source({ source: 'open_library', source_url: 'https://openlibrary.org/isbn/9791388034435' }),
  ];
  const readiness = classifyEditorialReadiness(candidate, records);
  assert.equal(readiness.status, 'READY_FOR_EDITORIAL_DRAFT');
  assert.equal(readiness.ready_for_editorial_draft, true);

  const dossier = buildEditorialDossier(candidate, records);
  assert.equal(dossier.publication_allowed, false);
  assert.equal(dossier.next_action, 'REDACT_AND_VALIDATE_EDITORIAL_REAL_V1');
  assert.match(JSON.stringify(dossier), /Colorear por números/);
});

test('una sola descripción queda en revisión y no se disfraza de ficha enriquecida', () => {
  const readiness = classifyEditorialReadiness(candidate, [source()]);
  assert.equal(readiness.status, 'REVIEW_SINGLE_CONTENT_SOURCE');
  assert.equal(readiness.ready_for_editorial_draft, false);
});

test('un título incompatible bloquea el dossier por conflicto de identidad', () => {
  const readiness = classifyEditorialReadiness(candidate, [
    source({ title: 'Manual avanzado de cirugía cardiovascular', author: 'Otra Persona' }),
  ]);
  assert.equal(readiness.status, 'REVIEW_IDENTITY');
  assert.equal(readiness.ready_for_editorial_draft, false);
});

test('el dossier no contiene campos comerciales ni habilita cambios de producción', () => {
  const dossier = buildEditorialDossier(candidate, [source()]);
  const serialized = JSON.stringify(dossier);
  assert.doesNotMatch(serialized, /"(?:price|available_quantity|total_stock|permalink|canonical|pictures|thumbnail|condition)"\s*:/);
  assert.equal(dossier.publication_allowed, false);
});
