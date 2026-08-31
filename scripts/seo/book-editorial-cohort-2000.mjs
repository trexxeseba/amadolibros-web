#!/usr/bin/env node

// B11-EDITORIAL-REAL-2000-1
// Prepara una cohorte de 2.000 ediciones activas para enriquecimiento editorial
// real. Este archivo NO publica copy y NO modifica datos comerciales: convierte
// la investigación bibliográfica en dossiers trazables para redacción/QA.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { CATALOG_URL } from '../../functions/_shared/catalog.js';
import { listBookEnrichments } from '../../functions/_shared/book-enrichment-registry.js';
import { normalizeValidIsbn } from '../../functions/_shared/showcase-ranking.js';
import { selectResearchCohort } from './book-intelligence-research-run.mjs';

export const DEFAULT_EDITORIAL_COHORT_LIMIT = 2000;
const DEFAULT_OUTPUT_DIR = 'artifacts/book-intelligence/editorial-real-2000';
const DEFAULT_CACHE_PATH = `${DEFAULT_OUTPUT_DIR}/source-cache.json`;
const SOURCE_KEYS = Object.freeze(['google_books', 'open_library', 'bne']);
const GENERIC_AUTHORS = new Set([
  '', 'desconocido', 'unknown', 'sin autor', 'varios autores', 'varios', 'vv aa',
  'vv.aa', 'n/a', 'na', 'anonimo', 'anónimo',
]);
const STOPWORDS = new Set([
  'del', 'las', 'los', 'una', 'uno', 'unos', 'unas', 'para', 'por', 'con', 'sin',
  'sobre', 'desde', 'hasta', 'entre', 'libro', 'edicion', 'edición', 'tomo', 'volumen',
  'the', 'and', 'for', 'with', 'from', 'book', 'edition', 'volume',
]);

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizedText(value) {
  return clean(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokens(value) {
  return normalizedText(value)
    .split(/\s+/)
    .filter(token => token.length >= 3 && !STOPWORDS.has(token));
}

function unique(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(clean).filter(Boolean))];
}

function overlapRatio(left, right) {
  const a = new Set(tokens(left));
  const b = new Set(tokens(right));
  if (!a.size || !b.size) return 1;
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap += 1;
  return overlap / Math.min(a.size, b.size);
}

export function titlesCompatible(candidateTitle, sourceTitle) {
  const candidate = normalizedText(candidateTitle);
  const source = normalizedText(sourceTitle);
  if (!candidate || !source) return true;
  if (candidate.includes(source) || source.includes(candidate)) return true;
  const candidateTokens = tokens(candidateTitle);
  const sourceTokens = tokens(sourceTitle);
  if (candidateTokens.length < 2 || sourceTokens.length < 2) return true;
  return overlapRatio(candidateTitle, sourceTitle) >= 0.34;
}

function genericAuthor(value) {
  return GENERIC_AUTHORS.has(normalizedText(value));
}

export function authorsCompatible(candidateAuthor, sourceAuthor) {
  const candidate = clean(candidateAuthor);
  const source = clean(sourceAuthor);
  if (!candidate || genericAuthor(candidate) || !source || genericAuthor(source)) return true;
  if (normalizedText(candidate) === normalizedText(source)) return true;
  return overlapRatio(candidate, source) >= 0.5;
}

function cacheRecords(cache, isbn) {
  const entry = cache?.entries?.[isbn] || {};
  return SOURCE_KEYS.flatMap(source =>
    (Array.isArray(entry?.[source]?.records) ? entry[source].records : [])
      .filter(record => normalizeValidIsbn(record?.isbn) === isbn)
      .map(record => ({ ...record, source })),
  );
}

function trimEvidence(value, maxChars = 1400) {
  const text = clean(value);
  if (text.length <= maxChars) return text;
  const clipped = text.slice(0, maxChars + 1);
  const boundary = clipped.lastIndexOf(' ');
  return `${clipped.slice(0, boundary >= maxChars * 0.75 ? boundary : maxChars).trim()}…`;
}

function sourceSummary(record) {
  return {
    source: record.source,
    source_url: clean(record.source_url) || null,
    title: clean(record.title) || null,
    author: clean(record.author) || null,
    publisher: clean(record.publisher) || null,
    pages: Number(record.pages) > 0 ? Number(record.pages) : null,
    language: clean(record.language) || null,
    format: clean(record.format) || null,
    publication_year: clean(record.publication_year) || null,
    topics: unique(record.topics).slice(0, 12),
    description: trimEvidence(record.description),
  };
}

function identityConflict(candidate, record) {
  return !titlesCompatible(candidate?.title, record?.title) ||
    !authorsCompatible(candidate?.author, record?.author);
}

