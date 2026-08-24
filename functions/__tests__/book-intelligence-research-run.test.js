import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildResearchResult,
  buildVerifiedFactsManifest,
  mapWithConcurrency,
  publicationClass,
  researchMarkdown,
  selectResearchCohort,
} from '../../scripts/seo/book-intelligence-research-run.mjs';

const ISBN_A = '9788496836693';
const ISBN_B = '9780194527552';
const ISBN_C = '9788410301245';

function catalogItem(id, isbn, overrides = {}) {
  return {
    id,
    isbn,
    title: `Titulo ${id}`,
    author: `Autor ${id}`,
    status: 'active',
    available_quantity: 2,
    price: 990,
    currency_id: 'UYU',
    condition: 'new',
    domain_id: 'MLU-BOOKS',
    description: '',
    pictures: ['https://images.test/cover.jpg'],
    ...overrides,
  };
}

function classification(overrides = {}) {
  return {
    tier: 'red',
    reason: 'insufficient_evidence',
    exact_isbn_source_count: 0,
    independent_work_source_count: 0,
    identity_conflicts: [],
    edition_fact_conflicts: [],
    edition_facts: {},
    edition_fields_auto_publishable: {},
    work_facts: { topics: [] },
    work_fields_auto_publishable: { topics: false },
    generation_policy: { can_auto_publish_work_content: false },
    ...overrides,
  };
}

test('selecciona ISBN activos unicos, excluye enriquecidos y prioriza brechas', () => {
  const result = selectResearchCohort({
    catalogItems: [
      catalogItem('MLU1', ISBN_A, { description: 'x'.repeat(900) }),
      catalogItem('MLU2', ISBN_B, { available_quantity: 1 }),
      catalogItem('MLU3', ISBN_B, { available_quantity: 8 }),
      catalogItem('MLU4', ISBN_C, { available_quantity: 20 }),
    ],
    existingEnrichments: [{ isbn: ISBN_C }],
    limit: 2,
  });

  assert.equal(result.selected.length, 2);
  assert.equal(result.eligible_unique_isbns, 2);
  assert.equal(result.excluded_already_enriched, 1);
  assert.equal(result.selected[0].isbn, ISBN_B);
  assert.equal(result.selected[0].id, 'MLU3');
  assert.deepEqual(result.selected[0].listing_ids, ['MLU2', 'MLU3']);
});

test('temas oficiales cuentan como mejora SEO cuando la edición no los tenía', () => {
  const result = buildResearchResult(catalogItem('MLU1', ISBN_A), classification({
    work_facts: { topics: ['Educación', 'Familia'] },
    work_fields_auto_publishable: { topics: true },
  }), {});
  assert.deepEqual(result.verified_facts, { topics: ['Educación', 'Familia'] });
  assert.equal(result.publication_class, 'GREEN_FACTS');
});

test('falla si no existen suficientes ISBN vendibles para cumplir el contrato', () => {
  assert.throws(() => selectResearchCohort({
    catalogItems: [catalogItem('MLU1', ISBN_A)],
    limit: 2,
  }), /1\/2/);
});

test('separa full, facts, review y sin evidencia', () => {
  assert.equal(publicationClass(classification({
    edition_facts: { pages: { value: 320 } },
    edition_fields_auto_publishable: { pages: true },
    generation_policy: { can_auto_publish_work_content: true },
  })), 'GREEN_FULL');
  assert.equal(publicationClass(classification({
    edition_facts: { pages: { value: 320 } },
    edition_fields_auto_publishable: { pages: true },
  })), 'GREEN_FACTS');
  assert.equal(publicationClass(classification({
    identity_conflicts: [{ field: 'title' }],
  })), 'REVIEW');
  assert.equal(publicationClass(classification({
    identity_conflicts: [{ field: 'title' }],
    edition_facts: { pages: { value: 320 } },
    edition_fields_auto_publishable: { pages: true },
  })), 'GREEN_FACTS');
  assert.equal(publicationClass(classification()), 'NO_EVIDENCE');
});

test('sólo cuenta una mejora cuando completa un dato ausente', () => {
  const result = buildResearchResult(
    catalogItem('MLU1', ISBN_A, { pages: 320 }),
    classification({
      edition_facts: { pages: { value: 320 } },
      edition_fields_auto_publishable: { pages: true },
    }),
    {},
  );
  assert.deepEqual(result.verified_facts, {});
  assert.equal(result.publication_class, 'NO_EVIDENCE');
});

