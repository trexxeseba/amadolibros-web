// FICHAS-VIDRIERA-2 / FUENTES-1
// Adaptadores de investigación bibliográfica offline/batch.
//
// Reglas:
// - nunca se ejecutan en el camino de una request de cliente;
// - Google Books se consulta por ISBN exacto y requiere API key en modo real;
// - Open Library usa el Partner/Read API multi-request para reducir llamadas;
// - todo resultado conserva `source` y se vuelve evidencia, no contenido final;
// - la caché evita volver a pedir datos estables en cada corrida.

import { normalizeValidIsbn } from '../../functions/_shared/showcase-ranking.js';

export const SOURCE_CACHE_SCHEMA_VERSION = 1;
export const GOOGLE_BOOKS_CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const OPEN_LIBRARY_CACHE_TTL_MS = 180 * 24 * 60 * 60 * 1000;
export const OPEN_LIBRARY_MAX_ISBNS_PER_REQUEST = 20;
export const DEFAULT_OPEN_LIBRARY_BATCH_BUDGET = 25;

const GOOGLE_BOOKS_BASE = 'https://www.googleapis.com/books/v1/volumes';
const OPEN_LIBRARY_READ_BASE = 'https://openlibrary.org/api/volumes/brief/json';

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function plainText(value) {
  return clean(String(value ?? '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'"));
}

function firstArrayValue(value) {
  return Array.isArray(value) && value.length ? value[0] : null;
}

function yearFromDate(value) {
  const match = clean(value).match(/\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/);
  return match ? match[1] : null;
}

function normalizedIdentifiers(volumeInfo = {}) {
  const ids = [];
  for (const identifier of Array.isArray(volumeInfo.industryIdentifiers) ? volumeInfo.industryIdentifiers : []) {
    const normalized = normalizeValidIsbn(identifier?.identifier);
    if (normalized) ids.push(normalized);
  }
  return [...new Set(ids)];
}

function googleBooksExactItems(payload, isbn) {
  const target = normalizeValidIsbn(isbn);
  if (!target) return [];
  return (Array.isArray(payload?.items) ? payload.items : [])
    .filter(item => normalizedIdentifiers(item?.volumeInfo).includes(target));
}

export function buildGoogleBooksUrl(isbn, { apiKey } = {}) {
  const normalized = normalizeValidIsbn(isbn);
  if (!normalized) throw new Error('ISBN inválido para Google Books.');
  if (!clean(apiKey)) throw new Error('GOOGLE_BOOKS_API_KEY es obligatorio para consultas reales.');
  const url = new URL(GOOGLE_BOOKS_BASE);
  url.searchParams.set('q', `isbn:${normalized}`);
  url.searchParams.set('printType', 'books');
  url.searchParams.set('projection', 'full');
  url.searchParams.set('maxResults', '10');
  url.searchParams.set('key', clean(apiKey));
  return url.toString();
}

export function parseGoogleBooksEvidence(payload, isbn) {
  const target = normalizeValidIsbn(isbn);
  if (!target) return [];

  return googleBooksExactItems(payload, target).map(item => {
    const info = item?.volumeInfo || {};
    const authors = Array.isArray(info.authors) ? info.authors.map(clean).filter(Boolean) : [];
    const topics = Array.isArray(info.categories) ? info.categories.map(clean).filter(Boolean).slice(0, 12) : [];
    return {
      source: 'google_books',
      source_id: clean(item?.id) || null,
      source_url: clean(info.infoLink) || clean(item?.selfLink) || null,
      isbn: target,
      title: clean(info.title),
      author: authors.join(', '),
      description: plainText(info.description),
      publisher: clean(info.publisher) || null,
      pages: Number.isInteger(Number(info.pageCount)) && Number(info.pageCount) > 0 ? Number(info.pageCount) : null,
      language: clean(info.language) || null,
      publication_year: yearFromDate(info.publishedDate),
      format: clean(info.printType) || null,
      topics,
      raw_quality: {
        exact_isbn: true,
        identifiers: normalizedIdentifiers(info),
      },
    };
  });
}

export function buildOpenLibraryBatchUrl(isbns) {
  if (!Array.isArray(isbns) || isbns.length === 0) throw new Error('Se necesita al menos un ISBN.');
  if (isbns.length > OPEN_LIBRARY_MAX_ISBNS_PER_REQUEST) {
    throw new Error(`Open Library admite como máximo ${OPEN_LIBRARY_MAX_ISBNS_PER_REQUEST} ISBN por request en este cliente.`);
  }
  const normalized = [...new Set(isbns.map(normalizeValidIsbn).filter(Boolean))];
  if (normalized.length === 0) throw new Error('No hay ISBN válidos para Open Library.');
  const requests = normalized.map(isbn => `isbn:${isbn}`).join('|');
  return `${OPEN_LIBRARY_READ_BASE}/${requests}`;
}

function recordIsbns(record) {
  const raw = [
    ...(Array.isArray(record?.isbns) ? record.isbns : []),
    ...(Array.isArray(record?.data?.identifiers?.isbn_13) ? record.data.identifiers.isbn_13 : []),
    ...(Array.isArray(record?.data?.identifiers?.isbn_10) ? record.data.identifiers.isbn_10 : []),
  ];
  return [...new Set(raw.map(normalizeValidIsbn).filter(Boolean))];
}

function authorNames(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(author => typeof author === 'string' ? clean(author) : clean(author?.name))
    .filter(Boolean);
}

function publisherName(value) {
  const first = firstArrayValue(value);
  if (typeof first === 'string') return clean(first);
  return clean(first?.name) || null;
}

function descriptionValue(value) {
  if (typeof value === 'string') return plainText(value);
  return plainText(value?.value);
}

function openLibraryRecords(payload) {
  if (Array.isArray(payload?.records)) return payload.records;
  if (payload?.records && typeof payload.records === 'object') return Object.values(payload.records);
  if (Array.isArray(payload)) return payload;
  return [];
}

export function parseOpenLibraryEvidence(payload, requestedIsbns) {
  const wanted = new Set((Array.isArray(requestedIsbns) ? requestedIsbns : [requestedIsbns])
    .map(normalizeValidIsbn)
    .filter(Boolean));
  if (!wanted.size) return [];

  const output = [];
  for (const record of openLibraryRecords(payload)) {
    const exactMatches = recordIsbns(record).filter(isbn => wanted.has(isbn));
    if (!exactMatches.length) continue;
    const data = record?.data || {};
    const authors = authorNames(data.authors);
    const topics = [
      ...(Array.isArray(data.subjects) ? data.subjects : []),
      ...(Array.isArray(record?.subjects) ? record.subjects : []),
    ].map(value => typeof value === 'string' ? clean(value) : clean(value?.name)).filter(Boolean).slice(0, 12);
    const pages = Number(data.number_of_pages ?? record?.number_of_pages);
    const publishDate = clean(data.publish_date) || clean(firstArrayValue(record?.publishDates));
    const languages = Array.isArray(data.languages)
      ? data.languages.map(lang => clean(lang?.key || lang)).filter(Boolean)
      : [];

    for (const isbn of exactMatches) {
      output.push({
        source: 'open_library',
        source_id: clean(data.key || record?.key || firstArrayValue(record?.olids)) || null,
        source_url: clean(record?.recordURL) || null,
        isbn,
        title: clean(data.title || record?.title),
        author: authors.join(', '),
        description: descriptionValue(data.description || record?.description),
        publisher: publisherName(data.publishers || record?.publishers),
        pages: Number.isInteger(pages) && pages > 0 ? pages : null,
        language: languages.length ? languages.join(', ') : null,
        publication_year: yearFromDate(publishDate),
        format: clean(data.physical_format || record?.physical_format) || null,
        topics,
        raw_quality: {
          exact_isbn: true,
          identifiers: recordIsbns(record),
        },
      });
    }
  }
  return output;
}

function cacheEntry(cache, isbn, source) {
  return cache?.entries?.[isbn]?.[source] || null;
}

export function isSourceCacheFresh(cache, isbn, source, { now = Date.now() } = {}) {
  const entry = cacheEntry(cache, isbn, source);
  if (!entry?.fetched_at) return false;
  const fetchedAt = Date.parse(entry.fetched_at);
  if (!Number.isFinite(fetchedAt)) return false;
  const ttl = source === 'open_library' ? OPEN_LIBRARY_CACHE_TTL_MS : GOOGLE_BOOKS_CACHE_TTL_MS;
  return now - fetchedAt >= 0 && now - fetchedAt < ttl;
}

function priorityTuple(item) {
  return [
    Number(item?.priority_score) || 0,
    Number(item?.gsc_impressions) || 0,
    Number(item?.gsc_clicks) || 0,
  ];
}

function comparePriority(a, b) {
  const left = priorityTuple(a);
  const right = priorityTuple(b);
  for (let i = 0; i < left.length; i++) {
    if (right[i] !== left[i]) return right[i] - left[i];
  }
  return String(a?.id || '').localeCompare(String(b?.id || ''));
}

/**
 * Produce un plan reproducible sin ejecutar red. Open Library queda
 * deliberadamente presupuestado a bajo volumen; para miles de registros se
 * debe ingerir su dump/bulk en un lote posterior, no abusar del API público.
 */
export function planBookSourceResearch(items, cache = {}, {
  googleBooksBudget = 300,
  openLibraryBudget = DEFAULT_OPEN_LIBRARY_BATCH_BUDGET,
  now = Date.now(),
} = {}) {
  const eligible = (Array.isArray(items) ? items : [])
    .map(item => ({ ...item, isbn: normalizeValidIsbn(item?.isbn) }))
    .filter(item => item.isbn)
    .sort(comparePriority);

  const uniqueByIsbn = [];
  const seen = new Set();
  for (const item of eligible) {
    if (seen.has(item.isbn)) continue;
    seen.add(item.isbn);
    uniqueByIsbn.push(item);
  }

  const googleBooks = uniqueByIsbn
    .filter(item => !isSourceCacheFresh(cache, item.isbn, 'google_books', { now }))
    .slice(0, Math.max(0, googleBooksBudget));
  const openLibrary = uniqueByIsbn
    .filter(item => !isSourceCacheFresh(cache, item.isbn, 'open_library', { now }))
    .slice(0, Math.max(0, openLibraryBudget));

  return {
    schema_version: 1,
    eligible_unique_isbns: uniqueByIsbn.length,
    google_books: googleBooks.map(item => ({ id: item.id || null, isbn: item.isbn })),
    open_library: openLibrary.map(item => ({ id: item.id || null, isbn: item.isbn })),
    cached_google_books: uniqueByIsbn.length - uniqueByIsbn.filter(item => !isSourceCacheFresh(cache, item.isbn, 'google_books', { now })).length,
    cached_open_library: uniqueByIsbn.length - uniqueByIsbn.filter(item => !isSourceCacheFresh(cache, item.isbn, 'open_library', { now })).length,
  };
}

async function fetchJson(url, {
  fetchImpl = globalThis.fetch,
  headers = {},
  timeoutMs = 10_000,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch no disponible.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json', ...headers },
      signal: controller.signal,
    });
    if (!response?.ok) throw new Error(`HTTP ${response?.status || 0}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchGoogleBooksEvidence(isbn, {
  apiKey,
  fetchImpl,
  timeoutMs,
} = {}) {
  const url = buildGoogleBooksUrl(isbn, { apiKey });
  const payload = await fetchJson(url, { fetchImpl, timeoutMs });
  return parseGoogleBooksEvidence(payload, isbn);
}

export async function fetchOpenLibraryBatchEvidence(isbns, {
  fetchImpl,
  timeoutMs,
  userAgent = 'AmadoLibros-BookIntelligence/1.0',
  contact,
} = {}) {
  if (!clean(contact)) throw new Error('Open Library requiere un contacto identificable para este cliente.');
  const url = buildOpenLibraryBatchUrl(isbns);
  const payload = await fetchJson(url, {
    fetchImpl,
    timeoutMs,
    headers: {
      'user-agent': `${clean(userAgent)} (${clean(contact)})`,
    },
  });
  return parseOpenLibraryEvidence(payload, isbns);
}

export function emptySourceCache() {
  return {
    schema_version: SOURCE_CACHE_SCHEMA_VERSION,
    generated_at: null,
    entries: {},
  };
}

export function mergeSourceCache(cache, isbn, source, records, {
  fetchedAt = new Date().toISOString(),
  error = null,
} = {}) {
  const normalized = normalizeValidIsbn(isbn);
  if (!normalized) throw new Error('ISBN inválido para caché.');
  if (!['google_books', 'open_library'].includes(source)) throw new Error('Fuente no cacheable.');
  const next = JSON.parse(JSON.stringify(cache?.entries ? cache : emptySourceCache()));
  next.schema_version = SOURCE_CACHE_SCHEMA_VERSION;
  next.generated_at = fetchedAt;
  next.entries[normalized] ||= {};
  next.entries[normalized][source] = {
    fetched_at: fetchedAt,
    error: error ? clean(error) : null,
    records: Array.isArray(records) ? records : [],
  };
  return next;
}

export function chunkOpenLibraryPlan(plan) {
  const entries = Array.isArray(plan?.open_library) ? plan.open_library : [];
  const chunks = [];
  for (let i = 0; i < entries.length; i += OPEN_LIBRARY_MAX_ISBNS_PER_REQUEST) {
    chunks.push(entries.slice(i, i + OPEN_LIBRARY_MAX_ISBNS_PER_REQUEST));
  }
  return chunks;
}
