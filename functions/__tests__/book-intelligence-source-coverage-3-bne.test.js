import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCoverageResult,
  coverageMarkdown,
} from '../../scripts/seo/book-intelligence-source-coverage-3-bne.mjs';

const classification = {
  tier: 'green',
  reason: 'evidencia corroborada',
  exact_isbn_source_count: 2,
  independent_work_source_count: 2,
  strong_work_source_count: 2,
  identity_conflicts: [],
  generation_policy: { auto_publish_work_content: true },
};

test('resultado de coverage cuenta BNE y evidencia semántica sin publicar texto externo', () => {
  const item = {
    id: 'MLU123',
    isbn: '9788496836693',
    title: 'Padres fuertes, hijas felices',
    author: 'Meg Meeker',
    research: { gsc_impressions: 120, gsc_clicks: 10 },
  };
  const google = [{ source: 'google_books' }];
  const bne = [{
    source: 'library_catalog',
    description: 'x'.repeat(90),
    topics: [],
  }];
  const result = buildCoverageResult(item, classification, google, bne);
  assert.equal(result.google_books_records, 1);
  assert.equal(result.bne_records, 1);
  assert.equal(result.bne_substantive_records, 1);
  assert.equal(result.tier, 'green');
  assert.equal(result.gsc_impressions, 120);
  assert.equal(Object.hasOwn(result, 'description'), false);
});

test('markdown declara Google+BNE, tiers y contrato read-only', () => {
  const report = {
    generated_at: '2026-08-22T00:00:00.000Z',
    cohort: { selected: 12 },
    sources: {
      google_books: { matched: 4, errors: 0 },
      bne: { matched: 6, errors: 0, substantive_matches: 3 },
    },
    classification: { green: 2, yellow: 4, red: 6, auto_publish_work_content: 2 },
    results: [{
      id: 'MLU123', isbn: '9788496836693', gsc_impressions: 120,
      google_books_records: 1, bne_records: 1, bne_substantive_records: 1,
      tier: 'green', reason: 'evidencia corroborada',
    }],
  };
  const markdown = coverageMarkdown(report);
  assert.match(markdown, /SOURCE-COVERAGE-3 BNE/);
  assert.match(markdown, /Google \+ BNE/);
  assert.match(markdown, /Sólo lectura/);
  assert.match(markdown, /No se modifica ninguna ficha/);
  assert.doesNotMatch(markdown, /descripción suficientemente extensa/i);
});
