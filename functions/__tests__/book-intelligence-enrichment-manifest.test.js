import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyBookIntelligenceEvidence } from '../_shared/book-intelligence-evidence.js';
import {
  buildBookIntelligenceManifest,
  buildBookIntelligenceManifestEntry,
} from '../../scripts/seo/book-intelligence-enrichment-manifest.mjs';
import { officialEvidenceForIsbn } from '../../scripts/seo/book-intelligence-official-evidence-pilot-data.mjs';

const MURDOKU = {
  id: 'MLU1416777650', isbn: '9791387869380',
  title: 'Libro Murdoku: 80 Acertijos De Lógica Y Asesinatos, De Garand, Manuel, Vol. 1. Editorial Temas Hoy, Tapa Blanda (2025)',
  author: 'Manuel Garand', status: 'paused', available_quantity: 0,
};

const CHISPAS = {
  id: 'MLU692066314', isbn: '9789878629933',
  title: '30 Chispas De Luz Reflexiones Cabalisticas Cabala Saban',
  author: 'SABAN MARIO JAVIER', status: 'paused', available_quantity: 0,
};

const LEGADO = {
  id: 'MLU616917519', isbn: '9789878675701',
  title: 'Libro - El Legado - German Beder',
  author: 'Beder, German', status: 'paused', available_quantity: 0,
};

function googleExact(item, overrides = {}) {
  return {
    source: 'google_books',
    source_id: `google-${item.id}`,
    source_url: 'https://books.google.com/',
    isbn: item.isbn,
    title: item.title,
    author: item.author,
    description: 'Descripción externa que nunca debe entrar al manifest. '.repeat(4),
    topics: ['tema google uno', 'tema google dos', 'tema google tres'],
    publisher: 'Editorial Google',
    pages: 321,
    language: 'es',
    publication_year: '2020',
    format: 'BOOK',
    ...overrides,
  };
}

test('GREEN produce auto_publish; temas salen sólo de evidencia oficial curada', () => {
  const official = [...officialEvidenceForIsbn(LEGADO.isbn)];
  const google = googleExact(LEGADO);
  const classification = classifyBookIntelligenceEvidence(LEGADO, [google, ...official]);
  assert.equal(classification.tier, 'green');

  const entry = buildBookIntelligenceManifestEntry({
    item: LEGADO,
    classification,
    officialRecords: official,
    allRecords: [google, ...official],
  });

  assert.equal(entry.decision, 'auto_publish');
  assert.equal(entry.work.auto_publish, true);
  assert.ok(entry.work.topic_seeds.length >= 5);
  assert.ok(entry.work.topic_seeds.every(topic => !topic.startsWith('tema google')));
  assert.equal(JSON.stringify(entry).includes('Descripción externa'), false);
  assert.ok(entry.provenance.some(source => source.source === 'google_books'));
  assert.ok(entry.provenance.some(source => source.provider === 'basquet_plus'));
});

test('YELLOW produce review y puede conservar hechos de edición explícitamente auto-publicables', () => {
  const official = [...officialEvidenceForIsbn(MURDOKU.isbn)];
  const classification = classifyBookIntelligenceEvidence(MURDOKU, official);
  assert.equal(classification.tier, 'yellow');

  const entry = buildBookIntelligenceManifestEntry({
    item: MURDOKU,
    classification,
    officialRecords: official,
    allRecords: official,
  });

  assert.equal(entry.decision, 'review');
  assert.equal(entry.work.auto_publish, false);
  assert.equal(entry.work.review_required, true);
  assert.equal(entry.edition.auto_publishable_fields.pages.value, 208);
  assert.equal(entry.edition.auto_publishable_fields.publisher.value, 'Temas de Hoy');
  assert.ok(entry.edition.auto_publishable_fields.pages.provenance.every(source => source.relationship === 'exact_edition'));
});

test('GREEN por obra no convierte hechos físicos de distribuidor trust=3 en auto-publicables', () => {
  const official = [...officialEvidenceForIsbn(CHISPAS.isbn)];
  const classification = classifyBookIntelligenceEvidence(CHISPAS, official);
  assert.equal(classification.tier, 'green');

  const entry = buildBookIntelligenceManifestEntry({
    item: CHISPAS,
    classification,
    officialRecords: official,
    allRecords: official,
  });

  assert.equal(entry.decision, 'auto_publish');
  assert.deepEqual(entry.edition.auto_publishable_fields, {});
  assert.ok(entry.provenance.some(source => source.provider === 'ediciones_continente' && source.trust === 3));
  assert.ok(entry.provenance.some(source => source.provider === 'jojma_ediciones' && source.relationship === 'same_work'));
});

