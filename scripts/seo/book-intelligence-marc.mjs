// SOURCE-COVERAGE-4
// Parseo compartido de catálogos bibliográficos que exponen SRU + MARCXML.
//
// Se extrajo tal cual del adaptador de BNE, que ya lo tenía probado: varias
// bibliotecas nacionales publican el mismo MARC 21 sobre el mismo protocolo,
// así que duplicar el parseo por catálogo sólo multiplicaría los errores.

import { normalizeValidIsbn } from '../../functions/_shared/showcase-ranking.js';
import { bookLanguageLabel, normalizeBookLanguage } from '../../functions/_shared/book-bibliographic-normalization.js';

export function clean(value) {
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

export function unprefixedBlocks(xml, tagName) {
  const pattern = new RegExp(
    `<${tagName}\\b([^>]*)>([\\s\\S]*?)<\\/${tagName}>`,
    'gi',
  );
  return [...String(xml ?? '').matchAll(pattern)].map(match => ({
    attributes: match[1] || '',
    body: match[2] || '',
  }));
}

export function parseMarcRecord(xml) {
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

export function firstSubfield(record, tags, codes) {
  return subfieldValues(record, tags, codes)[0] || '';
}

export function controlfield(record, tag) {
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

export function recordIsbns(record) {
  return [...new Set(
    subfieldValues(record, '020', 'a')
      .map(normalizeIsbnText)
      .filter(Boolean),
  )];
}

function stripTerminalPunctuation(value) {
  return clean(value).replace(/[\s\/:;,=]+$/g, '').trim();
}

export function titleValue(record) {
  return stripTerminalPunctuation(
    subfieldValues(record, '245', ['a', 'b', 'n', 'p'])
      .map(stripTerminalPunctuation)
      .filter(Boolean)
      .join(' : '),
  );
}

export function authorValue(record) {
  const main = firstSubfield(record, ['100', '110', '111'], 'a');
  if (main) return stripTerminalPunctuation(main);
  return stripTerminalPunctuation(firstSubfield(record, '700', 'a'));
}

export function publisherValue(record) {
  return stripTerminalPunctuation(
    firstSubfield(record, '264', 'b') || firstSubfield(record, '260', 'b'),
  ) || null;
}

function yearFromDate(value) {
  const match = clean(value).match(/\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/);
  return match ? match[1] : null;
}

export function publicationYear(record) {
  return yearFromDate(firstSubfield(record, '264', 'c') || firstSubfield(record, '260', 'c'));
}

export function pageCount(record) {
  const physical = firstSubfield(record, '300', 'a');
  const match = physical.match(/\b(\d{1,5})\s*(?:p\.?|pages?|p[aá]g(?:inas?)?\.?)/i);
  if (!match) return null;
  const pages = Number(match[1]);
  return Number.isInteger(pages) && pages > 0 ? pages : null;
}

// MARC 21 campo 041: $a es el idioma del texto de ESTA edición, $h el de la
// obra original y $d el del contenido cantado o hablado. Sólo $a describe lo
// que el lector recibe: mezclarlos convierte una traducción
// (041 1#$aspa$heng) en un falso "Español, Inglés". Para un libro impreso $d
// no aplica. Se leen todos los $a repetidos, que sí indican una edición
// realmente multilingüe (041 0#$aspa$aeng).
//
// Un código que no se puede traducir a etiqueta se descarta en vez de
// publicarse crudo: es preferible no informar el idioma antes que mostrar
// "dut" en una ficha.
export function languageValue(record) {
  const labels = [...new Set(subfieldValues(record, '041', 'a'))]
    .map(bookLanguageLabel)
    .filter(Boolean);
  return labels.length ? normalizeBookLanguage(labels.join(', ')) : null;
}

export function summaryValue(record) {
  return subfieldValues(record, '520', ['a', 'b'])
    .map(stripTerminalPunctuation)
    .filter(Boolean)
    .join(' ');
}

export function topicValues(record) {
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

