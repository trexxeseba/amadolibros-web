import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BNE_CACHE_TTL_MS,
  GOOGLE_BOOKS_CACHE_TTL_MS,
  OPEN_LIBRARY_CACHE_TTL_MS,
  OPEN_LIBRARY_ADAPTER_VERSION,
  OPEN_LIBRARY_MAX_ISBNS_PER_REQUEST,
  buildGoogleBooksUrl,
  buildOpenLibraryBatchUrl,
  chunkOpenLibraryPlan,
  emptySourceCache,
  fetchGoogleBooksEvidence,
  fetchOpenLibraryBatchEvidence,
  isSourceCacheFresh,
  mergeSourceCache,
  parseGoogleBooksEvidence,
  parseOpenLibraryEvidence,
  CACHEABLE_SOURCES,
  SOURCE_CACHE_TTL_MS,
  planBookSourceResearch,
} from '../../scripts/seo/book-intelligence-sources.mjs';

const ISBN = '9788496836693';
const ISBN_2 = '9780194527552';

function fakeResponse(payload, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

test('Google Books exige API key u OAuth token y usa búsqueda exacta por ISBN', () => {
  assert.throws(() => buildGoogleBooksUrl(ISBN), /API key u OAuth/);
  const keyUrl = new URL(buildGoogleBooksUrl(ISBN, { apiKey: 'test-key' }));
  assert.equal(keyUrl.origin, 'https://www.googleapis.com');
  assert.equal(keyUrl.pathname, '/books/v1/volumes');
  assert.equal(keyUrl.searchParams.get('q'), `isbn:${ISBN}`);
  assert.equal(keyUrl.searchParams.get('printType'), 'books');
  assert.equal(keyUrl.searchParams.get('key'), 'test-key');

  const oauthUrl = new URL(buildGoogleBooksUrl(ISBN, { accessToken: 'token-from-wif' }));
  assert.equal(oauthUrl.searchParams.get('q'), `isbn:${ISBN}`);
  assert.equal(oauthUrl.searchParams.has('key'), false);
  assert.equal(oauthUrl.toString().includes('token-from-wif'), false);
});

test('parseGoogleBooksEvidence sólo acepta volumes que contienen el ISBN exacto', () => {
  const payload = {
    items: [
      {
        id: 'good',
        volumeInfo: {
          title: 'Padres fuertes, hijas felices',
          authors: ['Meg Meeker'],
          publisher: 'Ciudadela',
          publishedDate: '2008-05-01',
          pageCount: 304,
          language: 'es',
          printType: 'BOOK',
          description: '<p>Una descripción editorial real &amp; útil sobre el libro.</p>',
          categories: ['Familia', 'Educación'],
          industryIdentifiers: [{ type: 'ISBN_13', identifier: ISBN }],
          infoLink: 'https://books.google.test/good',
        },
      },
      {
        id: 'wrong',
        volumeInfo: {
          title: 'Otra obra',
          industryIdentifiers: [{ type: 'ISBN_13', identifier: ISBN_2 }],
        },
      },
    ],
  };
  const records = parseGoogleBooksEvidence(payload, ISBN);
  assert.equal(records.length, 1);
  assert.equal(records[0].source, 'google_books');
  assert.equal(records[0].source_id, 'good');
  assert.equal(records[0].isbn, ISBN);
  assert.equal(records[0].author, 'Meg Meeker');
  assert.equal(records[0].publisher, 'Ciudadela');
  assert.equal(records[0].pages, 304);
  assert.equal(records[0].publication_year, '2008');
  assert.equal(records[0].language, 'Español');
  assert.equal(records[0].format, null);
  assert.equal(records[0].description.includes('<p>'), false);
  assert.deepEqual(records[0].topics, ['Familia', 'Educación']);
});

test('Open Library batch URL agrupa ISBN y limita el tamaño por request', () => {
  const url = buildOpenLibraryBatchUrl([ISBN, ISBN_2]);
  const parsed = new URL(url);
  assert.equal(parsed.pathname, '/api/books');
  assert.equal(parsed.searchParams.get('bibkeys'), `ISBN:${ISBN},ISBN:${ISBN_2}`);
  assert.equal(parsed.searchParams.get('jscmd'), 'data');
  assert.equal(parsed.searchParams.get('format'), 'json');
  const tooMany = Array.from({ length: OPEN_LIBRARY_MAX_ISBNS_PER_REQUEST + 1 }, () => ISBN);
  assert.throws(() => buildOpenLibraryBatchUrl(tooMany), /como máximo/);
});

test('parseOpenLibraryEvidence conserva sólo matches exactos solicitados', () => {
  const payload = {
    records: {
      '/books/OL1M': {
        isbns: [ISBN],
        olids: ['OL1M'],
        recordURL: 'https://openlibrary.org/books/OL1M',
        publishDates: ['2008'],
        data: {
          key: '/books/OL1M',
          title: 'Padres fuertes, hijas felices',
          authors: [{ name: 'Meg Meeker' }],
          publishers: [{ name: 'Ciudadela' }],
          number_of_pages: 304,
          languages: [{ key: '/languages/spa' }],
          description: { value: 'Descripción bibliográfica de la edición.' },
          subjects: [{ name: 'Familia' }, { name: 'Educación' }],
          identifiers: { isbn_13: [ISBN] },
        },
      },
      '/books/OL2M': {
        isbns: [ISBN_2],
        data: { title: 'Headway Elementary' },
      },
    },
  };
  const records = parseOpenLibraryEvidence(payload, [ISBN]);
  assert.equal(records.length, 1);
  assert.equal(records[0].source, 'open_library');
  assert.equal(records[0].isbn, ISBN);
  assert.equal(records[0].title, 'Padres fuertes, hijas felices');
  assert.equal(records[0].author, 'Meg Meeker');
  assert.equal(records[0].publisher, 'Ciudadela');
  assert.equal(records[0].pages, 304);
  assert.equal(records[0].publication_year, '2008');
  assert.deepEqual(records[0].topics, ['Familia', 'Educación']);
});

test('parseOpenLibraryEvidence entiende el Books API multi-ISBN oficial', () => {
  const records = parseOpenLibraryEvidence({
    [`ISBN:${ISBN}`]: {
      title: 'Padres fuertes, hijas felices',
      authors: [{ name: 'Meg Meeker' }],
      publishers: [{ name: 'Ciudadela' }],
      number_of_pages: 304,
      publish_date: '2008',
      identifiers: { isbn_13: [ISBN] },
      subjects: [{ name: 'Familia' }],
      url: 'https://openlibrary.org/books/OL1M',
    },
  }, [ISBN]);
  assert.equal(records.length, 1);
  assert.equal(records[0].isbn, ISBN);
  assert.equal(records[0].publisher, 'Ciudadela');
  assert.equal(records[0].pages, 304);
  assert.equal(records[0].source_url, `https://openlibrary.org/isbn/${ISBN}`);
});

test('planner deduplica por ISBN y prioriza score/GSC antes de aplicar budgets', () => {
  const plan = planBookSourceResearch([
    { id: 'LOW', isbn: ISBN, priority_score: 1, gsc_impressions: 1 },
    { id: 'DUP-HIGH', isbn: ISBN, priority_score: 10, gsc_impressions: 5 },
    { id: 'SECOND', isbn: ISBN_2, priority_score: 8, gsc_impressions: 100 },
  ], {}, { googleBooksBudget: 1, openLibraryBudget: 1, now: Date.parse('2026-08-22T00:00:00Z') });

  assert.equal(plan.eligible_unique_isbns, 2);
  assert.deepEqual(plan.google_books, [{ id: 'DUP-HIGH', isbn: ISBN }]);
  assert.deepEqual(plan.open_library, [{ id: 'DUP-HIGH', isbn: ISBN }]);
});

test('caché fresca evita requests y caché vencida vuelve al plan', () => {
  const now = Date.parse('2026-08-22T00:00:00Z');
  let cache = emptySourceCache();
  cache = mergeSourceCache(cache, ISBN, 'google_books', [], {
    fetchedAt: new Date(now - GOOGLE_BOOKS_CACHE_TTL_MS + 1000).toISOString(),
  });
  cache = mergeSourceCache(cache, ISBN, 'open_library', [], {
    fetchedAt: new Date(now - OPEN_LIBRARY_CACHE_TTL_MS + 1000).toISOString(),
  });
  cache = mergeSourceCache(cache, ISBN, 'bne', [], {
    fetchedAt: new Date(now - BNE_CACHE_TTL_MS + 1000).toISOString(),
  });

  assert.equal(isSourceCacheFresh(cache, ISBN, 'google_books', { now }), true);
  assert.equal(isSourceCacheFresh(cache, ISBN, 'open_library', { now }), true);
  assert.equal(isSourceCacheFresh(cache, ISBN, 'bne', { now }), true);
  let plan = planBookSourceResearch([{ id: 'A', isbn: ISBN }], cache, { now });
  assert.equal(plan.google_books.length, 0);
  assert.equal(plan.open_library.length, 0);
  assert.equal(plan.bne.length, 0);

  const later = now + OPEN_LIBRARY_CACHE_TTL_MS + GOOGLE_BOOKS_CACHE_TTL_MS;
  plan = planBookSourceResearch([{ id: 'A', isbn: ISBN }], cache, { now: later });
  assert.equal(plan.google_books.length, 1);
  assert.equal(plan.open_library.length, 1);
});

test('un error cacheado nunca se considera fresco y se reintenta', () => {
  const now = Date.parse('2026-08-24T12:00:00Z');
  const cache = mergeSourceCache(emptySourceCache(), ISBN, 'google_books', [], {
    fetchedAt: new Date(now - 1000).toISOString(),
    error: 'HTTP 429',
  });
  assert.equal(isSourceCacheFresh(cache, ISBN, 'google_books', { now }), false);
});

test('invalida los falsos no-match del adaptador Open Library v1', () => {
  const now = Date.parse('2026-08-24T12:00:00Z');
  const stale = {
    entries: {
      [ISBN]: {
        open_library: {
          fetched_at: new Date(now - 1000).toISOString(),
          error: null,
          records: [],
        },
      },
    },
  };
  assert.equal(isSourceCacheFresh(stale, ISBN, 'open_library', { now }), false);
  const current = mergeSourceCache(emptySourceCache(), ISBN, 'open_library', [], {
    fetchedAt: new Date(now - 1000).toISOString(),
  });
  assert.equal(current.entries[ISBN].open_library.adapter_version, OPEN_LIBRARY_ADAPTER_VERSION);
  assert.equal(isSourceCacheFresh(current, ISBN, 'open_library', { now }), true);
});

test('Open Library budget es bajo por defecto y se divide en requests de máximo 20', () => {
  const base = [ISBN, ISBN_2];
  const items = Array.from({ length: 40 }, (_, index) => ({
    id: `MLU${index}`,
    isbn: base[index % base.length],
  }));
  const plan = planBookSourceResearch(items, {}, { openLibraryBudget: 25 });
  assert.equal(plan.open_library.length, 2);
  const synthetic = {
    open_library: Array.from({ length: 25 }, (_, i) => ({ id: `X${i}`, isbn: ISBN })),
  };
  const chunks = chunkOpenLibraryPlan(synthetic);
  assert.deepEqual(chunks.map(chunk => chunk.length), [20, 5]);
});

test('fetchGoogleBooksEvidence con API key usa fetch inyectable y parsea respuesta', async () => {
  let requestedUrl = null;
  const records = await fetchGoogleBooksEvidence(ISBN, {
    apiKey: 'abc123',
    fetchImpl: async (url) => {
      requestedUrl = String(url);
      return fakeResponse({
        items: [{
          id: 'G1',
          volumeInfo: {
            title: 'Padres fuertes, hijas felices',
            authors: ['Meg Meeker'],
            industryIdentifiers: [{ type: 'ISBN_13', identifier: ISBN }],
          },
        }],
      });
    },
  });
  assert.equal(new URL(requestedUrl).searchParams.get('key'), 'abc123');
  assert.equal(records.length, 1);
  assert.equal(records[0].source_id, 'G1');
});

test('fetchGoogleBooksEvidence con OAuth manda Bearer y nunca filtra token en URL', async () => {
  let requestedUrl = null;
  let requestedOptions = null;
  const records = await fetchGoogleBooksEvidence(ISBN, {
    accessToken: 'wif-access-token',
    fetchImpl: async (url, options) => {
      requestedUrl = String(url);
      requestedOptions = options;
      return fakeResponse({
        items: [{
          id: 'G2',
          volumeInfo: {
            title: 'Padres fuertes, hijas felices',
            authors: ['Meg Meeker'],
            industryIdentifiers: [{ type: 'ISBN_13', identifier: ISBN }],
          },
        }],
      });
    },
  });
  assert.equal(new URL(requestedUrl).searchParams.has('key'), false);
  assert.equal(requestedUrl.includes('wif-access-token'), false);
  assert.equal(requestedOptions.headers.authorization, 'Bearer wif-access-token');
  assert.equal(records[0].source_id, 'G2');
});

test('fetchOpenLibraryBatchEvidence exige contacto identificable', async () => {
  await assert.rejects(
    () => fetchOpenLibraryBatchEvidence([ISBN], { fetchImpl: async () => fakeResponse({}) }),
    /contacto identificable/,
  );
});

test('fetchOpenLibraryBatchEvidence identifica User-Agent y usa una llamada multi-ISBN', async () => {
  let requestedUrl = null;
  let requestedOptions = null;
  const records = await fetchOpenLibraryBatchEvidence([ISBN, ISBN_2], {
    contact: 'seo@example.test',
    userAgent: 'AmadoTest/1.0',
    fetchImpl: async (url, options) => {
      requestedUrl = String(url);
      requestedOptions = options;
      return fakeResponse({
        records: {
          OL1: { isbns: [ISBN], data: { title: 'Libro uno', authors: [{ name: 'Autora' }] } },
          OL2: { isbns: [ISBN_2], data: { title: 'Libro dos', authors: [{ name: 'Autor' }] } },
        },
      });
    },
  });
  assert.equal(new URL(requestedUrl).searchParams.get('bibkeys'), `ISBN:${ISBN},ISBN:${ISBN_2}`);
  assert.equal(requestedOptions.headers['user-agent'], 'AmadoTest/1.0 (seo@example.test)');
  assert.equal(records.length, 2);
});

test('errores HTTP no se convierten en evidencia silenciosa', async () => {
  await assert.rejects(
    () => fetchGoogleBooksEvidence(ISBN, {
      apiKey: 'abc',
      fetchImpl: async () => fakeResponse({}, { status: 503 }),
      retryAttempts: 1,
    }),
    /HTTP 503/,
  );
});

test('mergeSourceCache versiona records/error por ISBN y fuente sin pisar la otra fuente', () => {
  const fetchedAt = '2026-08-22T10:00:00.000Z';
  let cache = emptySourceCache();
  cache = mergeSourceCache(cache, ISBN, 'google_books', [{ source: 'google_books', isbn: ISBN }], { fetchedAt });
  cache = mergeSourceCache(cache, ISBN, 'open_library', [], { fetchedAt, error: 'sin match' });
  assert.equal(cache.schema_version, 1);
  assert.equal(cache.entries[ISBN].google_books.records.length, 1);
  assert.equal(cache.entries[ISBN].open_library.error, 'sin match');
  assert.equal(cache.generated_at, fetchedAt);
});

// SOURCE-COVERAGE-4: Library of Congress y DNB entran al plan como cualquier
// otra fuente, con su propio presupuesto y su propio cache.
test('el plan reserva presupuesto propio para LoC y DNB', () => {
  const plan = planBookSourceResearch(
    [{ id: 'A', isbn: '9780062273208' }, { id: 'B', isbn: '9788496836693' }],
    {},
    { googleBooksBudget: 0, openLibraryBudget: 0, bneBudget: 0, locBudget: 2, dnbBudget: 1 },
  );
  assert.equal(plan.loc.length, 2);
  assert.equal(plan.dnb.length, 1);
  assert.equal(plan.google_books.length, 0);
});

test('sin presupuesto explícito las fuentes nuevas no consumen cuota', () => {
  const plan = planBookSourceResearch([{ id: 'A', isbn: '9780062273208' }], {});
  assert.deepEqual(plan.loc, []);
  assert.deepEqual(plan.dnb, []);
});

// El lote 34032005445 falló con "Fuente no cacheable": LoC y DNB estaban
// cableadas al orquestador pero no a la lista blanca del caché. Este test
// ata las dos cosas para que no se separen otra vez.
test('toda fuente del plan es cacheable y tiene TTL propio', () => {
  const plan = planBookSourceResearch([{ id: 'A', isbn: '9780062273208' }], {}, {
    googleBooksBudget: 1, openLibraryBudget: 1, bneBudget: 1, locBudget: 1, dnbBudget: 1,
  });
  const enElPlan = Object.keys(plan).filter(key => Array.isArray(plan[key]) && key !== 'entries');
  for (const source of enElPlan) {
    assert.ok(CACHEABLE_SOURCES.includes(source), `${source} no está en CACHEABLE_SOURCES`);
    assert.ok(Number.isFinite(SOURCE_CACHE_TTL_MS[source]), `${source} no tiene TTL`);
    assert.doesNotThrow(() => mergeSourceCache({}, '9780062273208', source, []), source);
  }
});
