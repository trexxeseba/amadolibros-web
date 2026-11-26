// Datos bibliográficos por ISBN desde fuentes públicas y gratuitas, sin clave:
// Open Library y Google Books. SOLO LECTURA y sólo viaja el ISBN: ningún dato
// de la cuenta, de la publicación ni del vendedor sale de esta máquina.
//
// La parte de arriba es lógica pura (normalización, mapeo de cada fuente y
// regla de discrepancia) y está cubierta por tests. La parte de abajo consulta
// la red con pausa entre llamadas y caché en disco FUERA del repo.
//
// Reglas de datos:
//  - Nunca se infiere ni se inventa: un campo que la fuente no trae de forma
//    explícita y sin ambigüedad queda vacío.
//  - Tapa: sólo "Blanda" o "Dura" cuando el formato de la fuente es inequívoco.
//  - Edición: sólo si la fuente la declara (Open Library `edition_name`).
//  - Género: ninguna de las dos fuentes lo declara como tal (traen materias o
//    categorías), así que no se propone desde acá.
//  - Si dos fuentes discrepan en un campo, ese campo queda sin propuesta y la
//    discrepancia se anota.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { normalizeValidIsbn } from '../../functions/_shared/showcase-ranking.js';

export const FACT_KEYS = Object.freeze(['year', 'pages', 'cover', 'language', 'publisher', 'edition', 'genre']);
export const SOURCE_ORDER = Object.freeze(['registro', 'openlibrary', 'googlebooks']);

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const fold = value => clean(value).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// ---------------------------------------------------------------------------
// ISBN
// ---------------------------------------------------------------------------

/**
 * ISBN-13 válido a partir de un ISBN-10, un ISBN-13 (con o sin guiones) o un
 * GTIN-14 que es un ISBN-13 con un cero adelante (así llegan algunos GTIN de
 * Mercado Libre). Devuelve null si el dígito verificador no cierra.
 */
export function normalizeGtinIsbn(value) {
  const direct = normalizeValidIsbn(value);
  if (direct) return direct;
  const digits = String(value ?? '').replace(/[^0-9]/g, '');
  if (/^0(978|979)\d{10}$/.test(digits)) return normalizeValidIsbn(digits.slice(1));
  return null;
}

/**
 * ISBN de una publicación: el campo `isbn` del espejo o los atributos GTIN/ISBN
 * crudos (value_name y values[].name). Si la publicación trae dos ISBN válidos
 * distintos es ambigua y no se le asigna ninguno.
 */
export function itemIsbn(item) {
  const raw = [item?.isbn];
  for (const attribute of Array.isArray(item?.attributes) ? item.attributes : []) {
    if (!['GTIN', 'ISBN'].includes(String(attribute?.id ?? '').toUpperCase())) continue;
    raw.push(attribute.value_name);
    for (const value of Array.isArray(attribute.values) ? attribute.values : []) raw.push(value?.name);
  }
  const found = new Set(raw.map(normalizeGtinIsbn).filter(Boolean));
  return found.size === 1 ? [...found][0] : null;
}

// ---------------------------------------------------------------------------
// Normalización de campos
// ---------------------------------------------------------------------------

export function extractYear(value, now = new Date()) {
  const years = [...new Set(clean(value).match(/\b(1[4-9]\d{2}|20\d{2})\b/g) || [])];
  if (years.length !== 1) return null;
  return Number(years[0]) <= now.getUTCFullYear() + 1 ? years[0] : null;
}

function positivePages(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number < 20000 ? number : null;
}

const SOFT_COVERS = new Set(['paperback', 'mass market paperback', 'trade paperback', 'perfect paperback', 'softcover', 'soft cover', 'tapa blanda', 'rustica', 'rustica con solapas', 'pasta blanda', 'encuadernacion rustica']);
const HARD_COVERS = new Set(['hardcover', 'hardback', 'hard cover', 'tapa dura', 'cartone', 'pasta dura', 'library binding', 'encuadernacion en tapa dura']);

/** "Blanda" | "Dura" | null. Sólo coincidencia exacta con formatos inequívocos. */
export function coverFromFormat(value) {
  const key = fold(value).replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (SOFT_COVERS.has(key)) return 'Blanda';
  if (HARD_COVERS.has(key)) return 'Dura';
  return null;
}

