// FICHAS-VIDRIERA-2 / SOURCE-COVERAGE-3
// Adaptador oficial de Biblioteca Nacional de España (BNE) vía SRU 1.2 + MARCXML.
//
// Contrato:
// - consulta por alma.isbn exacto;
// - revalida el ISBN dentro de MARC 020$a;
// - no requiere API key ni usuario/contraseña;
// - devuelve evidencia `library_catalog`, nunca copy final;
// - sólo se usa offline/batch, nunca en una request de cliente.

import { normalizeValidIsbn } from '../../functions/_shared/showcase-ranking.js';

export const BNE_SRU_BASE = 'https://catalogo.bne.es/view/sru/34BNE_INST';
export const BNE_MAX_RECORDS = 5;

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function decodeXml(value) {
  return clean(String(value ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'"));
}

function attrValue(attributes, name) {
  const match = String(attributes ?? '').match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i'));
  return match ? decodeXml(match[1]) : '';
}

function blocks(xml, tagName) {
  const pattern = new RegExp(
    `<(?:[\\w.-]+:)?${tagName}\\b([^>]*)>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${tagName}>`,
    'gi',
  );
  return [...String(xml ?? '').matchAll(pattern)].map(match => ({
    attributes: match[1] || '',
    body: match[2] || '',
  }));
}

function unprefixedBlocks(xml, tagName) {
  const pattern = new RegExp(
    `<${tagName}\\b([^>]*)>([\\s\\S]*?)<\\/${tagName}>`,
    'gi',
  );
  return [...String(xml ?? '').matchAll(pattern)].map(match => ({
    attributes: match[1] || '',
    body: match[2] || '',
  }));
}

function parseMarcRecord(xml) {
  const controlfields = blocks(xml, 'controlfield').map(block => ({
    tag: attrValue(block.attributes, 'tag'),
    value: decodeXml(block.body.replace(/<[^>]+>/g, ' ')),
  }));

  const datafields = blocks(xml, 'datafield').map(field => ({
    tag: attrValue(field.attributes, 'tag'),
    subfields: blocks(field.body, 'subfield').map(subfield => ({
      code: attrValue(subfield.attributes, 'code'),
      value: decodeXml(subfield.body.replace(/<[^>]+>/g, ' ')),
    })),
  }));

  return { controlfields, datafields };
}

function fields(record, tags) {
  const wanted = new Set(Array.isArray(tags) ? tags : [tags]);
  return record.datafields.filter(field => wanted.has(field.tag));
}

function subfieldValues(record, tags, codes) {
  const wantedCodes = new Set(Array.isArray(codes) ? codes : [codes]);
  return fields(record, tags).flatMap(field =>
    field.subfields
      .filter(subfield => wantedCodes.has(subfield.code))
      .map(subfield => clean(subfield.value))
      .filter(Boolean),
  );
}

function firstSubfield(record, tags, codes) {
  return subfieldValues(record, tags, codes)[0] || '';
}

function controlfield(record, tag) {
  return record.controlfields.find(field => field.tag === tag)?.value || '';
}

function normalizeIsbnText(value) {
  const direct = normalizeValidIsbn(clean(value));
  if (direct) return direct;
  const candidates = String(value ?? '').match(/(?:97[89][0-9\s-]{10,20}|[0-9][0-9Xx\s-]{8,18})/g) || [];
  for (const candidate of candidates) {
    const normalized = normalizeValidIsbn(candidate);
    if (normalized) return normalized;
  }
  return null;
}

function recordIsbns(record) {
  return [...new Set(
    subfieldValues(record, '020', 'a')
      .map(normalizeIsbnText)
      .filter(Boolean),
  )];
}

function stripTerminalPunctuation(value) {
  return clean(value).replace(/[\s\/:;,=]+$/g, '').trim();
}

function titleValue(record) {
  return stripTerminalPunctuation(
    subfieldValues(record, '245', ['a', 'b', 'n', 'p'])
      .map(stripTerminalPunctuation)
      .filter(Boolean)
      .join(' : '),
  );
}

function authorValue(record) {
  const main = firstSubfield(record, ['100', '110', '111'], 'a');
  if (main) return stripTerminalPunctuation(main);
  return stripTerminalPunctuation(firstSubfield(record, '700', 'a'));
}

function publisherValue(record) {
  return stripTerminalPunctuation(
    firstSubfield(record, '264', 'b') || firstSubfield(record, '260', 'b'),
  ) || null;
}

function yearFromDate(value) {
  const match = clean(value).match(/\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/);
  return match ? match[1] : null;
}

function publicationYear(record) {
  return yearFromDate(firstSubfield(record, '264', 'c') || firstSubfield(record, '260', 'c'));
}

function pageCount(record) {
  const physical = firstSubfield(record, '300', 'a');
  const match = physical.match(/\b(\d{1,5})\s*(?:p\.?|pages?|p[aá]g(?:inas?)?\.?)/i);
  if (!match) return null;
  const pages = Number(match[1]);
  return Number.isInteger(pages) && pages > 0 ? pages : null;
}

function languageValue(record) {
  const values = [...new Set(subfieldValues(record, '041', ['a', 'd', 'h']))];
  return values.length ? values.join(', ') : null;
}

function summaryValue(record) {
  return subfieldValues(record, '520', ['a', 'b'])
    .map(stripTerminalPunctuation)
    .filter(Boolean)
    .join(' ');
}

function topicValues(record) {
  const subjectTags = new Set(['600', '610', '611', '630', '648', '650', '651', '655']);
  const topics = [];
  for (const field of record.datafields) {
    if (!subjectTags.has(field.tag)) continue;
    const parts = field.subfields
      .filter(subfield => ['a', 'x', 'y', 'z', 'v'].includes(subfield.code))
      .map(subfield => stripTerminalPunctuation(subfield.value))
      .filter(Boolean);
    if (parts.length) topics.push(parts.join(' — '));
  }
  return [...new Set(topics)].slice(0, 12);
}

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
      source: 'library_catalog',
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
