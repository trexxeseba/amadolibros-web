import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildResearchResult,
  researchMarkdown,
  selectResearchCohort,
} from '../../scripts/seo/book-intelligence-research-run.mjs';

function catalogItem(id, isbn, overrides = {}) {
  return {
    id,
    isbn,
    title: `Título ${id}`,
    author: `Autor ${id}`,
    status: 'paused',
    available_quantity: 0,
    domain_id: 'MLU-BOOKS',
    ...overrides,
  };
}

function cohortItem(id, isbn, impressions, clicks = 0, source = 'gsc-demand') {
  return {
    id,
    isbn,
    source,
    impressions,
    clicks,
    quality_score: 40,
  };
}

test('RESEARCH-RUN-1 selecciona sólo demanda GSC y conserva el orden de la cohorte real', () => {
  const cohort = [
    cohortItem('MLU1', '9788410301245', 100, 4),
    cohortItem('MLU2', '9789878629933', 80, 3),
    cohortItem('MLU3', '9789876282703', 0, 0, 'catalog-quality'),
    cohortItem('MLU4', '9786073121958', 20, 1),
  ];
  const catalogItems = [
    catalogItem('MLU1', '9788410301245'),
    catalogItem('MLU2', '9789878629933'),
    catalogItem('MLU3', '9789876282703'),
    catalogItem('MLU4', '9786073121958'),
  ];

  const result = selectResearchCohort({ cohort, catalogItems, limit: 3 });
  assert.deepEqual(result.selected.map(item => item.id), ['MLU1', 'MLU2', 'MLU4']);
  assert.deepEqual(result.selected.map(item => item.gsc_impressions), [100, 80, 20]);
  assert.equal(result.selected.every(item => item.priority_score === 1), true);
});

test('si una ficha histórica ya no existe en snapshot, la salta y sigue hasta completar el lote', () => {
  const cohort = [
    cohortItem('MLU-MISSING', '9788410301245', 100),
    cohortItem('MLU2', '9789878629933', 80),
    cohortItem('MLU4', '9786073121958', 20),
  ];
  const catalogItems = [
    catalogItem('MLU2', '9789878629933'),
    catalogItem('MLU4', '9786073121958'),
  ];

  const result = selectResearchCohort({ cohort, catalogItems, limit: 2 });
  assert.deepEqual(result.selected.map(item => item.id), ['MLU2', 'MLU4']);
  assert.deepEqual(result.missing_catalog_ids, ['MLU-MISSING']);
});

test('el reporte público expone conteos de fuentes pero nunca descripciones ni tokens', () => {
  const item = catalogItem('MLU1', '9788410301245', {
    research: { gsc_impressions: 12, gsc_clicks: 2, quality_score: 40 },
  });
  const classification = {
    tier: 'green',
    reason: 'multi_source_exact_identity',
    availability: 'by_request',
    exact_isbn_source_count: 2,
    independent_work_source_count: 2,
    strong_work_source_count: 2,
    identity_conflicts: [],
    edition_fact_conflicts: [],
    generation_policy: {
      can_generate_work_content: true,
      can_auto_publish_work_content: true,
      can_generate_five_topics: true,
      can_generate_audience: true,
      can_generate_author_context: true,
    },
  };
  const cache = {
    entries: {
      '9788410301245': {
        google_books: {
          fetched_at: '2026-08-22T12:00:00.000Z',
          error: null,
          records: [{ description: 'texto externo que no debe salir en resumen' }],
        },
        open_library: {
          fetched_at: '2026-08-22T12:00:00.000Z',
          error: null,
          records: [{ description: 'otro texto externo' }],
        },
      },
    },
  };

  const result = buildResearchResult(item, classification, cache);
  const serialized = JSON.stringify(result);
  assert.equal(result.sources.google_books.record_count, 1);
  assert.equal(result.sources.open_library.record_count, 1);
  assert.equal(serialized.includes('texto externo'), false);
  assert.equal(serialized.includes('token'), false);
});

test('resumen markdown deja explícito que la corrida no toca Producción', () => {
  const report = {
    generated_at: '2026-08-22T12:00:00.000Z',
    cohort: { selected: 2 },
    catalog: { total_items: 17000 },
    sources: {
      google_books: { matched: 2, errors: 0 },
      open_library: { matched: 1, errors: 0 },
    },
    classification: {
      green: 1,
      yellow: 1,
      red: 0,
      auto_publish_work_content: 1,
      identity_conflicts: 0,
    },
    results: [
      {
        id: 'MLU1', isbn: '9788410301245', gsc_impressions: 12,
        sources: { google_books: { record_count: 1 }, open_library: { record_count: 1 } },
        tier: 'green', reason: 'multi_source_exact_identity',
      },
      {
        id: 'MLU2', isbn: '9789878629933', gsc_impressions: 5,
        sources: { google_books: { record_count: 1 }, open_library: { record_count: 0 } },
        tier: 'yellow', reason: 'single_strong_source',
      },
    ],
  };

  const markdown = researchMarkdown(report);
  assert.match(markdown, /RESEARCH-RUN-1/);
  assert.match(markdown, /GREEN 1, YELLOW 1, RED 0/);
  assert.match(markdown, /No se modifica ninguna ficha pública/);
  assert.match(markdown, /Producción/);
});
