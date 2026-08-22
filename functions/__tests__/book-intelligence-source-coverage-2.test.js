import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCoverageResult,
  coverageMarkdown,
} from '../../scripts/seo/book-intelligence-source-coverage-2.mjs';

const ISBN = '9789878675701';

function item() {
  return {
    id: 'MLU1',
    isbn: ISBN,
    title: 'El legado',
    author: 'Beder, German',
    research: { gsc_impressions: 7, gsc_clicks: 0 },
  };
}

function classification() {
  return {
    tier: 'green',
    reason: 'multi_source_exact_identity',
    exact_isbn_source_count: 2,
    independent_work_source_count: 2,
    strong_work_source_count: 2,
    identity_conflicts: [],
    generation_policy: {
      can_generate_work_content: true,
      can_auto_publish_work_content: true,
      can_generate_five_topics: true,
      can_generate_audience: false,
      can_generate_author_context: false,
    },
  };
}

test('resultado de coverage publica conteos, no texto externo', () => {
  const result = buildCoverageResult(
    item(),
    classification(),
    [{ source: 'google_books', description: 'Descripción externa que no debe salir.' }],
    [{
      source: 'library_catalog',
      description: 'Resumen bibliográfico externo que tampoco debe salir.',
      topics: ['Tema 1', 'Tema 2', 'Tema 3'],
    }],
  );
  assert.equal(result.google_books_records, 1);
  assert.equal(result.library_of_congress_records, 1);
  assert.equal(result.library_of_congress_substantive_records, 1);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('Descripción externa'), false);
  assert.equal(serialized.includes('Resumen bibliográfico externo'), false);
});

test('markdown declara fuentes, tiers y contrato sin Producción', () => {
  const report = {
    generated_at: '2026-08-22T12:00:00.000Z',
    cohort: { selected: 1 },
    sources: {
      google_books: { matched: 1, errors: 0 },
      library_of_congress: { matched: 1, substantive_matches: 1, errors: 0 },
    },
    classification: { green: 1, yellow: 0, red: 0, auto_publish_work_content: 1 },
    results: [{
      id: 'MLU1',
      isbn: ISBN,
      gsc_impressions: 7,
      google_books_records: 1,
      library_of_congress_records: 1,
      library_of_congress_substantive_records: 1,
      tier: 'green',
      reason: 'multi_source_exact_identity',
    }],
  };
  const markdown = coverageMarkdown(report);
  assert.match(markdown, /SOURCE-COVERAGE-2/);
  assert.match(markdown, /Library of Congress/);
  assert.match(markdown, /GREEN 1, YELLOW 0, RED 0/);
  assert.match(markdown, /No se modifica ninguna ficha/);
  assert.match(markdown, /Producción/);
});
