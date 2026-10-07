// SOURCE-COVERAGE-4
// Adaptador de bibliotecas nacionales adicionales vía SRU + MARCXML.
//
// Por qué existe: en la corrida 34004157966, 778 de 2.005 ISBN tenían UNA
// sola familia de fuente. El gate de publicación exige una fuente oficial o
// dos familias independientes, así que esos 778 quedaban bloqueados por
// falta de una segunda opinión, no por falta de calidad del dato.
//
// La salida correcta no es relajar el gate —eso publicaría datos con menos
// respaldo— sino sumar catálogos oficiales reales. Una biblioteca nacional
// es `national_library`: trust 5 y `official`, el mismo nivel que BNE.
//
// Contrato, idéntico al de BNE:
// - se consulta por ISBN exacto;
// - se revalida el ISBN dentro de MARC 020$a antes de aceptar el registro;
// - no requiere API key;
// - devuelve evidencia, nunca copy final;
// - sólo se usa en batch, nunca en una request de cliente.

import { normalizeValidIsbn } from '../../functions/_shared/showcase-ranking.js';
import {
  authorValue,
  clean,
  controlfield,
  firstSubfield,
  languageValue,
  pageCount,
  parseMarcRecord,
  publicationYear,
  publisherValue,
  recordIsbns,
  summaryValue,
  titleValue,
  topicValues,
  unprefixedBlocks,
} from './book-intelligence-marc.mjs';

export const NATIONAL_LIBRARIES = Object.freeze({
  loc: Object.freeze({
    provider: 'library_of_congress',
    catalog: 'LoC',
    base: 'http://lx2.loc.gov:210/lcdb',
    version: '1.1',
    recordSchema: 'marcxml',
    query: isbn => `bath.isbn=${isbn}`,
  }),
  dnb: Object.freeze({
    provider: 'deutsche_nationalbibliothek',
    catalog: 'DNB',
    base: 'https://services.dnb.de/sru/dnb',
    version: '1.1',
    recordSchema: 'MARC21-xml',
    query: isbn => `NUM=${isbn}`,
  }),
});

export const NATIONAL_LIBRARY_MAX_RECORDS = 5;

// La URL de procedencia es una CITA: tiene que poder abrirse y ser estable.
// La consulta SRU no sirve para eso —la de LoC ni siquiera es HTTPS, va por
// el puerto 210— así que se publica el permalink canónico del catálogo:
// lccn.loc.gov para LoC (MARC 010$a) y d-nb.info para DNB (control 001).
export function citationUrl(key, record, isbn) {
  if (key === 'loc') {
    const lccn = clean(firstSubfield(record, '010', 'a')).replace(/\s+/g, '');
    return lccn ? `https://lccn.loc.gov/${lccn}` : `https://www.loc.gov/search/?q=${isbn}`;
  }
  if (key === 'dnb') {
    const idn = clean(controlfield(record, '001'));
    return idn ? `https://d-nb.info/${idn}` : `https://portal.dnb.de/opac/simpleSearch?query=${isbn}`;
  }
  return null;
}

export function buildNationalLibraryUrl(key, isbn, { maximumRecords = NATIONAL_LIBRARY_MAX_RECORDS } = {}) {
  const config = NATIONAL_LIBRARIES[key];
  if (!config) throw new Error(`Biblioteca nacional desconocida: ${key}`);
  const normalized = normalizeValidIsbn(isbn);
  if (!normalized) throw new Error(`ISBN inválido para ${config.catalog}.`);
  const limit = Number.isInteger(Number(maximumRecords))
    ? Math.min(Math.max(Number(maximumRecords), 1), 50)
    : NATIONAL_LIBRARY_MAX_RECORDS;
  const url = new URL(config.base);
  url.searchParams.set('operation', 'searchRetrieve');
  url.searchParams.set('version', config.version);
  url.searchParams.set('query', config.query(normalized));
  url.searchParams.set('recordSchema', config.recordSchema);
  url.searchParams.set('startRecord', '1');
  url.searchParams.set('maximumRecords', String(limit));
  return url.toString();
}

export function parseNationalLibraryEvidence(key, xml, isbn) {
  const config = NATIONAL_LIBRARIES[key];
  if (!config) throw new Error(`Biblioteca nacional desconocida: ${key}`);
  const target = normalizeValidIsbn(isbn);
  if (!target) return [];
  const output = [];
  for (const recordBlock of unprefixedBlocks(xml, 'record')) {
    const record = parseMarcRecord(recordBlock.body);
    const identifiers = recordIsbns(record);
    // El ISBN pedido tiene que estar en el propio registro: sin esto un
    // catálogo que devuelve "lo más parecido" traería datos de otra edición.
    if (!identifiers.includes(target)) continue;
    output.push({
      source: 'national_library',
      source_provider: config.provider,
      source_id: clean(controlfield(record, '001')) || null,
      source_url: citationUrl(key, record, target),
      isbn: target,
      title: titleValue(record),
      author: authorValue(record),
      description: summaryValue(record),
      publisher: publisherValue(record),
      pages: pageCount(record),
      language: languageValue(record),
      publication_year: publicationYear(record),
      format: null,
      topics: topicValues(record),
      raw_quality: {
        exact_isbn: true,
        identifiers,
        catalog: config.catalog,
      },
    });
  }
  return output;
}

async function fetchText(url, { fetchImpl = globalThis.fetch, timeoutMs = 12_000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch no disponible.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: {
        accept: 'application/xml,text/xml;q=0.9,*/*;q=0.1',
        'user-agent': 'AmadoLibros-BookIntelligence/1.0',
      },
      signal: controller.signal,
    });
    if (!response?.ok) throw new Error(`HTTP ${response?.status || 0}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchNationalLibraryEvidence(key, isbn, { fetchImpl, timeoutMs } = {}) {
  const url = buildNationalLibraryUrl(key, isbn);
  const xml = await fetchText(url, { fetchImpl, timeoutMs });
  return parseNationalLibraryEvidence(key, xml, isbn);
}
