// FICHAS-VIDRIERA-2 / GOOGLE-WORK-FALLBACK-1
// Recupera evidencia semántica de OTRA edición de la misma obra cuando
// Google Books no encuentra el ISBN exacto.
//
// Seguridad editorial:
// - la búsqueda exige título + autor;
// - el título público del sitio NO se modifica; para investigación se permite
//   una poda adicional sólo ante el autor exacto conocido o metadatos
//   inequívocos;
// - los resultados conservan su propio ISBN, nunca heredan el ISBN pedido;
// - el motor canónico book-intelligence-evidence decide si título+autor
//   representan realmente la misma obra;
// - por lo tanto publisher/pages/year de otra edición nunca se vuelven hechos
//   de la edición vendida.

import { deriveBookDisplayTitle } from '../../functions/_shared/book-display-title.js';
import {
  isGenericAuthor,
  normalizeValidIsbn,
} from '../../functions/_shared/showcase-ranking.js';

const GOOGLE_BOOKS_BASE = 'https://www.googleapis.com/books/v1/volumes';

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function trimResearchTitle(value) {
  return clean(value).replace(/[\s|,;:.-]+$/u, '').trim();
}

function researchTitle(item = {}) {
  const explicit = clean(item?.showcase_display_title);
  if (explicit.length >= 3) return explicit;

  const derived = deriveBookDisplayTitle(item);
  if (derived.changed && derived.title.length >= 3) return derived.title;

  const raw = clean(item?.title);
  const author = clean(item?.author);
  if (raw.length < 3) return raw;

  // El limpiador público tiene una barrera de longitud deliberadamente
  // conservadora. Para una query de investigación podemos cortar antes de un
  // sufijo que nombra EXACTAMENTE al autor conocido, porque ese texto no forma
  // parte del título de la obra y nunca se publica como resultado de esta poda.
  if (author && !isGenericAuthor(author)) {
    const authorPattern = escapeRegExp(author);
    const authorSuffix = new RegExp(
      `(?:\\s*[,|–—-]\\s*|\\s+)(?:de\\s+|autor(?:a|es)?\\s*:?\\s*)${authorPattern}(?=\\s*(?:[.,;|–—-]|$))`,
      'iu',
    );
    const match = authorSuffix.exec(raw);
    if (match?.index >= 3) {
      const prefix = trimResearchTitle(raw.slice(0, match.index));
      if (prefix.length >= 3) return prefix;
    }
  }

  // Segunda salida, sólo con etiquetas inequívocas de catálogo. No corta en
  // dos puntos ni guiones genéricos para no perder subtítulos legítimos.
  const metadataSuffix = /\s*(?:,|\.)\s*(?:editorial\b|tapa\s+(?:blanda|dura)\b|encuadernaci[oó]n\b|formato\b|idioma\b|en\s+(?:espa[nñ]ol|ingl[eé]s|portugu[eé]s|franc[eé]s|italiano|alem[aá]n)\b)/iu;
  const metadataMatch = metadataSuffix.exec(raw);
  if (metadataMatch?.index >= 3) {
    const prefix = trimResearchTitle(raw.slice(0, metadataMatch.index));
    if (prefix.length >= 3) return prefix;
  }

  return raw;
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

function yearFromDate(value) {
  const match = clean(value).match(/\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/);
  return match ? match[1] : null;
}

function identifiers(volumeInfo = {}) {
  return [...new Set(
    (Array.isArray(volumeInfo.industryIdentifiers) ? volumeInfo.industryIdentifiers : [])
      .map(identifier => normalizeValidIsbn(identifier?.identifier))
      .filter(Boolean),
  )];
}

export function googleWorkIdentity(item = {}) {
  const title = researchTitle(item);
  const author = clean(item?.author);
  if (title.length < 3 || isGenericAuthor(author)) return null;
  return { title, author };
}

export function buildGoogleBooksWorkUrl(item, {
  apiKey,
  accessToken,
  maxResults = 10,
} = {}) {
  const identity = googleWorkIdentity(item);
  if (!identity) throw new Error('La búsqueda de obra requiere título y autor confiables.');
  if (!clean(apiKey) && !clean(accessToken)) {
    throw new Error('Google Books requiere API key u OAuth access token.');
  }
  const safeMax = Math.min(Math.max(Math.floor(Number(maxResults) || 10), 1), 20);
  const url = new URL(GOOGLE_BOOKS_BASE);
  url.searchParams.set('q', `intitle:"${identity.title}" inauthor:"${identity.author}"`);
  url.searchParams.set('printType', 'books');
  url.searchParams.set('projection', 'full');
  url.searchParams.set('maxResults', String(safeMax));
  if (clean(apiKey)) url.searchParams.set('key', clean(apiKey));
  return url.toString();
}

export function parseGoogleBooksWorkEvidence(payload) {
  const output = [];
  const seen = new Set();
  for (const item of Array.isArray(payload?.items) ? payload.items : []) {
    const info = item?.volumeInfo || {};
    const authors = Array.isArray(info.authors) ? info.authors.map(clean).filter(Boolean) : [];
    const volumeIsbns = identifiers(info);
    const isbn = volumeIsbns[0] || null;
    const sourceId = clean(item?.id) || null;
    const key = sourceId || `${clean(info.title)}|${authors.join(', ')}|${isbn || ''}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const pages = Number(info.pageCount);
    output.push({
      source: 'google_books',
      source_id: sourceId,
      source_url: clean(info.infoLink) || clean(item?.selfLink) || null,
      isbn,
      title: clean(info.title),
      author: authors.join(', '),
      description: plainText(info.description),
      publisher: clean(info.publisher) || null,
      pages: Number.isInteger(pages) && pages > 0 ? pages : null,
      language: clean(info.language) || null,
      publication_year: yearFromDate(info.publishedDate),
      format: clean(info.printType) || null,
      topics: Array.isArray(info.categories)
        ? info.categories.map(clean).filter(Boolean).slice(0, 12)
        : [],
      raw_quality: {
        exact_isbn: false,
        identifiers: volumeIsbns,
        discovery: 'title_author',
      },
    });
  }
  return output;
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

export async function fetchGoogleBooksWorkEvidence(item, {
  apiKey,
  accessToken,
  fetchImpl,
  timeoutMs,
  maxResults,
} = {}) {
  const url = buildGoogleBooksWorkUrl(item, { apiKey, accessToken, maxResults });
  const headers = clean(accessToken)
    ? { authorization: `Bearer ${clean(accessToken)}` }
    : {};
  const payload = await fetchJson(url, { fetchImpl, timeoutMs, headers });
  return parseGoogleBooksWorkEvidence(payload);
}
