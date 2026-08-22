import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFallbackResult,
  fallbackMarkdown,
} from '../../scripts/seo/book-intelligence-google-work-fallback-run.mjs';

const item = {
  id: 'MLU123', isbn: '9789878675701', title: 'El legado', author: 'Germán Beder',
  research: { gsc_impressions: 100, gsc_clicks: 8 },
};

function classification(tier, { work = 0, exact = 0, auto = false, generate = false } = {}) {
  return {
    tier,
    reason: tier === 'red' ? 'insufficient_evidence' : 'single_strong_source',
    work_source_count: work,
    independent_work_source_count: work ? 1 : 0,
    strong_work_source_count: work ? 1 : 0,
    exact_isbn_source_count: exact,
    edition_fields_auto_publishable: { publisher: false, pages: false },
    generation_policy: {
      can_generate_work_content: generate,
      can_auto_publish_work_content: auto,
    },
    identity_conflicts: [],
  };
}

test('resultado muestra el upgrade sin copiar descripción externa', () => {
  const result = buildFallbackResult(
    item,
    [],
    [{ description: 'x'.repeat(130), topics: [] }],
    classification('red'),
    classification('yellow', { work: 1, generate: true }),
  );
  assert.equal(result.baseline_tier, 'red');
  assert.equal(result.final_tier, 'yellow');
  assert.equal(result.work_search_substantive_candidates, 1);
  assert.equal(result.accepted_work_source_count, 1);
  assert.equal(Object.hasOwn(result, 'description'), false);
});

test('markdown deja explícita la barrera entre obra y edición', () => {
  const report = {
    generated_at: '2026-08-22T00:00:00.000Z',
    cohort: { selected: 12 },
    sources: {
      exact: { matched: 4 },
      work_fallback: { attempted: 8, http_successes: 8, errors: 0 },
    },
    impact: {
      tier_upgrades: 3,
      red_to_yellow: 3,
      red_to_green: 0,
      generable_before: 2,
      generable_after: 5,
      auto_publish_before: 0,
      auto_publish_after: 0,
    },
    results: [{
      id: 'MLU123', isbn: item.isbn, gsc_impressions: 100,
      exact_records: 0, work_search_candidates: 2, work_search_substantive_candidates: 1,
      baseline_tier: 'red', final_tier: 'yellow',
    }],
  };
  const markdown = fallbackMarkdown(report);
  assert.match(markdown, /título\+autor/);
  assert.match(markdown, /Nunca heredan el ISBN/);
  assert.match(markdown, /Publisher, páginas, formato, año e idioma de otra edición no se publican/);
  assert.match(markdown, /RED → YELLOW: 3/);
});
