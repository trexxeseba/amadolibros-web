import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzeEditionClusters,
  isGenericAuthor,
  normalizeComparableText,
  pickCanonicalRepresentative,
  stableReportJson,
} from '../../scripts/seo/edition-consolidation-candidates.mjs';

const ISBN_A = '9788412027082';
const ISBN_B = '9780194316002';

function item(id, overrides = {}) {
  return {
    id,
    title: 'Reflexiones sobre vivir en compasión',
    author: 'Autor Ejemplo',
    isbn: ISBN_A,
    condition: 'new',
    status: 'active',
    available_quantity: 1,
    price: 1500,
    ...overrides,
  };
}

test('normaliza texto sin borrar palabras significativas', () => {
  assert.equal(
    normalizeComparableText('  María Montessori: Psicogeometría  '),
    'maria montessori psicogeometria',
  );
});

test('reconoce autores genéricos después de normalizar', () => {
  for (const value of ['Varios autores', 'VV. AA.', 'Anónimo', 'No aplica', 'Various Authors']) {
    assert.equal(isGenericAuthor(value), true, value);
  }
  assert.equal(isGenericAuthor('Virginia Busnelli'), false);
});

test('detecta como alta confianza mismo ISBN, título, autor y condición', () => {
  const report = analyzeEditionClusters([
    item('MLU100', { available_quantity: 1, price: 1600 }),
    item('MLU101', { available_quantity: 3, price: 1700 }),
  ]);

  assert.equal(report.stats.high_confidence_groups, 1);
  assert.equal(report.stats.canonical_candidate_sources, 1);
  assert.deepEqual(report.clusters[0], {
    gtin: ISBN_A,
    condition: 'new',
    confidence: 'high',
    recommended_action: 'canonical_candidate',
    reasons: [],
    representative_id: 'MLU101',
    source_ids: ['MLU100'],
    member_ids: ['MLU100', 'MLU101'],
    normalized_title: 'reflexiones sobre vivir en compasion',
    normalized_author: 'autor ejemplo',
  });
});

test('el representante usa stock, luego precio y luego id como desempate', () => {
  const chosen = pickCanonicalRepresentative([
    item('MLU102', { available_quantity: 2, price: 1500 }),
    item('MLU101', { available_quantity: 2, price: 1400 }),
    item('MLU100', { available_quantity: 1, price: 1000 }),
  ]);
  assert.equal(chosen.id, 'MLU101');

  const tie = pickCanonicalRepresentative([
    item('MLU102', { available_quantity: 2, price: 1400 }),
    item('MLU101', { available_quantity: 2, price: 1400 }),
  ]);
  assert.equal(tie.id, 'MLU101');
});

test('títulos incompatibles bloquean consolidación automática', () => {
  const report = analyzeEditionClusters([
    item('MLU100'),
    item('MLU101', { title: 'Un libro completamente distinto' }),
  ]);
  assert.equal(report.clusters[0].confidence, 'reject');
  assert.equal(report.clusters[0].recommended_action, 'do_not_consolidate');
  assert.deepEqual(report.clusters[0].source_ids, []);
  assert.ok(report.clusters[0].reasons.includes('title_conflict'));
});

test('autores incompatibles bloquean consolidación automática', () => {
  const report = analyzeEditionClusters([
    item('MLU100'),
    item('MLU101', { author: 'Otra Persona' }),
  ]);
  assert.equal(report.clusters[0].confidence, 'reject');
  assert.ok(report.clusters[0].reasons.includes('author_conflict'));
});

test('autor faltante obliga a revisión humana aunque el resto coincida', () => {
  const report = analyzeEditionClusters([
    item('MLU100'),
    item('MLU101', { author: null }),
  ]);
  assert.equal(report.clusters[0].confidence, 'review');
  assert.equal(report.clusters[0].recommended_action, 'manual_review');
  assert.deepEqual(report.clusters[0].source_ids, []);
  assert.ok(report.clusters[0].reasons.includes('author_missing'));
});

test('autor genérico no habilita canonical automático', () => {
  const report = analyzeEditionClusters([
    item('MLU100', { author: 'Varios autores' }),
    item('MLU101', { author: 'Varios autores' }),
  ]);
  assert.equal(report.clusters[0].confidence, 'review');
  assert.equal(report.clusters[0].recommended_action, 'manual_review');
  assert.deepEqual(report.clusters[0].source_ids, []);
  assert.ok(report.clusters[0].reasons.includes('author_generic'));
});

test('condición desconocida no habilita canonical automático', () => {
  const report = analyzeEditionClusters([
    item('MLU100', { condition: null }),
    item('MLU101', { condition: null }),
  ]);
  assert.equal(report.clusters[0].confidence, 'review');
  assert.ok(report.clusters[0].reasons.includes('condition_unknown'));
});

test('new y used nunca se agrupan entre sí', () => {
  const report = analyzeEditionClusters([
    item('MLU100', { condition: 'new' }),
    item('MLU101', { condition: 'used' }),
  ]);
  assert.equal(report.stats.duplicate_groups, 0);
});

test('ISBN inválido no participa en clusters', () => {
  const report = analyzeEditionClusters([
    item('MLU100', { isbn: '1234' }),
    item('MLU101', { isbn: '1234' }),
  ]);
  assert.equal(report.stats.valid_isbn_items, 0);
  assert.equal(report.stats.duplicate_groups, 0);
});

test('pausados y activos sin stock quedan fuera del detector', () => {
  const report = analyzeEditionClusters([
    item('MLU100', { status: 'paused', available_quantity: 0 }),
    item('MLU101', { available_quantity: 0 }),
    item('MLU102', { isbn: ISBN_B }),
    item('MLU103', { isbn: ISBN_B }),
  ]);
  assert.equal(report.stats.active_in_stock_items, 2);
  assert.equal(report.stats.duplicate_groups, 1);
});

test('el resultado es determinista aunque cambie el orden de entrada', () => {
  const a = [
    item('MLU102', { available_quantity: 2 }),
    item('MLU100', { available_quantity: 1 }),
    item('MLU101', { available_quantity: 2 }),
  ];
  const b = [a[1], a[2], a[0]];
  assert.equal(
    stableReportJson(analyzeEditionClusters(a)),
    stableReportJson(analyzeEditionClusters(b)),
  );
});

test('no muta los ítems de entrada', () => {
  const items = [item('MLU100'), item('MLU101')];
  const before = JSON.stringify(items);
  analyzeEditionClusters(items);
  assert.equal(JSON.stringify(items), before);
});