const LANGUAGES = Object.freeze({
  spa: 'Español', es: 'Español', eng: 'Inglés', en: 'Inglés', por: 'Portugués', pt: 'Portugués',
  fre: 'Francés', fra: 'Francés', fr: 'Francés', ita: 'Italiano', it: 'Italiano',
  ger: 'Alemán', deu: 'Alemán', de: 'Alemán', cat: 'Catalán', ca: 'Catalán',
});

export function languageFromCode(code) {
  return LANGUAGES[fold(code).split('-')[0]] || null;
}

function emptyFacts() {
  return Object.fromEntries(FACT_KEYS.map(key => [key, null]));
}

function hasAnyFact(facts) {
  return FACT_KEYS.some(key => facts[key] !== null);
}

// ---------------------------------------------------------------------------
// Mapeo de cada fuente
// ---------------------------------------------------------------------------

/** Open Library: respuesta de /isbn/{isbn}.json (una edición). */
export function mapOpenLibraryEdition(json, now = new Date()) {
  const facts = emptyFacts();
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  facts.year = extractYear(json.publish_date, now);
  const pages = positivePages(json.number_of_pages);
  facts.pages = pages ? String(pages) : null;
  facts.cover = coverFromFormat(json.physical_format);
  const languages = [...new Set((Array.isArray(json.languages) ? json.languages : [])
    .map(entry => clean(entry?.key).split('/').pop()).filter(Boolean))];
  facts.language = languages.length === 1 ? languageFromCode(languages[0]) : null;
  const publishers = [...new Map((Array.isArray(json.publishers) ? json.publishers : [])
    .map(clean).filter(Boolean).reverse().map(name => [publisherKey(name), name])).values()];
  facts.publisher = publishers.length === 1 ? publishers[0] : null;
  facts.edition = clean(json.edition_name) || null;
  return hasAnyFact(facts) ? facts : null;
}

/**
 * Google Books: respuesta de /volumes?q=isbn:{isbn}. Sólo se acepta un volumen
 * que declare ese mismo ISBN; si hay más de uno, no se elige: queda sin dato.
 */
export function mapGoogleBooksVolumes(json, isbn, now = new Date()) {
  const wanted = normalizeGtinIsbn(isbn);
  if (!wanted || !json || !Array.isArray(json.items)) return null;
  const matches = json.items.filter(item => (item?.volumeInfo?.industryIdentifiers || [])
    .some(identifier => normalizeGtinIsbn(identifier?.identifier) === wanted));
  if (matches.length !== 1) return null;
  const info = matches[0].volumeInfo;
  const facts = emptyFacts();
  facts.year = extractYear(info.publishedDate, now);
  const pages = positivePages(info.pageCount);
  facts.pages = pages ? String(pages) : null;
  facts.language = languageFromCode(info.language);
  facts.publisher = clean(info.publisher) || null;
  return hasAnyFact(facts) ? facts : null;
}

// ---------------------------------------------------------------------------
// Regla de discrepancia
// ---------------------------------------------------------------------------

const PUBLISHER_NOISE = new Set(['editorial', 'editoriales', 'editora', 'editores', 'editor', 'ediciones', 'edicions', 'edicoes', 'editions', 'edition',
  'publishing', 'publishers', 'publisher', 'publications', 'press', 'books', 'libros', 'grupo', 'group', 'sa', 'sl', 'slu', 'srl', 'ltd', 'ltda', 'inc', 'llc', 'co', 'company', 'the', 'el', 'la', 'los', 'las', 'de', 'del', 'y', 'and']);

