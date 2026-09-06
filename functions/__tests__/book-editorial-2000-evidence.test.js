import test from 'node:test';
import assert from 'node:assert/strict';

import { emptySourceCache } from '../../scripts/seo/book-intelligence-sources.mjs';
import {
  assertEvidenceReport,
  buildEditorialEvidenceReport,
  classifyEditorialInput,
} from '../../scripts/seo/book-editorial-2000-evidence.mjs';
import {
  buildEditorialBatchPlan,
  titleFingerprint,
} from '../../scripts/seo/book-editorial-2000-plan.mjs';

function isbnFor(index) {
  const base = `978${String(index).padStart(9, '0')}`;
  const sum = [...base].reduce(
    (total, digit, position) => total + Number(digit) * (position % 2 === 0 ? 1 : 3),
    0,
  );
  return `${base}${(10 - (sum % 10)) % 10}`;
}

function item(index, overrides = {}) {
  return {
    id: `MLU${1100000000 + index}`,
    isbn: isbnFor(index),
    title: `Título comercial ${index}`,
    author: 'Autora Real',
    publisher: 'Editorial Real',
    pages: 224,
    description: '',
    status: 'active',
    available_quantity: 2,
    price: 1490,
    currency_id: 'UYU',
    condition: 'new',
    domain_id: 'MLU-BOOKS',
    ...overrides,
  };
}

test('clasifica como READY_EDITORIAL sólo con contenido sustancial y fuentes contrastadas', () => {
  const result = classifyEditorialInput({
    classification: {
      identity_conflicts: [],
      edition_fact_conflicts: [],
    },
    input: {
      providers: ['google_books', 'national_library'],
      descriptions: [{ characters: 420 }],
      topics: ['Tema específico 1', 'Tema específico 2'],
    },
  });

  assert.equal(result.status, 'READY_EDITORIAL');
});

test('una sola fuente con descripción útil queda parcial y no lista para publicar', () => {
  const result = classifyEditorialInput({
    classification: {
      identity_conflicts: [],
      edition_fact_conflicts: [],
    },
    input: {
      providers: ['google_books'],
      descriptions: [{ characters: 280 }],
      topics: ['Tema específico'],
    },
  });

  assert.equal(result.status, 'PARTIAL_EDITORIAL');
});

test('un conflicto de identidad bloquea aunque haya descripción y temas', () => {
  const result = classifyEditorialInput({
    classification: {
      identity_conflicts: [{ field: 'title' }],
      edition_fact_conflicts: [],
    },
    input: {
      providers: ['google_books', 'national_library'],
      descriptions: [{ characters: 900 }],
      topics: ['Tema 1', 'Tema 2', 'Tema 3'],
    },
  });

  assert.equal(result.status, 'REVIEW_IDENTITY');
});

test('el reporte conserva dos títulos distintos del mismo ISBN sin normalizarlos', () => {
  const isbn = isbnFor(50);
  const catalogItems = [
    item(50, { isbn, title: 'Título comercial A', available_quantity: 3 }),
    item(51, { isbn, title: 'Título comercial B', available_quantity: 1 }),
  ];
  const plan = buildEditorialBatchPlan({
    catalogItems,
    enrichmentRecords: [],
    limit: 1,
    generatedAt: '2026-08-31T12:00:00.000Z',
  });
  const report = buildEditorialEvidenceReport({
    plan,
    catalogItems,
    cache: emptySourceCache(),
    generatedAt: '2026-08-31T12:01:00.000Z',
  });

  assert.equal(assertEvidenceReport(report, 1), true);
  assert.equal(report.results[0].readiness.status, 'NO_EVIDENCE');
  assert.deepEqual(
    report.results[0].title_lock.map(entry => entry.title).sort(),
    ['Título comercial A', 'Título comercial B'],
  );
  assert.equal(report.cohort.titles_changed, 0);
  assert.equal(report.evidence_summary.total, 1);
});

test('el gate rechaza cualquier alteración posterior de una huella de título', () => {
  const catalogItems = [item(70)];
  const plan = buildEditorialBatchPlan({
    catalogItems,
    enrichmentRecords: [],
    limit: 1,
    generatedAt: '2026-08-31T12:00:00.000Z',
  });
  const report = buildEditorialEvidenceReport({
    plan,
    catalogItems,
    cache: emptySourceCache(),
    generatedAt: '2026-08-31T12:01:00.000Z',
  });

  report.results[0].title_lock[0].title = 'Título adulterado';
  assert.notEqual(
    titleFingerprint(report.results[0].title_lock[0].title),
    report.results[0].title_lock[0].sha256,
  );
  assert.throws(() => assertEvidenceReport(report, 1), /título alterado/i);
});