test('un ISBN cuenta cuando completa un duplicado aunque el representante ya tenga el dato', () => {
  const cohort = selectResearchCohort({
    catalogItems: [
      catalogItem('MLU1', ISBN_A, { author: 'Meg Meeker', available_quantity: 9 }),
      catalogItem('MLU2', ISBN_A, { author: 'Desconocido', available_quantity: 1 }),
    ],
    limit: 1,
  });
  assert.equal(cohort.selected[0].id, 'MLU1');
  assert.equal(cohort.selected[0].research.missing_fields.includes('author'), true);
  const result = buildResearchResult(cohort.selected[0], classification({
    edition_facts: { author: { value: 'Meg Meeker' } },
    edition_fields_auto_publishable: { author: true },
  }), {});
  assert.deepEqual(result.verified_facts, { author: 'Meg Meeker' });
  assert.equal(result.publication_class, 'GREEN_FACTS');
});

test('resultado publico conserva hechos pero nunca vuelca texto fuente', () => {
  const item = catalogItem('MLU1', ISBN_A, {
    listing_ids: ['MLU1'], listing_count: 1, total_stock: 2, priority_score: 10,
  });
  const cache = {
    entries: {
      [ISBN_A]: {
        google_books: {
          fetched_at: '2026-08-24T12:00:00.000Z', error: null,
          records: [{ description: 'sinopsis externa que no debe salir' }],
        },
      },
    },
  };
  const result = buildResearchResult(item, classification({
    exact_isbn_source_count: 1,
    edition_facts: { pages: { value: 320 } },
    edition_fields_auto_publishable: { pages: true },
  }), cache);

  assert.deepEqual(result.verified_facts, { pages: 320 });
  assert.equal(result.publication_class, 'GREEN_FACTS');
  assert.equal(JSON.stringify(result).includes('sinopsis externa'), false);
});

test('manifiesto conserva las 4 decisiones y no incluye datos comerciales', () => {
  const base = {
    id: 'MLU1', isbn: ISBN_A, title: 'Libro', author: 'Autora',
    listing_ids: ['MLU1'], publication_class: 'GREEN_FACTS', verified_facts: { pages: 320 },
    exact_isbn_source_count: 2, identity_conflicts: [], edition_fact_conflicts: [],
    sources: { google_books: { record_count: 1 }, open_library: { record_count: 1 }, bne: { record_count: 0 } },
  };
  const manifest = buildVerifiedFactsManifest({
    generated_at: '2026-08-24T12:00:00.000Z',
    cohort: { requested: 1, selected: 1 },
    publication: { GREEN_FULL: 0, GREEN_FACTS: 1, REVIEW: 0, NO_EVIDENCE: 0 },
    results: [base],
  });
  const serialized = JSON.stringify(manifest);
  assert.equal(manifest.entries.length, 1);
  assert.equal(manifest.entries[0].decision, 'GREEN_FACTS');
  assert.equal(serialized.includes('price'), false);
  assert.equal(serialized.includes('available_quantity'), false);
  assert.equal(serialized.includes('canonical'), false);
});

test('concurrencia queda limitada aunque el lote sea grande', async () => {
  let active = 0;
  let maximum = 0;
  const result = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async value => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active--;
    return value * 2;
  });
  assert.equal(maximum, 2);
  assert.deepEqual(result, [2, 4, 6, 8, 10, 12]);
});

test('resumen declara 1.000 y deja claro que no despliega Produccion', () => {
  const markdown = researchMarkdown({
    generated_at: '2026-08-24T12:00:00.000Z',
    cohort: { requested: 1000, selected: 1000, eligible_unique_isbns: 3500 },
    sources: {
      google_books: { matched: 400, errors: 0 },
      open_library: { matched: 100, errors: 0 },
      bne: { matched: 80, errors: 0 },
    },
    publication: { GREEN_FULL: 20, GREEN_FACTS: 300, REVIEW: 10, NO_EVIDENCE: 670 },
  });
  assert.match(markdown, /Meta: 1000 ISBN/);
  assert.match(markdown, /Investigados: 1000 ISBN/);
  assert.match(markdown, /GREEN_FACTS: 300/);
  assert.match(markdown, /no despliega Produccion/i);
});
