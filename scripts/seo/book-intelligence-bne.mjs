// FICHAS-VIDRIERA-2 / SOURCE-COVERAGE-3
// Adaptador oficial de Biblioteca Nacional de España (BNE) vía SRU 1.2 + MARCXML.
//
// Contrato:
// - consulta por alma.isbn exacto;
// - revalida el ISBN dentro de MARC 020$a;
// - no requiere API key ni usuario/contraseña;
// - devuelve evidencia `national_library`, nunca copy final;
// - sólo se usa offline/batch, nunca en una request de cliente.

import { normalizeValidIsbn } from '../../functions/_shared/showcase-ranking.js';
import {
  authorValue,
  clean,
  controlfield,
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

export const BNE_SRU_BASE = 'https://catalogo.bne.es/view/sru/34BNE_INST';
export const BNE_MAX_RECORDS = 5;

export function buildBneUrl(isbn, { maximumRecords = BNE_MAX_RECORDS } = {}) {
  const normalized = normalizeValidIsbn(isbn);
  if (!normalized) throw new Error('ISBN inválido para BNE.');
  const limit = Number.isInteger(Number(maximumRecords))
    ? Math.min(Math.max(Number(maximumRecords), 1), 50)
    : BNE_MAX_RECORDS;
  const url = new URL(BNE_SRU_BASE);
  url.searchParams.set('operation', 'searchRetrieve');
  url.searchParams.set('version', '1.2');
  url.searchParams.set('query', `alma.isbn="${normalized}"`);
  url.searchParams.set('recordSchema', 'marcxml');
  url.searchParams.set('startRecord', '1');
  url.searchParams.set('maximumRecords', String(limit));
  return url.toString();
}

export function parseBneEvidence(xml, isbn) {
  const target = normalizeValidIsbn(isbn);
  if (!target) return [];
  const output = [];
  for (const recordBlock of unprefixedBlocks(xml, 'record')) {
    const record = parseMarcRecord(recordBlock.body);
    const identifiers = recordIsbns(record);
    if (!identifiers.includes(target)) continue;
    output.push({
      source: 'national_library',
      source_provider: 'biblioteca_nacional_espana',
      source_id: clean(controlfield(record, '001')) || null,
      source_url: buildBneUrl(target),
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
        catalog: 'BNE',
      },
    });
  }
  return output;
}

async function fetchText(url, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 12_000,
} = {}) {
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

export async function fetchBneEvidence(isbn, { fetchImpl, timeoutMs } = {}) {
  const url = buildBneUrl(isbn);
  const xml = await fetchText(url, { fetchImpl, timeoutMs });
  return parseBneEvidence(xml, isbn);
}
