import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyBookIntelligenceEvidence } from '../_shared/book-intelligence-evidence.js';
import {
  buildGoogleBooksWorkUrl,
  fetchGoogleBooksWorkEvidence,
  googleWorkIdentity,
  parseGoogleBooksWorkEvidence,
} from '../../scripts/seo/book-intelligence-google-work.mjs';

const ITEM = {
  id: 'MLU123456789',
  isbn: '9789878675701',
  title: 'El legado, de Germán Beder. Editorial Ejemplo, tapa blanda en español',
  author: 'Germán Beder',
  status: 'paused',
  available_quantity: 0,
};

const OTHER_EDITION_ISBN = '9788496836693';

function payload({ description = 'Una descripción extensa '.repeat(8), categories = ['Biografías', 'Deportes', 'Cultura'] } = {}) {
  return {
    items: [{
      id: 'google-volume-1',
      selfLink: 'https://www.googleapis.com/books/v1/volumes/google-volume-1',
      volumeInfo: {
        title: 'El legado',
        authors: ['German Beder'],
        description,
        publisher: 'OTRA EDITORIAL',
        pageCount: 999,
        publishedDate: '2022-01-01',
        language: 'es',
        printType: 'BOOK',
        categories,
        industryIdentifiers: [{ type: 'ISBN_13', identifier: OTHER_EDITION_ISBN }],
      },
    }],
  };
}

test('identidad de búsqueda usa título limpio + autor confiable', () => {
  const identity = googleWorkIdentity(ITEM);
  assert.ok(identity);
  assert.equal(identity.author, 'Germán Beder');
  assert.equal(identity.title, 'El legado');
});

test('no ejecuta fallback si falta autor confiable', () => {
  assert.equal(googleWorkIdentity({ ...ITEM, author: 'Varios' }), null);
  assert.throws(
    () => buildGoogleBooksWorkUrl({ ...ITEM, author: 'Varios' }, { accessToken: 'token' }),
    /título y autor confiables/i,
  );
});

test('URL oficial usa intitle + inauthor y OAuth nunca viaja en query', () => {
  const url = new URL(buildGoogleBooksWorkUrl(ITEM, { accessToken: 'secret-token', maxResults: 10 }));
  assert.equal(url.origin, 'https://www.googleapis.com');
  assert.equal(url.pathname, '/books/v1/volumes');
  assert.match(url.searchParams.get('q'), /intitle:"El legado"/);
  assert.match(url.searchParams.get('q'), /inauthor:"Germán Beder"/);
  assert.equal(url.searchParams.get('projection'), 'full');
  assert.equal(url.searchParams.get('maxResults'), '10');
  assert.equal(url.searchParams.has('key'), false);
  assert.doesNotMatch(url.toString(), /secret-token/);
});

test('parser conserva el ISBN real de la otra edición y contenido semántico', () => {
  const records = parseGoogleBooksWorkEvidence(payload());
  assert.equal(records.length, 1);
  assert.equal(records[0].source, 'google_books');
  assert.equal(records[0].isbn, OTHER_EDITION_ISBN);
  assert.equal(records[0].raw_quality.exact_isbn, false);
  assert.equal(records[0].raw_quality.discovery, 'title_author');
  assert.equal(records[0].publisher, 'OTRA EDITORIAL');
  assert.equal(records[0].pages, 999);
  assert.equal(records[0].topics.length, 3);
});

test('motor canónico acepta contenido de la obra pero NO traslada hechos físicos de otra edición', () => {
  const records = parseGoogleBooksWorkEvidence(payload());
  const result = classifyBookIntelligenceEvidence(ITEM, records);
  assert.equal(result.tier, 'yellow');
  assert.equal(result.reason, 'single_strong_source');
  assert.equal(result.generation_policy.can_generate_work_content, true);
  assert.equal(result.generation_policy.can_auto_publish_work_content, false);
  assert.equal(result.exact_isbn_source_count, 0);
  assert.equal(result.edition_facts.publisher.value, null);
  assert.equal(result.edition_facts.pages.value, null);
  assert.equal(result.edition_fields_auto_publishable.publisher, false);
  assert.equal(result.edition_fields_auto_publishable.pages, false);
});

test('título similar con autor distinto no rescata la obra', () => {
  const records = parseGoogleBooksWorkEvidence({
    items: [{
      id: 'wrong-author',
      volumeInfo: {
        title: 'El legado',
        authors: ['Otra Persona'],
        description: 'Una descripción suficientemente extensa '.repeat(6),
        categories: ['Tema 1', 'Tema 2', 'Tema 3'],
        industryIdentifiers: [{ type: 'ISBN_13', identifier: OTHER_EDITION_ISBN }],
      },
    }],
  });
  const result = classifyBookIntelligenceEvidence(ITEM, records);
  assert.equal(result.tier, 'red');
  assert.equal(result.work_source_count, 0);
});

test('fetch usa Bearer en header y propaga errores HTTP', async () => {
  let seenHeaders = null;
  const records = await fetchGoogleBooksWorkEvidence(ITEM, {
    accessToken: 'secret-token',
    fetchImpl: async (_url, options) => {
      seenHeaders = options.headers;
      return { ok: true, status: 200, async json() { return payload(); } };
    },
  });
  assert.equal(seenHeaders.authorization, 'Bearer secret-token');
  assert.equal(records.length, 1);

  await assert.rejects(
    () => fetchGoogleBooksWorkEvidence(ITEM, {
      accessToken: 'secret-token',
      fetchImpl: async () => ({ ok: false, status: 503, async json() { return {}; } }),
    }),
    /HTTP 503/,
  );
});