export function publisherKey(value) {
  const tokens = fold(value).replace(/[.'’]/g, '').replace(/[^a-z0-9 ]/g, ' ').split(' ').filter(Boolean);
  const core = tokens.filter(token => !PUBLISHER_NOISE.has(token));
  return (core.length ? core : tokens).join(' ');
}

/** Clave de comparación: dos valores con la misma clave dicen lo mismo. */
export function comparisonKey(field, value) {
  if (field === 'publisher') return publisherKey(value);
  if (field === 'pages') return String(Number(value));
  return fold(value);
}

/**
 * Decide un campo a partir de lo que dice cada fuente.
 * candidates: [{ source, value }]. Devuelve:
 *   null                                    nadie trae el dato
 *   { value, sources }                      una fuente, o varias que coinciden
 *   { discrepancy: [{ source, value }] }    dos fuentes dicen cosas distintas
 */
export function resolveField(field, candidates) {
  const present = (candidates || [])
    .map(candidate => ({ source: candidate.source, value: clean(candidate.value) }))
    .filter(candidate => candidate.value && comparisonKey(field, candidate.value))
    .sort((a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source));
  if (!present.length) return null;
  const keys = new Set(present.map(candidate => comparisonKey(field, candidate.value)));
  if (keys.size > 1) return { discrepancy: present };
  return { value: present[0].value, sources: present.map(candidate => candidate.source) };
}

// ---------------------------------------------------------------------------
// Red y caché (fuera del repo)
// ---------------------------------------------------------------------------

export const PUBLIC_SOURCES = Object.freeze({
  openlibrary: { url: isbn => `https://openlibrary.org/isbn/${isbn}.json`, map: (json, _isbn, now) => mapOpenLibraryEdition(json, now) },
  googlebooks: { url: isbn => `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`, map: mapGoogleBooksVolumes, notFound: body => !Array.isArray(body?.items) || !body.items.length },
});

export function defaultCacheDir() {
  return process.env.ISBN_SOURCES_CACHE || path.join(os.homedir(), '.cache', 'isbn-fuentes-publicas');
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Identificación genérica: sin nombre, mail ni sitio.
const HEADERS = Object.freeze({ accept: 'application/json', 'user-agent': 'isbn-attribute-plan/1.0' });
const BLOCK_AFTER = 3;

async function readCache(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

/**
 * Consulta las fuentes públicas para una lista de ISBN-13 ya normalizados.
 * Devuelve { byIsbn: Map(isbn -> { openlibrary, googlebooks }), stats }.
 * Sólo se guardan en caché las respuestas definitivas (200 y 404). Una fuente
 * que responde 429/403 tres veces seguidas se deja de consultar en la corrida.
 */
export async function lookupIsbns(isbns, { limit = 300, cacheDir = defaultCacheDir(), fetcher = fetch, wait = sleep, pauseMs = 1100, sources = PUBLIC_SOURCES, now = new Date() } = {}) {
  const list = [...new Set(isbns)].filter(isbn => /^97[89]\d{10}$/.test(isbn)).slice(0, limit);
  const byIsbn = new Map();
  const stats = { requested: list.length, sources: {} };
  const blocked = {};
  for (const name of Object.keys(sources)) {
    stats.sources[name] = { with_data: 0, not_found: 0, without_usable_data: 0, errors: 0, skipped_blocked: 0, from_cache: 0, network_calls: 0 };
    blocked[name] = 0;
    await mkdir(path.join(cacheDir, name), { recursive: true });
  }
  for (const isbn of list) {
    const entry = {};
    let usedNetwork = false;
    for (const [name, source] of Object.entries(sources)) {
      const stat = stats.sources[name];
      const file = path.join(cacheDir, name, `${isbn}.json`);
      let cached = await readCache(file);
      if (cached) stat.from_cache += 1;
      else if (blocked[name] >= BLOCK_AFTER) { stat.skipped_blocked += 1; entry[name] = null; continue; }
      else {
        usedNetwork = true;
        stat.network_calls += 1;
        try {
          const response = await fetcher(source.url(isbn), { headers: HEADERS });
          if (response.status === 200) cached = { status: 200, body: await response.json() };
          else if (response.status === 404) cached = { status: 404, body: null };
          else {
            blocked[name] = [429, 403].includes(response.status) ? blocked[name] + 1 : 0;
            stat.errors += 1; entry[name] = null; continue;
          }
          blocked[name] = 0;
          await writeFile(file, JSON.stringify(cached));
        } catch {
          stat.errors += 1; entry[name] = null; continue;
        }
      }
      const facts = cached.status === 200 ? source.map(cached.body, isbn, now) : null;
      if (cached.status === 404 || source.notFound?.(cached.body)) stat.not_found += 1;
      else if (facts) stat.with_data += 1;
      else stat.without_usable_data += 1;
      entry[name] = facts;
    }
    byIsbn.set(isbn, entry);
    if (usedNetwork) await wait(pauseMs);
  }
  return { byIsbn, stats };
}