export function classifyEditorialReadiness(candidate, records) {
  const exact = (Array.isArray(records) ? records : [])
    .filter(record => normalizeValidIsbn(record?.isbn) === normalizeValidIsbn(candidate?.isbn));
  const conflicts = exact.filter(record => identityConflict(candidate, record));
  const compatible = exact.filter(record => !identityConflict(candidate, record));
  const descriptions = compatible.filter(record => clean(record?.description).length >= 160);
  const independentSources = new Set(compatible.map(record => record.source).filter(Boolean));
  const topics = unique(compatible.flatMap(record => record?.topics || []));

  if (conflicts.length > 0 && compatible.length === 0) {
    return {
      status: 'REVIEW_IDENTITY',
      ready_for_editorial_draft: false,
      independent_source_count: 0,
      description_source_count: 0,
      topic_count: 0,
      conflict_count: conflicts.length,
    };
  }
  if (descriptions.length >= 1 && independentSources.size >= 2) {
    return {
      status: 'READY_FOR_EDITORIAL_DRAFT',
      ready_for_editorial_draft: true,
      independent_source_count: independentSources.size,
      description_source_count: descriptions.length,
      topic_count: topics.length,
      conflict_count: conflicts.length,
    };
  }
  if (descriptions.length >= 1) {
    return {
      status: 'REVIEW_SINGLE_CONTENT_SOURCE',
      ready_for_editorial_draft: false,
      independent_source_count: independentSources.size,
      description_source_count: descriptions.length,
      topic_count: topics.length,
      conflict_count: conflicts.length,
    };
  }
  if (topics.length >= 3 && independentSources.size >= 2) {
    return {
      status: 'STRUCTURED_CONTENT_ONLY',
      ready_for_editorial_draft: false,
      independent_source_count: independentSources.size,
      description_source_count: 0,
      topic_count: topics.length,
      conflict_count: conflicts.length,
    };
  }
  return {
    status: conflicts.length ? 'REVIEW_IDENTITY' : 'NO_CONTENT_EVIDENCE',
    ready_for_editorial_draft: false,
    independent_source_count: independentSources.size,
    description_source_count: descriptions.length,
    topic_count: topics.length,
    conflict_count: conflicts.length,
  };
}

function consensusValues(records, field) {
  const values = records.flatMap(record => {
    const value = record?.[field];
    return Array.isArray(value) ? value : [value];
  });
  return unique(values);
}

function seoTerms(candidate, compatibleRecords) {
  const topicPhrases = unique(compatibleRecords.flatMap(record => record?.topics || []));
  const titleTerms = tokens(candidate?.title).slice(0, 12);
  return unique([...topicPhrases, ...titleTerms]).slice(0, 24);
}

export function buildEditorialDossier(candidate, records) {
  const isbn = normalizeValidIsbn(candidate?.isbn);
  if (!isbn) throw new Error('Dossier sin ISBN válido.');
  const exact = (Array.isArray(records) ? records : [])
    .filter(record => normalizeValidIsbn(record?.isbn) === isbn);
  const compatible = exact.filter(record => !identityConflict(candidate, record));
  const readiness = classifyEditorialReadiness(candidate, exact);

  return {
    schema_version: 1,
    isbn,
    representative_id: clean(candidate?.id).toUpperCase(),
    listing_ids: unique(candidate?.listing_ids).map(value => value.toUpperCase()),
    title: clean(candidate?.title),
    author: genericAuthor(candidate?.author) ? null : clean(candidate?.author) || null,
    listing_count: Number(candidate?.listing_count) || 1,
    priority_score: Number(candidate?.priority_score) || 0,
    current_description_length: Number(candidate?.research?.description_length) || 0,
    readiness,
    source_references: compatible.map(record => ({
      source: record.source,
      source_url: clean(record.source_url) || null,
      title: clean(record.title) || null,
      author: clean(record.author) || null,
    })),
    source_descriptions: compatible
      .filter(record => clean(record?.description).length >= 80)
      .map(sourceSummary),
    source_facts: {
      authors: consensusValues(compatible, 'author'),
      publishers: consensusValues(compatible, 'publisher'),
      pages: consensusValues(compatible, 'pages').map(Number).filter(value => value > 0),
      languages: consensusValues(compatible, 'language'),
      formats: consensusValues(compatible, 'format'),
      publication_years: consensusValues(compatible, 'publication_year'),
      topics: unique(compatible.flatMap(record => record?.topics || [])).slice(0, 24),
    },
    seo_terms: seoTerms(candidate, compatible),
    required_editorial_sections: [
      'qué contiene o de qué trata',
      'temas, personajes, método o estructura',
      'para quién está recomendado',
      'autoría, ilustración, traducción u otros responsables cuando existan',
      'criterio de elección y límites de la edición',
      'título SEO específico',
      'meta description específica',
      'descripción Merchant específica',
    ],
    publication_allowed: false,
    next_action: readiness.ready_for_editorial_draft
      ? 'REDACT_AND_VALIDATE_EDITORIAL_REAL_V1'
      : 'RESEARCH_OR_REVIEW_BEFORE_DRAFT',
  };
}

