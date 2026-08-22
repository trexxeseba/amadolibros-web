import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyBookIntelligenceEvidence,
  normalizeEvidenceText,
  summarizeBookIntelligenceEvidence,
} from '../_shared/book-intelligence-evidence.js';

const ISBN = '9788496836693';

function item(overrides = {}) {
  return {
    id: 'MLU1',
    title: 'Padres fuertes, hijas felices',
    author: 'Meg Meeker',
    isbn: ISBN,
    status: 'active',
    available_quantity: 2,
    ...overrides,
  };
}

function evidence(source, overrides = {}) {
  return {
    source,
    isbn: ISBN,
    title: 'Padres fuertes, hijas felices',
    author: 'Meg Meeker',
    description: 'Una descripción suficientemente extensa y específica de la obra, su enfoque, los temas que desarrolla y el tipo de lector al que puede resultar útil. Incluye evidencia editorial concreta para permitir una síntesis posterior sin inventar contenido.',
    ...overrides,
  };
}

test('normaliza texto de identidad de forma determinista', () => {
  assert.equal(normalizeEvidenceText('  Psicología, Clínica  '), 'psicologia clinica');
});

test('dos fuentes independientes, una fuerte, habilitan tier green', () => {
  const result = classifyBookIntelligenceEvidence(item(), [
    evidence('google_books'),
    evidence('open_library', { summary: 'Resumen independiente suficientemente detallado sobre la misma obra y edición.' }),
  ]);
  assert.equal(result.tier, 'green');
  assert.equal(result.generation_policy.can_generate_work_content, true);
  assert.equal(result.generation_policy.can_auto_publish_work_content, true);
  assert.equal(result.independent_work_source_count, 2);
});

test('una sola fuente fuerte queda yellow: puede generar, no auto-publicar', () => {
  const result = classifyBookIntelligenceEvidence(item(), [evidence('publisher')]);
  assert.equal(result.tier, 'yellow');
  assert.equal(result.generation_policy.can_generate_work_content, true);
  assert.equal(result.generation_policy.can_auto_publish_work_content, false);
});

test('una referencia web débil sola no habilita generación', () => {
  const result = classifyBookIntelligenceEvidence(item(), [evidence('web_reference')]);
  assert.equal(result.tier, 'red');
  assert.equal(result.generation_policy.can_generate_work_content, false);
});

test('mismo ISBN con título incompatible bloquea por conflicto de identidad', () => {
  const result = classifyBookIntelligenceEvidence(item(), [
    evidence('google_books', { title: 'Un libro completamente distinto' }),
    evidence('open_library'),
  ]);
  assert.equal(result.tier, 'red');
  assert.equal(result.reason, 'identity_conflict');
  assert.equal(result.identity_conflicts.some(conflict => conflict.field === 'title'), true);
});

test('otro ISBN de la misma obra puede aportar contenido de obra pero no datos de edición', () => {
  const result = classifyBookIntelligenceEvidence(item(), [
    evidence('google_books', { isbn: '9788499988771' }),
  ]);
  assert.equal(result.tier, 'yellow');
  assert.equal(result.exact_isbn_source_count, 0);
  assert.equal(result.edition_facts.publisher.value, null);
});

test('datos de edición sólo se vuelven auto-publicables con ISBN exacto y fuente fuerte', () => {
  const result = classifyBookIntelligenceEvidence(item(), [
    evidence('google_books', {
      publisher: 'Ciudadela Libros',
      pages: 304,
      language: 'Español',
      publication_year: '2008',
    }),
  ]);
  assert.equal(result.edition_fields_auto_publishable.publisher, true);
  assert.equal(result.edition_fields_auto_publishable.pages, true);
  assert.equal(result.edition_fields_auto_publishable.language, true);
});

test('conflicto de páginas se expone y ese campo deja de ser auto-publicable', () => {
  const result = classifyBookIntelligenceEvidence(item(), [
    evidence('google_books', { pages: 304 }),
    evidence('open_library', { pages: 320 }),
  ]);
  assert.equal(result.edition_fact_conflicts.includes('pages'), true);
  assert.equal(result.edition_fields_auto_publishable.pages, false);
  assert.equal(result.tier, 'green');
});

test('cinco temas explícitos en una fuente fuerte yellow habilitan generación de temas', () => {
  const result = classifyBookIntelligenceEvidence(item(), [
    evidence('publisher', {
      topics: ['Liderazgo', 'Familia', 'Comunicación', 'Confianza', 'Educación'],
      description: '',
    }),
  ]);
  assert.equal(result.tier, 'yellow');
  assert.equal(result.generation_policy.can_generate_five_topics, true);
});

test('sin ISBN puede clasificarse yellow a nivel obra, pero nunca publica datos de edición', () => {
  const result = classifyBookIntelligenceEvidence(item({ isbn: null }), [
    evidence('publisher', { isbn: null }),
  ]);
  assert.equal(result.tier, 'yellow');
  assert.equal(result.isbn, null);
  assert.equal(Object.values(result.edition_fields_auto_publishable).some(Boolean), false);
});

test('estado pausado se separa de la calidad editorial', () => {
  const result = classifyBookIntelligenceEvidence(
    item({ status: 'paused', available_quantity: 0 }),
    [evidence('google_books'), evidence('open_library')],
  );
  assert.equal(result.availability, 'by_request');
  assert.equal(result.tier, 'green');
});

test('resumen agrega tiers, disponibilidad y conflictos', () => {
  const green = classifyBookIntelligenceEvidence(item(), [evidence('google_books'), evidence('open_library')]);
  const yellow = classifyBookIntelligenceEvidence(item({ id: 'MLU2', status: 'paused', available_quantity: 0 }), [evidence('publisher')]);
  const red = classifyBookIntelligenceEvidence(item({ id: 'MLU3' }), []);
  const summary = summarizeBookIntelligenceEvidence([green, yellow, red]);
  assert.deepEqual(summary, {
    total: 3,
    green: 1,
    yellow: 1,
    red: 1,
    active: 2,
    by_request: 1,
    auto_publish_work_content: 1,
    generate_five_topics: 1,
    identity_conflicts: 0,
    edition_fact_conflicts: 0,
  });
});
