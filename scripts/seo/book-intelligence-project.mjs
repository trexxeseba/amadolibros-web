#!/usr/bin/env node

// Proyecta el manifiesto revisable de investigación a un módulo ESM compacto
// consumido por el gateway único de #247. No incluye sinopsis fuente ni datos
// comerciales y vuelve a verificar el apoyo de cada campo antes de escribir.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { normalizeValidIsbn } from '../../functions/_shared/showcase-ranking.js';
import { normalizeBookLanguage } from '../../functions/_shared/book-bibliographic-normalization.js';
import { CACHEABLE_SOURCES } from './book-intelligence-sources.mjs';

const DEFAULT_MANIFEST = 'artifacts/book-intelligence/isbn-1000/isbn-1000-manifest.json';
const DEFAULT_CACHE = 'artifacts/book-intelligence/isbn-1000/source-cache.json';
const DEFAULT_OUTPUT = 'functions/_shared/book-enrichment-facts-1000.js';
const ALLOWED_FIELDS = Object.freeze([
  'author', 'publisher', 'pages', 'language', 'format', 'edition', 'publication_year', 'topics',
]);

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function comparable(value, field = '') {
  if (field === 'language') value = normalizeBookLanguage(value);
  if (field === 'format' && clean(value).toUpperCase() === 'BOOK') value = '';
  if (typeof value === 'number') return String(value);
  return clean(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function httpsUrl(value, { source, isbn } = {}) {
  const text = clean(value);
  if (!text && source === 'open_library' && isbn) {
    return `https://openlibrary.org/isbn/${isbn}`;
  }
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol === 'http:' && /(^|\.)google\.|(^|\.)openlibrary\.org$/i.test(url.hostname)) {
      url.protocol = 'https:';
    }
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

// Cada biblioteca nacional es un proveedor DISTINTO. Colapsarlas todas en
// "Biblioteca Nacional de España" no sólo mentiría en la procedencia: haría
// que dos catálogos independientes contaran como uno solo al exigir dos
// proveedores para publicar un campo.
const NATIONAL_LIBRARY_PROVIDERS = Object.freeze({
  biblioteca_nacional_espana: 'Biblioteca Nacional de España',
  library_of_congress: 'Library of Congress',
  deutsche_nationalbibliothek: 'Deutsche Nationalbibliothek',
});

function sourceDescriptor(record) {
  const source = clean(record?.source);
  if (source === 'national_library') {
    const provider = NATIONAL_LIBRARY_PROVIDERS[clean(record?.source_provider)];
    // Una biblioteca que no reconocemos no se publica como oficial.
    if (!provider) return null;
    return { type: 'national_library', provider, official: true };
  }
  if (source === 'google_books') {
    return { type: 'bibliographic_database', provider: 'Google Books', official: false };
  }
  if (source === 'open_library') {
    return { type: 'library_catalog', provider: 'Open Library', official: false };
  }
  return null;
}

function recordsFor(cache, isbn) {
  const entry = cache?.entries?.[isbn] || {};
  return CACHEABLE_SOURCES.flatMap(source =>
    Array.isArray(entry?.[source]?.records) ? entry[source].records : [],
  );
}

function supportersForField(records, isbn, field, value) {
  if (field === 'topics') {
    const wanted = new Set((Array.isArray(value) ? value : [])
      .map(topic => comparable(topic, 'topics'))
      .filter(Boolean));
    return records.filter(record =>
      normalizeValidIsbn(record?.isbn) === isbn &&
      sourceDescriptor(record) &&
      (record?.topics || []).some(topic => wanted.has(comparable(topic, 'topics'))),
    );
  }
  return records.filter(record =>
    normalizeValidIsbn(record?.isbn) === isbn &&
    sourceDescriptor(record) &&
    comparable(record?.[field], field) === comparable(value, field),
  );
}

function assertFieldEvidence(records, isbn, field, value) {
  if (field === 'topics') {
    const all = [];
    for (const topic of Array.isArray(value) ? value : []) {
      const supporters = records.filter(record =>
        normalizeValidIsbn(record?.isbn) === isbn &&
        sourceDescriptor(record) &&
        (record?.topics || []).some(candidate => comparable(candidate, 'topics') === comparable(topic, 'topics')),
      );
      const descriptors = supporters.map(sourceDescriptor).filter(Boolean);
      if (!descriptors.some(source => source.official) && new Set(descriptors.map(source => source.provider)).size < 2) {
        throw new Error(`${isbn}.topics:${topic} no conserva evidencia suficiente en la caché.`);
      }
      all.push(...supporters);
    }
    return [...new Set(all)];
  }
  const supporters = supportersForField(records, isbn, field, value);
  const descriptors = supporters.map(sourceDescriptor).filter(Boolean);
  const providers = new Set(descriptors.map(source => source.provider));
  if (!descriptors.some(source => source.official) && providers.size < 2) {
    throw new Error(`${isbn}.${field} no conserva evidencia suficiente en la caché.`);
  }
  return supporters;
}

function factsShape(flatFacts) {
  const facts = {};
  const bibliography = {};
  if (clean(flatFacts.author)) facts.author = clean(flatFacts.author);
  if (clean(flatFacts.publisher)) facts.publisher = clean(flatFacts.publisher);
  if (Number(flatFacts.pages) > 0) facts.pages = Number(flatFacts.pages);
  for (const field of ['language', 'format', 'edition', 'publication_year']) {
    const value = field === 'language' ? normalizeBookLanguage(flatFacts[field]) : clean(flatFacts[field]);
    if (clean(value)) bibliography[field] = clean(value);
  }
  if (Array.isArray(flatFacts.topics) && flatFacts.topics.length) {
    bibliography.subjects = [...new Set(flatFacts.topics.map(clean).filter(Boolean))].slice(0, 6);
  }
  if (Object.keys(bibliography).length) facts.bibliographic = bibliography;
  return facts;
}

export function projectVerifiedFacts({ manifest, cache, expected = 1000 } = {}) {
  const entries = Array.isArray(manifest?.entries) ? manifest.entries : [];
  if (entries.length !== expected || new Set(entries.map(entry => entry.isbn)).size !== expected) {
    throw new Error(`La proyección exige ${expected} ISBN únicos; recibió ${entries.length}.`);
  }

  const verifiedAt = clean(manifest?.generated_at).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(verifiedAt)) throw new Error('generated_at inválido.');

  return entries.map(entry => {
    const isbn = normalizeValidIsbn(entry?.isbn);
    if (!isbn || isbn !== entry.isbn) throw new Error(`ISBN inválido: ${entry?.isbn || 'vacío'}.`);
    if (!['GREEN_FULL', 'GREEN_FACTS'].includes(entry?.decision)) {
      throw new Error(`${isbn} no tiene decisión publicable.`);
    }
    const flatFacts = Object.fromEntries(Object.entries(entry?.facts || {})
      .filter(([field]) => ALLOWED_FIELDS.includes(field)));
    if (!Object.keys(flatFacts).length) throw new Error(`${isbn} no aporta campos nuevos.`);

    const records = recordsFor(cache, isbn);
    const provenanceByProvider = new Map();
    for (const [field, value] of Object.entries(flatFacts)) {
      for (const record of assertFieldEvidence(records, isbn, field, value)) {
        const descriptor = sourceDescriptor(record);
        const url = httpsUrl(record?.source_url, { source: record?.source, isbn });
        if (!url) throw new Error(`${isbn}.${field} tiene una URL de evidencia inválida.`);
        const key = `${descriptor.type}\u0000${descriptor.provider}\u0000${url}`;
        const current = provenanceByProvider.get(key) || {
          type: descriptor.type,
          provider: descriptor.provider,
          url,
          relationship: 'exact_edition',
          isbn,
          verified_at: verifiedAt,
          fields: [],
        };
        if (!current.fields.includes(field)) current.fields.push(field);
        provenanceByProvider.set(key, current);
      }
    }

    return {
      schema_version: 1,
      isbn,
      sample_listing_id: /^MLU\d+$/.test(clean(entry?.representative_id).toUpperCase())
        ? clean(entry.representative_id).toUpperCase()
        : null,
      decision: 'auto_publish_facts',
      verified_at: verifiedAt,
      facts: factsShape(flatFacts),
      provenance: [...provenanceByProvider.values()]
        .map(source => ({ ...source, fields: source.fields.sort() }))
        .sort((a, b) => a.provider.localeCompare(b.provider)),
    };
  }).sort((a, b) => a.isbn.localeCompare(b.isbn));
}

export function renderFactsModule(entries) {
  const payload = JSON.stringify(entries, null, 2);
  return `// Generado por scripts/seo/book-intelligence-project.mjs. NO EDITAR A MANO.\n` +
    `// Sólo hechos ausentes, verificados por ISBN exacto; sin datos comerciales.\n\n` +
    `export const BOOK_FACT_ENRICHMENTS = Object.freeze(${payload});\n`;
}

function options(argv) {
  const output = { manifest: DEFAULT_MANIFEST, cache: DEFAULT_CACHE, output: DEFAULT_OUTPUT, expected: 1000 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--manifest') output.manifest = argv[++index];
    else if (flag === '--cache') output.cache = argv[++index];
    else if (flag === '--output') output.output = argv[++index];
    else if (flag === '--expected') output.expected = Number(argv[++index]);
    else throw new Error(`Argumento desconocido: ${flag}`);
  }
  return output;
}

async function main() {
  const config = options(process.argv.slice(2));
  const [manifest, cache] = await Promise.all([
    readFile(config.manifest, 'utf8').then(JSON.parse),
    readFile(config.cache, 'utf8').then(JSON.parse),
  ]);
  const entries = projectVerifiedFacts({ manifest, cache, expected: config.expected });
  await writeFile(config.output, renderFactsModule(entries));
  console.log(JSON.stringify({ projected_isbns: entries.length, output: path.resolve(config.output) }));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error(`[book-intelligence-project] ERROR: ${error?.message || error}`);
    process.exit(1);
  });
}