async function readJson(source) {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`${source} respondió HTTP ${response.status}`);
    return response.json();
  }
  return JSON.parse(await readFile(source, 'utf8'));
}

function statusCounts(dossiers) {
  return Object.fromEntries(
    [...new Set(dossiers.map(dossier => dossier.readiness.status))]
      .sort()
      .map(status => [status, dossiers.filter(dossier => dossier.readiness.status === status).length]),
  );
}

export function buildEditorialCohortReport({ candidates, cache, generatedAt = new Date().toISOString() }) {
  const dossiers = candidates.map(candidate =>
    buildEditorialDossier(candidate, cacheRecords(cache, normalizeValidIsbn(candidate?.isbn))),
  );
  const sourceRecordCount = dossiers.reduce((sum, dossier) =>
    sum + dossier.readiness.independent_source_count, 0);
  return {
    schema_version: 1,
    generated_at: generatedAt,
    scope: 'active_sellable_unique_isbn_not_yet_editorial',
    target: candidates.length,
    publication_policy: 'research_only_no_auto_publish',
    summary: {
      selected: dossiers.length,
      ready_for_editorial_draft: dossiers.filter(dossier => dossier.readiness.ready_for_editorial_draft).length,
      with_any_content_description: dossiers.filter(dossier => dossier.readiness.description_source_count > 0).length,
      with_any_source: dossiers.filter(dossier => dossier.readiness.independent_source_count > 0).length,
      source_family_coverage_total: sourceRecordCount,
      statuses: statusCounts(dossiers),
    },
    dossiers,
  };
}

function reportMarkdown(report) {
  const lines = [
    '# B11 — cohorte editorial real de 2.000 ISBN',
    '',
    `- Generado: ${report.generated_at}`,
    `- Seleccionados: ${report.summary.selected}/${report.target}.`,
    `- Listos para redacción editorial: ${report.summary.ready_for_editorial_draft}.`,
    `- Con alguna descripción fuente: ${report.summary.with_any_content_description}.`,
    `- Con al menos una fuente: ${report.summary.with_any_source}.`,
    '- Política: investigación y dossier; ninguna ficha se auto-publica desde este artefacto.',
    '',
    '## Estados',
    '',
    ...Object.entries(report.summary.statuses).map(([status, count]) => `- ${status}: ${count}.`),
    '',
    '## Criterio',
    '',
    '- La cohorte siempre contiene 2.000 ISBN únicos activos y vendibles.',
    '- “Lista para redacción” exige descripción sustancial y al menos dos familias de fuente compatibles.',
    '- Metadatos aislados no cuentan como enriquecimiento editorial.',
    '- Conflictos de identidad o evidencia insuficiente quedan bloqueados.',
    '- Precio, stock, imágenes, condición, slug, canonical y checkout no forman parte del dossier.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

async function main() {
  const limit = positiveInteger(
    process.env.BOOK_EDITORIAL_COHORT_LIMIT,
    DEFAULT_EDITORIAL_COHORT_LIMIT,
  );
  const outputDir = process.env.BOOK_EDITORIAL_OUTPUT_DIR || DEFAULT_OUTPUT_DIR;
  const cachePath = process.env.BOOK_EDITORIAL_CACHE_PATH || DEFAULT_CACHE_PATH;
  const catalogSource = process.env.BOOK_EDITORIAL_CATALOG_SOURCE || CATALOG_URL;
  const [catalog, cache] = await Promise.all([
    readJson(catalogSource),
    readJson(cachePath),
  ]);
  const selection = selectResearchCohort({
    catalogItems: Array.isArray(catalog?.items) ? catalog.items : [],
    existingEnrichments: listBookEnrichments(),
    limit,
  });
  if (selection.selected.length !== limit) {
    throw new Error(`Cohorte incompleta: ${selection.selected.length}/${limit}.`);
  }
  const report = buildEditorialCohortReport({
    candidates: selection.selected,
    cache,
  });
  if (report.dossiers.some(dossier => dossier.publication_allowed !== false)) {
    throw new Error('Un dossier habilitó publicación automática indebidamente.');
  }
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(
      path.join(outputDir, 'editorial-cohort-2000.json'),
      `${JSON.stringify(report, null, 2)}\n`,
    ),
    writeFile(
      path.join(outputDir, 'editorial-cohort-2000-summary.md'),
      reportMarkdown(report),
    ),
  ]);
  process.stdout.write(reportMarkdown(report));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
