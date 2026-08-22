import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCanonicalPilotPair } from '../../scripts/seo/canonical-pilot-preflight.mjs';

function page(overrides = {}) {
  return {
    id: 'MLU1',
    url: 'https://www.amadolibros.com/libro/MLU1/test',
    statusCode: 200,
    indexable: true,
    selfCanonical: true,
    indexVerdict: 'PASS',
    coverageState: 'Submitted and indexed',
    orphan: false,
    internalLinks: 20,
    wordCount: 300,
    impressions28d: 2,
    ...overrides,
  };
}

function pair(overrides = {}) {
  return {
    name: 'Pilot pair',
    isbn: '9780194527552',
    mlOrigin: 'ml_common_plus_catalog',
    sameCatalogProductId: true,
    sameCondition: true,
    sameTitleAuthor: true,
    languageConflict: false,
    target: page({ id: 'MLU1' }),
    source: page({ id: 'MLU2', url: 'https://www.amadolibros.com/libro/MLU2/test' }),
    ...overrides,
  };
}

test('habilita propuesta de canonical en Preview cuando pasan todos los gates', () => {
  const result = evaluateCanonicalPilotPair(pair());
  assert.equal(result.status, 'ready_for_preview_canonical_proposal');
  assert.deepEqual(result.blockers, []);
  assert.ok(result.warnings.includes('both_urls_currently_indexed'));
});

test('bloquea un target huérfano del grafo interno', () => {
  const p = pair();
  p.target = page({ id: 'MLU1', orphan: true });
  const result = evaluateCanonicalPilotPair(p);
  assert.equal(result.status, 'blocked');
  assert.ok(result.blockers.includes('target_orphan'));
});

test('bloquea conflicto estructural de título/autor o idioma', () => {
  const result = evaluateCanonicalPilotPair(pair({ sameTitleAuthor: false, languageConflict: true }));
  assert.equal(result.status, 'blocked');
  assert.ok(result.blockers.includes('title_author_mismatch'));
  assert.ok(result.blockers.includes('language_conflict'));
});

test('bloquea un destino no indexado o no self-canonical', () => {
  const p = pair();
  p.target = page({ id: 'MLU1', indexVerdict: 'NEUTRAL', coverageState: 'Crawled - currently not indexed', selfCanonical: false });
  const result = evaluateCanonicalPilotPair(p);
  assert.equal(result.status, 'blocked');
  assert.ok(result.blockers.includes('target_not_indexed'));
  assert.ok(result.blockers.includes('target_not_submitted_and_indexed'));
  assert.ok(result.blockers.includes('target_not_self_canonical'));
});

test('marca como señal favorable si Google ya trata la fuente como duplicada', () => {
  const p = pair();
  p.source = page({
    id: 'MLU2',
    url: 'https://www.amadolibros.com/libro/MLU2/test',
    indexVerdict: 'NEUTRAL',
    coverageState: 'Duplicate, Google chose different canonical than user',
  });
  const result = evaluateCanonicalPilotPair(p);
  assert.equal(result.status, 'ready_for_preview_canonical_proposal');
  assert.ok(result.warnings.includes('google_already_treats_source_as_duplicate'));
  assert.ok(!result.warnings.includes('both_urls_currently_indexed'));
});

test('bloquea si source y target son la misma publicación', () => {
  const p = pair();
  p.source = page({ id: 'MLU1', url: p.target.url });
  const result = evaluateCanonicalPilotPair(p);
  assert.equal(result.status, 'blocked');
  assert.ok(result.blockers.includes('source_equals_target'));
});
