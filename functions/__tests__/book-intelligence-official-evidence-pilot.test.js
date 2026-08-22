import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BOOK_EVIDENCE_SOURCE_POLICY,
  classifyBookIntelligenceEvidence,
} from '../_shared/book-intelligence-evidence.js';
import {
  OFFICIAL_EVIDENCE_BY_ISBN,
  OFFICIAL_EVIDENCE_PILOT_ISBNS,
  officialEvidenceForIsbn,
} from '../../scripts/seo/book-intelligence-official-evidence-pilot-data.mjs';
import {
  buildPilotResult,
  pilotMarkdown,
} from '../../scripts/seo/book-intelligence-official-evidence-pilot-run.mjs';

const ITEMS = Object.freeze({
  '9791387869380': {
    id: 'MLU1416777650', isbn: '9791387869380',
    title: 'Libro Murdoku: 80 Acertijos De Lógica Y Asesinatos, De Garand, Manuel, Vol. 1. Editorial Temas Hoy, Tapa Blanda (2025)',
    author: 'Manuel Garand', status: 'paused', available_quantity: 0,
  },
  '9798181647725': {
    id: 'MLU1472001988', isbn: '9798181647725',
    title: 'Sopicidios 80 Crímenes En Sopas De Letras - Vergel',
    author: 'Daniel Vergel', status: 'paused', available_quantity: 0,
  },
  '9789878629933': {
    id: 'MLU692066314', isbn: '9789878629933',
    title: '30 Chispas De Luz Reflexiones Cabalisticas Cabala Saban',
    author: 'SABAN MARIO JAVIER', status: 'paused', available_quantity: 0,
  },
  '9791387781323': {
    id: 'MLU1001329818', isbn: '9791387781323',
    title: 'My Hero Academia 42 Edicion Especial Cofre, De Kohei Horikoshi. Editorial Planeta Cómic (2025)',
    author: 'KOHEI HORIKOSHI', status: 'paused', available_quantity: 0,
  },
  '9782017312703': {
    id: 'MLU1224447122', isbn: '9782017312703',
    title: 'Libro Colorea Y Descubre El Misterio Los Ositos Cariñosos, De Eugénie Varone. Editorial Hachette Little Heroes, Tapa Blanda, En Francés',
    author: 'Varone, Eugénie', status: 'paused', available_quantity: 0,
  },
  '9789878675701': {
    id: 'MLU616917519', isbn: '9789878675701',
    title: 'Libro - El Legado - German Beder',
    author: 'Beder, German', status: 'paused', available_quantity: 0,
  },
  '9788416894864': {
    id: 'MLU709076232', isbn: '9788416894864',
    title: 'La Jubilación Una Nueva Oportunidad - Bartolomé Freire',
    author: 'Freire Arteta, Bartolomé', status: 'paused', available_quantity: 0,
  },
});

function substantiveGoogleExact(item, topics = ['tema uno', 'tema dos', 'tema tres']) {
  return {
    source: 'google_books',
    source_id: `google-${item.id}`,
    source_url: 'https://books.google.com/',
    isbn: item.isbn,
    title: item.title,
    author: item.author,
    topics,
  };
}

test('piloto contiene exactamente siete ISBN seleccionados y todos existen en fixtures', () => {
  assert.equal(OFFICIAL_EVIDENCE_PILOT_ISBNS.length, 7);
  assert.deepEqual(new Set(OFFICIAL_EVIDENCE_PILOT_ISBNS), new Set(Object.keys(ITEMS)));
});

