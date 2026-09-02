#!/usr/bin/env node

// B11.2 — RESOLVER-CONFLICTOS-REVISAR-1
//
// Reprocesa el pool REVISAR dejado por la investigación de B11.1 (ISBN con
// evidencia real pero con un conflicto de identidad no resuelto entre el
// catálogo y una sola fuente débil). No vuelve a golpear APIs externas: usa
// la evidencia ya investigada y commiteada (report + source-cache).
//
// Regla de resolución automática: un ISBN pasa de REVISAR a PUBLICABLE
// cuando existen al menos DOS registros de fuentes independientes (Google
// Books, Open Library, BNE) que coinciden entre sí en título normalizado,
// autor, editorial y año — sin que ninguno de los dos tenga un valor real
// que contradiga al otro (un campo ausente en un lado nunca cuenta como
// conflicto). Esa coincidencia cruzada reemplaza la comparación contra el
// título/autor —a menudo pobre o ausente— del propio catálogo, que era la
// causa de la mayoría de los REVISAR de B11.1.
//
// Estados persistentes por ISBN (nunca se reprocesa un TERMINADO):
// - TERMINADO: identidad confirmada por consenso Y al menos un hecho
//   bibliográfico con evidencia suficiente (1 fuente oficial o 2
//   independientes) — se integra al registry en este mismo lote.
// - SIN_DATOS: identidad confirmada pero sin ningún hecho publicable con
//   evidencia suficiente — no se inventa contenido para llenar el vacío.
// - REVISAR: sigue sin poder confirmarse con la evidencia disponible.
//
// El estado se guarda en STATE_PATH (commiteado) y es acumulativo: cada
// corrida excluye los ISBN ya TERMINADO y retoma los REVISAR restantes.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { normalizeValidIsbn } from '../../functions/_shared/showcase-ranking.js';
import { isGenericAuthor } from '../../functions/_shared/generic-author.js';
import { normalizeBookLanguage } from '../../functions/_shared/book-bibliographic-normalization.js';
import { listBookEnrichments, validateBookEnrichment } from '../../functions/_shared/book-enrichment-registry.js';
import { titlesCompatible, authorsCompatible as authorsCompatibleBase } from './book-editorial-cohort-2000.mjs';

const STATE_PATH = process.env.B11_2_STATE_PATH || 'artifacts/b11-2/state.json';
const REPORT_PATH = process.env.B11_2_REPORT_PATH || 'artifacts/book-intelligence/lote-01/isbn-1000-report.json';
const CACHE_PATH = process.env.B11_2_CACHE_PATH || 'artifacts/book-intelligence/lote-01/source-cache.json';
const OUTPUT_FACTS_PATH = process.env.B11_2_FACTS_OUTPUT || 'functions/_shared/book-enrichment-facts-b11-2-lote-01.js';
const SUMMARY_PATH = process.env.B11_2_SUMMARY_PATH || 'artifacts/b11-2/lote-01-summary.md';
const BATCH_SIZE = positiveInt(process.env.B11_2_BATCH_SIZE, 100);
const BATCH_NAME = process.env.B11_2_BATCH_NAME || 'b11-2-lote-01';
const SOURCES = Object.freeze(['google_books', 'open_library', 'bne']);
const EDITION_FIELDS = Object.freeze(['author', 'publisher', 'pages', 'language', 'format', 'edition', 'publication_year']);

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizedComparable(value) {
  const text = clean(value);
  if (!text) return null;
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLocaleLowerCase('es')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim() || null;
}

function fieldsAgree(a, b, field) {
  const rawA = field === 'language' ? normalizeBookLanguage(a) : a;
  const rawB = field === 'language' ? normalizeBookLanguage(b) : b;
  const normA = normalizedComparable(rawA);
  const normB = normalizedComparable(rawB);
  if (!normA || !normB) return true; // ausente en un lado: no es un choque
  return normA === normB;
}

function authorsCompatible(a, b) {
  if (isGenericAuthor(a) || isGenericAuthor(b)) return true;
  return authorsCompatibleBase(a, b);
}