test('RED produce hold y nunca transporta temas, audiencia ni hechos de edición', () => {
  const item = {
    id: 'MLU999', isbn: '9789878372839', title: 'La otra práctica clínica',
    author: 'Autor de prueba', status: 'paused', available_quantity: 0,
  };
  const google = googleExact(item, {
    author: 'Persona incompatible',
    publisher: 'Editorial externa',
    pages: 777,
  });
  const classification = classifyBookIntelligenceEvidence(item, [google]);
  assert.equal(classification.tier, 'red');

  const entry = buildBookIntelligenceManifestEntry({
    item,
    classification,
    officialRecords: [{
      source: 'publisher', source_provider: 'fake-for-test', source_url: 'https://example.com/',
      isbn: item.isbn, title: item.title, author: item.author,
      topics: ['uno', 'dos', 'tres', 'cuatro', 'cinco'], audience: 'audiencia explícita suficientemente larga para probar el hold',
    }],
    allRecords: [google],
  });

  assert.equal(entry.decision, 'hold');
  assert.deepEqual(entry.work.topic_seeds, []);
  assert.equal(entry.work.audience_seed, null);
  assert.deepEqual(entry.edition.auto_publishable_fields, {});
  assert.equal(entry.work.auto_publish, false);
});

test('provenance queda compacta, HTTPS y determinista aunque cambie el orden de evidencia', () => {
  const official = [...officialEvidenceForIsbn(CHISPAS.isbn)];
  const classification = classifyBookIntelligenceEvidence(CHISPAS, official);
  const a = buildBookIntelligenceManifestEntry({
    item: CHISPAS, classification, officialRecords: official, allRecords: official,
  });
  const reversed = [...official].reverse();
  const b = buildBookIntelligenceManifestEntry({
    item: CHISPAS, classification, officialRecords: reversed, allRecords: reversed,
  });
  assert.deepEqual(a.provenance, b.provenance);
  assert.ok(a.provenance.every(source => source.url === null || source.url.startsWith('https://')));
  assert.ok(a.provenance.every(source => !Object.hasOwn(source, 'description')));
});

test('manifest global ordena por MLU y agrega decisiones sin guardar prosa externa', () => {
  const officialM = [...officialEvidenceForIsbn(MURDOKU.isbn)];
  const officialC = [...officialEvidenceForIsbn(CHISPAS.isbn)];
  const m = buildBookIntelligenceManifestEntry({
    item: MURDOKU,
    classification: classifyBookIntelligenceEvidence(MURDOKU, officialM),
    officialRecords: officialM,
    allRecords: officialM,
  });
  const c = buildBookIntelligenceManifestEntry({
    item: CHISPAS,
    classification: classifyBookIntelligenceEvidence(CHISPAS, officialC),
    officialRecords: officialC,
    allRecords: officialC,
  });
  const manifest = buildBookIntelligenceManifest([m, c], {
    generatedAt: '2026-08-22T00:00:00.000Z',
    catalogVersion: 'test-version',
  });

  assert.equal(manifest.counts.total, 2);
  assert.equal(manifest.counts.auto_publish, 1);
  assert.equal(manifest.counts.review, 1);
  assert.equal(manifest.counts.hold, 0);
  assert.deepEqual(manifest.entries.map(entry => entry.product_id), ['MLU1416777650', 'MLU692066314']);
  const serialized = JSON.stringify(manifest);
  assert.doesNotMatch(serialized, /description/i);
  assert.doesNotMatch(serialized, /summary/i);
  assert.doesNotMatch(serialized, /author_context/i);
});

test('builder valida tipos y una tier desconocida cae a hold', () => {
  assert.throws(() => buildBookIntelligenceManifestEntry(), /item debe ser un objeto/);
  assert.throws(() => buildBookIntelligenceManifestEntry({ item: {} }), /classification debe ser un objeto/);
  const entry = buildBookIntelligenceManifestEntry({
    item: { id: 'MLU1', isbn: '9789878372839' },
    classification: { tier: 'mystery', generation_policy: {} },
  });
  assert.equal(entry.tier, 'red');
  assert.equal(entry.decision, 'hold');
});