test('cada registro usa una familia admitida, URL HTTPS y fecha de verificación', () => {
  for (const [targetIsbn, records] of Object.entries(OFFICIAL_EVIDENCE_BY_ISBN)) {
    assert.ok(records.length >= 1, targetIsbn);
    for (const record of records) {
      assert.ok(BOOK_EVIDENCE_SOURCE_POLICY[record.source], `${targetIsbn}: source inválida`);
      assert.match(record.source_url, /^https:\/\//, `${targetIsbn}: URL no HTTPS`);
      assert.equal(record.verified_at, '2026-08-22');
      assert.ok(record.source_provider);
    }
  }
});

test('snapshot no guarda sinopsis largas ni copy externo', () => {
  for (const records of Object.values(OFFICIAL_EVIDENCE_BY_ISBN)) {
    for (const record of records) {
      assert.equal(record.description, undefined);
      assert.equal(record.summary, undefined);
      assert.equal(record.author_context, undefined);
      assert.ok((record.audience || '').length <= 100);
      assert.ok(record.topics.length <= 8);
      for (const topic of record.topics) assert.ok(topic.length <= 60, topic);
    }
  }
});

test('otra edición nunca hereda el ISBN objetivo: 30 Chispas conserva 9788494017513', () => {
  const records = officialEvidenceForIsbn('9789878629933');
  const jojma = records.find(record => record.source_provider === 'jojma_ediciones');
  const continente = records.find(record => record.source_provider === 'ediciones_continente');
  assert.equal(jojma.isbn, '9788494017513');
  assert.notEqual(jojma.isbn, '9789878629933');
  assert.equal(continente.isbn, '9789878629933');
});

test('curated-only: Murdoku, Sopicidios, My Hero y Bisounours alcanzan yellow sin fabricar green', () => {
  for (const isbn of ['9791387869380', '9798181647725', '9791387781323', '9782017312703']) {
    const result = classifyBookIntelligenceEvidence(ITEMS[isbn], officialEvidenceForIsbn(isbn));
    assert.equal(result.tier, 'yellow', `${isbn}: ${result.reason}`);
    assert.equal(result.generation_policy.can_generate_work_content, true);
    assert.equal(result.generation_policy.can_auto_publish_work_content, false);
  }
});

test('30 Chispas alcanza green por dos familias reales sin auto-publicar páginas de otra edición', () => {
  const item = ITEMS['9789878629933'];
  const result = classifyBookIntelligenceEvidence(item, officialEvidenceForIsbn(item.isbn));
  assert.equal(result.tier, 'green');
  assert.equal(result.independent_work_source_count, 2);
  assert.equal(result.strong_work_source_count, 1);
  assert.equal(result.edition_facts.pages.value, 132);
  assert.equal(result.edition_fields_auto_publishable.pages, false);
  assert.equal(result.edition_fields_auto_publishable.publisher, false);
});

test('El Legado y La Jubilación pasan a green cuando se combinan con Google exacto sustantivo', () => {
  for (const isbn of ['9789878675701', '9788416894864']) {
    const item = ITEMS[isbn];
    const baseline = classifyBookIntelligenceEvidence(item, [substantiveGoogleExact(item)]);
    const finalResult = classifyBookIntelligenceEvidence(item, [
      substantiveGoogleExact(item),
      ...officialEvidenceForIsbn(isbn),
    ]);
    assert.equal(baseline.tier, 'yellow');
    assert.equal(finalResult.tier, 'green');
    assert.equal(finalResult.independent_work_source_count, 2);
  }
});

test('Bisounours: una fuente oficial exacta con autor compatible resuelve el falso conflicto de título', () => {
  const item = ITEMS['9782017312703'];
  const googleWithoutAuthor = {
    source: 'google_books',
    isbn: item.isbn,
    title: 'Care Bears mystery colouring book',
    author: '',
    topics: [],
  };
  const baseline = classifyBookIntelligenceEvidence(item, [googleWithoutAuthor]);
  const finalResult = classifyBookIntelligenceEvidence(item, [
    googleWithoutAuthor,
    ...officialEvidenceForIsbn(item.isbn),
  ]);
  assert.equal(baseline.tier, 'red');
  assert.equal(baseline.reason, 'identity_conflict');
  assert.equal(finalResult.identity_conflicts.length, 0);
  assert.equal(finalResult.tier, 'yellow');
});

test('My Hero: datos físicos exactos del distribuidor siguen sin auto-publicarse por confianza insuficiente', () => {
  const item = ITEMS['9791387781323'];
  const result = classifyBookIntelligenceEvidence(item, officialEvidenceForIsbn(item.isbn));
  assert.equal(result.edition_facts.pages.value, 184);
  assert.equal(result.edition_fields_auto_publishable.pages, false);
  assert.equal(result.edition_fields_auto_publishable.publisher, false);
});

test('resultado y markdown reportan el cambio sin incorporar contenido externo', () => {
  const item = { ...ITEMS['9789878675701'], research: { gsc_impressions: 7, gsc_clicks: 0 } };
  const google = [substantiveGoogleExact(item)];
  const official = [...officialEvidenceForIsbn(item.isbn)];
  const baseline = classifyBookIntelligenceEvidence(item, google);
  const finalResult = classifyBookIntelligenceEvidence(item, [...google, ...official]);
  const row = buildPilotResult(item, google, official, baseline, finalResult);
  assert.equal(row.baseline_tier, 'yellow');
  assert.equal(row.final_tier, 'green');
  assert.equal(Object.hasOwn(row, 'description'), false);

  const markdown = pilotMarkdown({
    generated_at: '2026-08-22T00:00:00.000Z',
    cohort: { selected: 12 },
    sources: {
      official: { targeted_isbns: 7 },
      google_books: { matched: 4, errors: 0 },
    },
    classification: {
      before: { green: 0, yellow: 2, red: 10 },
      after: { green: 3, yellow: 4, red: 5 },
    },
    impact: {
      tier_upgrades: 7, red_to_yellow: 4, red_to_green: 1, yellow_to_green: 2,
      generable_before: 2, generable_after: 7,
      auto_publish_before: 0, auto_publish_after: 3,
      five_topics_before: 0, five_topics_after: 7,
      identity_conflicts_before: 1, identity_conflicts_after: 0,
    },
    results: [row],
  });
  assert.match(markdown, /No se copian sinopsis externas/);
  assert.match(markdown, /Otra edición conserva su ISBN real/);
  assert.match(markdown, /YELLOW → GREEN: 2/);
});