function readJson(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function loadState() {
  return readJson(STATE_PATH, { schema_version: 1, entries: {} });
}

function saveState(state) {
  mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

function recordsFor(cache, isbn) {
  const entry = cache?.entries?.[isbn] || {};
  return SOURCES.flatMap(source =>
    Array.isArray(entry?.[source]?.records)
      ? entry[source].records
        .filter(record => normalizeValidIsbn(record?.isbn) === isbn)
        .map(record => ({ ...record, source }))
      : [],
  );
}

// Busca un par de registros de fuentes distintas que se corroboren entre sí
// en título, autor, editorial y año. Un campo ausente en cualquiera de los
// dos nunca bloquea la coincidencia — solo un valor real que contradiga al
// otro cuenta como conflicto.
export function findConsensusPair(records) {
  for (let i = 0; i < records.length; i += 1) {
    for (let j = i + 1; j < records.length; j += 1) {
      const a = records[i];
      const b = records[j];
      if (a.source === b.source) continue;
      if (!titlesCompatible(a.title, b.title)) continue;
      if (!authorsCompatible(a.author, b.author)) continue;
      if (!fieldsAgree(a.publisher, b.publisher, 'publisher')) continue;
      if (!fieldsAgree(a.publication_year, b.publication_year, 'publication_year')) continue;
      return [a, b];
    }
  }
  return null;
}

// Google Books a veces devuelve infoLink/selfLink en http://. El resto del
// pipeline (book-intelligence-project.mjs) ya sube esos dos dominios a
// https antes de validar; se replica el mismo criterio acá.
function httpsUrl(value, { source, isbn } = {}) {
  const text = clean(value);
  if (!text && source === 'open_library' && isbn) return `https://openlibrary.org/isbn/${isbn}`;
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

function sourceDescriptor(source) {
  if (source === 'bne') return { type: 'national_library', provider: 'Biblioteca Nacional de España', official: true };
  if (source === 'google_books') return { type: 'bibliographic_database', provider: 'Google Books', official: false };
  if (source === 'open_library') return { type: 'library_catalog', provider: 'Open Library', official: false };
  return null;
}

// Una vez confirmada la identidad por el par de consenso, computa hechos
// campo por campo usando TODA la evidencia exacta disponible para el ISBN
// (no solo el par). Un campo solo se publica si, entre los registros que
// coinciden en su valor normalizado, hay una fuente oficial o dos
// proveedores independientes — el mismo umbral que usa el resto de B11.
export function buildFactsFromConsensus(isbn, verifiedAt, allRecords) {
  const facts = {};
  const bibliographic = {};
  const provenanceByKey = new Map();

  function addProvenance(record, field) {
    const descriptor = sourceDescriptor(record.source);
    if (!descriptor) return;
    const url = httpsUrl(record.source_url, { source: record.source, isbn });
    if (!url) return;
    const key = `${descriptor.type} ${descriptor.provider}`;
    const current = provenanceByKey.get(key) || {
      type: descriptor.type,
      provider: descriptor.provider,
      url,
      relationship: 'exact_edition',
      isbn,
      verified_at: verifiedAt,
      fields: [],
    };
    if (!current.fields.includes(field)) current.fields.push(field);
    provenanceByKey.set(key, current);
  }

  for (const field of EDITION_FIELDS) {
    const values = allRecords
      .map(record => ({ record, value: record[field] }))
      .filter(({ value }) => value !== null && value !== undefined && clean(value));
    if (!values.length) continue;

    const groups = new Map();
    for (const { record, value } of values) {
      const normalizedValue = field === 'language' ? normalizeBookLanguage(value) : value;
      const key = normalizedComparable(normalizedValue);
      if (!key) continue;
      const current = groups.get(key) || { value, records: [] };
      current.records.push(record);
      groups.set(key, current);
    }
    if (groups.size !== 1) continue; // valores reales que no coinciden entre si: no se publica

    const [{ value, records: supportRecords }] = [...groups.values()];
    const descriptors = supportRecords.map(record => sourceDescriptor(record.source)).filter(Boolean);
    const hasOfficial = descriptors.some(descriptor => descriptor.official);
    const providers = new Set(descriptors.map(descriptor => descriptor.provider));
    if (!hasOfficial && providers.size < 2) continue; // evidencia insuficiente para publicar

    if (field === 'author') {
      if (!isGenericAuthor(value)) facts.author = clean(value);
      else continue;
    } else if (field === 'publisher') {
      facts.publisher = clean(value);
    } else if (field === 'pages') {
      const numericPages = Number(value);
      if (numericPages > 0) facts.pages = numericPages;
      else continue;
    } else if (field === 'language') {
      const language = clean(normalizeBookLanguage(value));
      if (language) bibliographic.language = language;
      else continue;
    } else {
      bibliographic[field] = clean(value);
    }
    for (const record of supportRecords) addProvenance(record, field);
  }

  if (Object.keys(bibliographic).length) facts.bibliographic = bibliographic;
  return { facts, provenance: [...provenanceByKey.values()] };
}

function renderFactsModule(entries) {
  const payload = JSON.stringify(entries, null, 2);
  return `// Generado por scripts/seo/b11-2-resolve-revisar.mjs. NO EDITAR A MANO.\n` +
    `// Hechos verificados por consenso cruzado de fuentes independientes,\n` +
    `// resolviendo conflictos de identidad del pool REVISAR de B11.1.\n\n` +
    `export const BOOK_FACT_ENRICHMENTS = Object.freeze(${payload});\n`;
}

function summaryMarkdown({ batchName, candidatesTotal, batchSize, resolved, stillReview, noData, durationMs }) {
  return [
    `# B11.2 — ${batchName}`,
    '',
    `- Generado: ${new Date().toISOString()}`,
    `- Candidatos REVISAR disponibles antes de esta corrida: ${candidatesTotal}.`,
    `- Procesados en este lote: ${batchSize}.`,
    `- Resueltos automáticamente (TERMINADO, integrados): ${resolved}.`,
    `- Identidad confirmada pero sin hechos publicables (SIN_DATOS): ${noData}.`,
    `- Siguen en REVISAR: ${stillReview}.`,
    `- Duración: ${(durationMs / 1000).toFixed(1)}s.`,
    '',
    '## Regla aplicada',
    '',
    '- PUBLICABLE/TERMINADO exige un par de fuentes independientes que',
    '  coincidan en título normalizado, autor, editorial y año (ausencia en',
    '  un lado nunca cuenta como conflicto).',
    '- Cada hecho publicado exige además su propio umbral de evidencia (1',
    '  fuente oficial o 2 independientes), igual que el resto de B11.',
    '- No se reprocesan ISBN ya TERMINADO en corridas anteriores.',
    '- Título, H1, slug, precio, stock, imágenes y datos comerciales no se',
    '  tocan: este lote solo agrega hechos bibliográficos ausentes.',
  ].join('\n') + '\n';
}

async function main() {
  const startedAt = Date.now();
  const report = readJson(REPORT_PATH, null);
  const cache = readJson(CACHE_PATH, null);
  if (!report || !cache) {
    throw new Error(`Falta investigación previa en ${REPORT_PATH} o ${CACHE_PATH}.`);
  }

  const state = loadState();
  const alreadyEnriched = new Set(listBookEnrichments().map(entry => entry.isbn));

  // Sin llamadas de red nuevas, reintentar un ISBN ya evaluado en un lote
  // anterior (REVISAR o SIN_DATOS) da exactamente el mismo resultado — la
  // evidencia (report/cache) no cambió. Cada lote debe avanzar sobre ISBN
  // sin ningún intento previo, no repetir los ya intentados.
  const revisarCandidates = report.results
    .filter(result => result.publication_class === 'REVIEW')
    .map(result => normalizeValidIsbn(result.isbn))
    .filter(Boolean)
    .filter(isbn => !alreadyEnriched.has(isbn))
    .filter(isbn => !state.entries[isbn])
    .sort((a, b) => a.localeCompare(b));

  const batch = revisarCandidates.slice(0, BATCH_SIZE);
  const verifiedAt = new Date().toISOString().slice(0, 10);
  const newFacts = [];
  let resolved = 0;
  let stillReview = 0;
  let noData = 0;

  for (const isbn of batch) {
    const records = recordsFor(cache, isbn);
    const consensusPair = findConsensusPair(records);
    if (!consensusPair) {
      state.entries[isbn] = { status: 'REVISAR', updated_at: verifiedAt, batch: BATCH_NAME, reason: 'sin_par_de_consenso' };
      stillReview += 1;
      continue;
    }

    const { facts, provenance } = buildFactsFromConsensus(isbn, verifiedAt, records);
    if (!Object.keys(facts).length || !provenance.length) {
      state.entries[isbn] = {
        status: 'SIN_DATOS',
        updated_at: verifiedAt,
        batch: BATCH_NAME,
        reason: 'identidad_confirmada_sin_hechos_publicables',
      };
      noData += 1;
      continue;
    }

    const representative = report.results.find(result => normalizeValidIsbn(result.isbn) === isbn);
    const sampleListingId = /^MLU\d+$/.test(clean(representative?.id).toUpperCase())
      ? clean(representative.id).toUpperCase()
      : null;

    const entry = {
      schema_version: 1,
      isbn,
      sample_listing_id: sampleListingId,
      decision: 'auto_publish_facts',
      verified_at: verifiedAt,
      facts,
      provenance: provenance
        .map(source => ({ ...source, fields: source.fields.sort() }))
        .sort((a, b) => a.provider.localeCompare(b.provider)),
    };

    if (!validateBookEnrichment(entry)) {
      // No debería ocurrir dado el umbral aplicado arriba, pero si pasa no
      // se publica un dato sin respaldo suficiente: queda para revisión.
      state.entries[isbn] = { status: 'REVISAR', updated_at: verifiedAt, batch: BATCH_NAME, reason: 'no_paso_validacion_final' };
      stillReview += 1;
      continue;
    }

    newFacts.push(entry);
    state.entries[isbn] = { status: 'TERMINADO', updated_at: verifiedAt, batch: BATCH_NAME, reason: 'identidad_confirmada_por_consenso' };
    resolved += 1;
  }

  newFacts.sort((a, b) => a.isbn.localeCompare(b.isbn));
  mkdirSync(path.dirname(OUTPUT_FACTS_PATH), { recursive: true });
  writeFileSync(OUTPUT_FACTS_PATH, renderFactsModule(newFacts));
  saveState(state);

  const summary = summaryMarkdown({
    batchName: BATCH_NAME,
    candidatesTotal: revisarCandidates.length,
    batchSize: batch.length,
    resolved,
    stillReview,
    noData,
    durationMs: Date.now() - startedAt,
  });
  mkdirSync(path.dirname(SUMMARY_PATH), { recursive: true });
  writeFileSync(SUMMARY_PATH, summary);
  process.stdout.write(summary);
  process.stdout.write(JSON.stringify({ resolved, stillReview, noData, batchSize: batch.length }) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`[b11-2-resolve-revisar] ERROR: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
