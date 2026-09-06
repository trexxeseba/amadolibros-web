#!/usr/bin/env node

// B11 / EDITORIAL-REAL-2000-EVIDENCE-1
// Reúne evidencia exacta para los 2.000 ISBN del lote editorial.
//
// Este paso NO publica texto ni genera relleno. Produce insumos verificables
// para redactar contenido útil: descripciones fuente, temas, responsables,
// público y hechos de edición. Los títulos comerciales sólo se copian como
// snapshots de control y nunca forman parte de la salida editorial publicable.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { CATALOG_URL } from '../../functions/_shared/catalog.js';
import { listBookEnrichments } from '../../functions/_shared/book-enrichment-registry.js';
import {
  classifyBookIntelligenceEvidence,
  summarizeBookIntelligenceEvidence,
} from '../../functions/_shared/book-intelligence-evidence.js';
import { normalizeValidIsbn } from '../../functions/_shared/showcase-ranking.js';
import { fetchBneEvidence } from './book-intelligence-bne.mjs';
import {
  chunkOpenLibraryPlan,
  emptySourceCache,
  fetchGoogleBooksEvidence,
  fetchOpenLibraryBatchEvidence,
  mergeSourceCache,
  planBookSourceResearch,
} from './book-intelligence-sources.mjs';
import {
  assertEditorialBatchPlan,
  buildEditorialBatchPlan,
  DEFAULT_EDITORIAL_BATCH_LIMIT,
  titleFingerprint,
} from './book-editorial-2000-plan.mjs';

export const DEFAULT_EVIDENCE_OUTPUT_DIR = 'artifacts/book-editorial/isbn-2000-evidence';
export const DEFAULT_EVIDENCE_CACHE_PATH = `${DEFAULT_EVIDENCE_OUTPUT_DIR}/source-cache.json`;
const DEFAULT_OPEN_LIBRARY_CONTACT = 'https://www.amadolibros.com';

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function plainText(value) {
  return clean(String(value ?? '').replace(/<[^>]+>/g, ' '));
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

async function readJson(source) {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`${source} respondió HTTP ${response.status}.`);
    return response.json();
  }
  return JSON.parse(await readFile(source, 'utf8'));
}

async function loadCache(filePath) {
  try {
    const cache = JSON.parse(await readFile(filePath, 'utf8'));
    return cache?.entries && typeof cache.entries === 'object'
      ? cache
      : emptySourceCache();
  } catch (error) {
    if (error?.code === 'ENOENT') return emptySourceCache();
    throw error;
  }
}

async function saveCache(filePath, cache) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(cache, null, 2)}\n`);
}

function recordsFor(cache, isbn) {
  const entry = cache?.entries?.[isbn] || {};
  return [
    ...(Array.isArray(entry.google_books?.records) ? entry.google_books.records : []),
    ...(Array.isArray(entry.open_library?.records) ? entry.open_library.records : []),
    ...(Array.isArray(entry.bne?.records) ? entry.bne.records : []),
  ];
}

function sourceState(cache, isbn, source) {
  const entry = cache?.entries?.[isbn]?.[source] || {};
  return {
    fetched_at: entry.fetched_at || null,
    error: entry.error || null,
    record_count: Array.isArray(entry.records) ? entry.records.length : 0,
  };
}

async function mapWithConcurrency(values, concurrency, worker) {
  const items = Array.isArray(values) ? values : [];
  const output = new Array(items.length);
  let next = 0;
  async function consume() {
    while (next < items.length) {
      const index = next++;
      output[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length || 1) },
    consume,
  ));
  return output;
}

function unique(values) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

function sourceFamily(record) {
  if (record?.source === 'google_books') return 'google_books';
  if (record?.source === 'open_library') return 'open_library';
  if (record?.source === 'bne') return 'national_library';
  return clean(record?.source) || 'unknown';
}

function safeDescription(record) {
  const description = plainText(record?.description);
  if (description.length < 80) return null;
  return {
    source: sourceFamily(record),
    source_url: clean(record?.source_url) || null,
    characters: description.length,
    text: description.slice(0, 5000),
  };
}

function contentInput(records) {
  const descriptions = records
    .map(safeDescription)
    .filter(Boolean)
    .sort((a, b) => b.characters - a.characters)
    .slice(0, 3);
  const topics = unique(records.flatMap(record =>
    Array.isArray(record?.topics) ? record.topics : [],
  )).slice(0, 24);
  const authors = unique(records.map(record => record?.author)).slice(0, 8);
  const publishers = unique(records.map(record => record?.publisher)).slice(0, 8);
  const languages = unique(records.map(record => record?.language)).slice(0, 6);
  const formats = unique(records.map(record => record?.format)).slice(0, 6);
  const publicationYears = unique(records.map(record => record?.publication_year)).slice(0, 6);
  const pages = [...new Set(records
    .map(record => Number(record?.pages))
    .filter(value => Number.isInteger(value) && value > 0))]
    .sort((a, b) => a - b);
  const providers = unique(records.map(sourceFamily));

  return {
    providers,
    descriptions,
    topics,
    authors,
    publishers,
    languages,
    formats,
    publication_years: publicationYears,
    pages,
  };
}

export function classifyEditorialInput({ classification, input } = {}) {
  const identityConflicts = classification?.identity_conflicts?.length || 0;
  const editionConflicts = classification?.edition_fact_conflicts?.length || 0;
  const providerCount = input?.providers?.length || 0;
  const longestDescription = Math.max(
    0,
    ...(input?.descriptions || []).map(entry => Number(entry?.characters) || 0),
  );
  const topicCount = input?.topics?.length || 0;

  if (identityConflicts > 0) {
    return {
      status: 'REVIEW_IDENTITY',
      reason: 'Las fuentes no coinciden suficientemente en la identidad de la obra o edición.',
    };
  }
  if (editionConflicts > 0) {
    return {
      status: 'REVIEW_EDITION',
      reason: 'Hay datos de edición incompatibles que deben resolverse campo por campo.',
    };
  }
  if (providerCount >= 2 && longestDescription >= 180 && topicCount >= 2) {
    return {
      status: 'READY_EDITORIAL',
      reason: 'Hay descripción sustancial, temas y más de una familia de fuentes exactas.',
    };
  }
  if (providerCount >= 1 && (longestDescription >= 140 || topicCount >= 3)) {
    return {
      status: 'PARTIAL_EDITORIAL',
      reason: 'Existe contenido específico, pero falta contraste o profundidad para publicación automática.',
    };
  }
  if (providerCount >= 1) {
    return {
      status: 'BIBLIOGRAPHIC_ONLY',
      reason: 'Las fuentes aportan identidad o datos técnicos, pero no contenido suficiente.',
    };
  }
  return {
    status: 'NO_EVIDENCE',
    reason: 'No se obtuvo una fuente exacta utilizable para contenido editorial.',
  };
}

function buildRepresentativeMap(catalogItems) {
  return new Map((Array.isArray(catalogItems) ? catalogItems : [])
    .map(item => [clean(item?.id).toUpperCase(), item])
    .filter(([id]) => /^MLU\d+$/.test(id)));
}

export function buildEditorialEvidenceReport({
  plan,
  catalogItems,
  cache,
  generatedAt = new Date().toISOString(),
} = {}) {
  assertEditorialBatchPlan(plan, plan.requested);
  const byId = buildRepresentativeMap(catalogItems);
  const classifications = [];
  const results = plan.entries.map(entry => {
    const representative = byId.get(entry.representative_id);
    if (!representative) {
      throw new Error(`${entry.isbn}: no se encontró representante ${entry.representative_id}.`);
    }
    const records = recordsFor(cache, entry.isbn)
      .filter(record => normalizeValidIsbn(record?.isbn) === entry.isbn);
    const classification = classifyBookIntelligenceEvidence(representative, records);
    classifications.push(classification);
    const input = contentInput(records);
    const readiness = classifyEditorialInput({ classification, input });

    return {
      isbn: entry.isbn,
      representative_id: entry.representative_id,
      listing_ids: entry.listing_ids,
      title_lock: entry.title_snapshots,
      current_level: entry.current_level,
      readiness,
      evidence: {
        tier: classification.tier,
        reason: classification.reason,
        exact_isbn_source_count: classification.exact_isbn_source_count,
        independent_work_source_count: classification.independent_work_source_count,
        identity_conflicts: classification.identity_conflicts,
        edition_fact_conflicts: classification.edition_fact_conflicts,
        generation_policy: classification.generation_policy,
      },
      editorial_input: input,
      sources: {
        google_books: sourceState(cache, entry.isbn, 'google_books'),
        open_library: sourceState(cache, entry.isbn, 'open_library'),
        bne: sourceState(cache, entry.isbn, 'bne'),
      },
    };
  });

  const statuses = [
    'READY_EDITORIAL',
    'PARTIAL_EDITORIAL',
    'BIBLIOGRAPHIC_ONLY',
    'REVIEW_IDENTITY',
    'REVIEW_EDITION',
    'NO_EVIDENCE',
  ];
  const readiness = Object.fromEntries(statuses.map(status => [
    status,
    results.filter(result => result.readiness.status === status).length,
  ]));

  return {
    schema_version: 1,
    run: 'EDITORIAL-REAL-2000-EVIDENCE-1',
    generated_at: generatedAt,
    cohort: {
      batch_id: plan.batch_id,
      requested: plan.requested,
      selected: results.length,
      protected_listings: plan.entries.reduce((sum, entry) => sum + entry.listing_count, 0),
      title_variant_groups: plan.entries.filter(entry => entry.title_variant_count > 1).length,
      titles_changed: 0,
    },
    readiness,
    evidence_summary: summarizeBookIntelligenceEvidence(classifications),
    results,
  };
}

export function assertEvidenceReport(report, expected = DEFAULT_EDITORIAL_BATCH_LIMIT) {
  if (!report || report.schema_version !== 1) throw new Error('Reporte de evidencia inválido.');
  if (report.cohort?.selected !== expected || report.results?.length !== expected) {
    throw new Error(`Reporte incompleto: ${report.results?.length || 0}/${expected}.`);
  }
  if (new Set(report.results.map(result => result.isbn)).size !== expected) {
    throw new Error('El reporte de evidencia repite ISBN.');
  }
  if (report.cohort.titles_changed !== 0) throw new Error('El reporte declara títulos modificados.');
  for (const result of report.results) {
    if (!Array.isArray(result.title_lock) || result.title_lock.length < 1) {
      throw new Error(`${result.isbn}: falta el bloqueo de títulos.`);
    }
    for (const snapshot of result.title_lock) {
      if (titleFingerprint(snapshot.title) !== snapshot.sha256) {
        throw new Error(`${result.isbn}/${snapshot.product_id}: título alterado.`);
      }
    }
  }
  return true;
}

function summaryMarkdown(report, execution) {
  const r = report.readiness;
  return `${[
    '# B11 — evidencia editorial para 2.000 ISBN',
    '',
    `- Generado: ${report.generated_at}`,
    `- ISBN investigados: ${report.cohort.selected}/${report.cohort.requested}.`,
    `- Publicaciones con título protegido: ${report.cohort.protected_listings}.`,
    `- Grupos con títulos distintos preservados: ${report.cohort.title_variant_groups}.`,
    '- Títulos modificados: 0.',
    '',
    '## Resultado de evidencia',
    '',
    `- Listos para redacción editorial: ${r.READY_EDITORIAL}.`,
    `- Parciales, requieren más contraste: ${r.PARTIAL_EDITORIAL}.`,
    `- Sólo bibliográficos: ${r.BIBLIOGRAPHIC_ONLY}.`,
    `- Revisión de identidad: ${r.REVIEW_IDENTITY}.`,
    `- Revisión de edición: ${r.REVIEW_EDITION}.`,
    `- Sin evidencia utilizable: ${r.NO_EVIDENCE}.`,
    '',
    '## Ejecución de fuentes',
    '',
    `- Google Books: ${execution.google_successes} éxitos HTTP; ${execution.google_errors} errores.`,
    `- Open Library: ${execution.open_library_successes} ISBN consultados; ${execution.open_library_errors} errores.`,
    `- BNE: ${execution.bne_successes} éxitos HTTP; ${execution.bne_errors} errores.`,
    '',
    '## Contrato',
    '',
    '- Este artefacto reúne evidencia; no publica copy ni relleno.',
    '- Ningún campo editorial puede modificar título, H1, título HTML, título Merchant, slug o canonical.',
    '- READY_EDITORIAL habilita redacción, no publicación automática sin controles de calidad.',
    '',
  ].join('\n')}\n`;
}

export async function runEditorialEvidence({
  limit = DEFAULT_EDITORIAL_BATCH_LIMIT,
  outputDir = DEFAULT_EVIDENCE_OUTPUT_DIR,
  cachePath = DEFAULT_EVIDENCE_CACHE_PATH,
  catalogSource = CATALOG_URL,
  googleBooksAccessToken = process.env.GOOGLE_BOOKS_ACCESS_TOKEN,
  googleBooksApiKey = process.env.GOOGLE_BOOKS_API_KEY,
  openLibraryContact = process.env.OPEN_LIBRARY_CONTACT || DEFAULT_OPEN_LIBRARY_CONTACT,
  googleBudget = positiveInteger(process.env.GOOGLE_BOOKS_BUDGET, limit),
  googleConcurrency = positiveInteger(process.env.GOOGLE_BOOKS_CONCURRENCY, 2),
  googleDelayMs = nonNegativeInteger(process.env.GOOGLE_BOOKS_DELAY_MS, 650),
  googleRetryAttempts = positiveInteger(process.env.GOOGLE_BOOKS_RETRY_ATTEMPTS, 3),
  openLibraryBudget = positiveInteger(process.env.OPEN_LIBRARY_BUDGET, limit),
  openLibraryConcurrency = positiveInteger(process.env.OPEN_LIBRARY_CONCURRENCY, 3),
  bneBudget = positiveInteger(process.env.BNE_BUDGET, limit),
  bneConcurrency = positiveInteger(process.env.BNE_CONCURRENCY, 3),
  bneDelayMs = nonNegativeInteger(process.env.BNE_DELAY_MS, 350),
} = {}) {
  if (!clean(googleBooksAccessToken) && !clean(googleBooksApiKey)) {
    throw new Error('La investigación editorial requiere token OAuth o API key de Google Books.');
  }

  const catalog = await readJson(catalogSource);
  const catalogItems = Array.isArray(catalog?.items) ? catalog.items : [];
  const plan = buildEditorialBatchPlan({
    catalogItems,
    enrichmentRecords: listBookEnrichments(),
    limit,
  });
  assertEditorialBatchPlan(plan, limit);

  const byId = buildRepresentativeMap(catalogItems);
  const representatives = plan.entries.map(entry => {
    const item = byId.get(entry.representative_id);
    if (!item) throw new Error(`${entry.isbn}: representante ausente.`);
    return {
      ...item,
      isbn: entry.isbn,
      priority_score: entry.priority_score,
      listing_ids: entry.listing_ids,
    };
  });

  let cache = await loadCache(cachePath);
  const sourcePlan = planBookSourceResearch(representatives, cache, {
    googleBooksBudget: Math.min(representatives.length, googleBudget),
    openLibraryBudget: Math.min(representatives.length, openLibraryBudget),
    bneBudget: Math.min(representatives.length, bneBudget),
  });

  let googleConsecutiveRateLimits = 0;
  let googleCircuitOpen = false;
  const [googleAttempts, openAttempts, bneAttempts] = await Promise.all([
    mapWithConcurrency(sourcePlan.google_books, googleConcurrency, async entry => {
      if (googleCircuitOpen) {
        return { isbn: entry.isbn, ok: false, error: 'Google Books circuit open after repeated HTTP 429' };
      }
      try {
        const records = await fetchGoogleBooksEvidence(entry.isbn, {
          accessToken: googleBooksAccessToken,
          apiKey: googleBooksApiKey,
          retryAttempts: googleRetryAttempts,
        });
        googleConsecutiveRateLimits = 0;
        cache = mergeSourceCache(cache, entry.isbn, 'google_books', records);
        return { isbn: entry.isbn, ok: true, records: records.length };
      } catch (error) {
        const message = error?.message || String(error);
        if (/HTTP 429/.test(message)) {
          googleConsecutiveRateLimits += 1;
          if (googleConsecutiveRateLimits >= 20) googleCircuitOpen = true;
        } else {
          googleConsecutiveRateLimits = 0;
        }
        cache = mergeSourceCache(cache, entry.isbn, 'google_books', [], { error: message });
        return { isbn: entry.isbn, ok: false, error: message };
      } finally {
        if (googleDelayMs > 0) await new Promise(resolve => setTimeout(resolve, googleDelayMs));
      }
    }),
    mapWithConcurrency(chunkOpenLibraryPlan(sourcePlan), openLibraryConcurrency, async chunk => {
      const isbns = chunk.map(entry => entry.isbn);
      try {
        const records = await fetchOpenLibraryBatchEvidence(isbns, { contact: openLibraryContact });
        return isbns.map(isbn => ({
          isbn,
          ok: true,
          records: records.filter(record => record.isbn === isbn),
        }));
      } catch (error) {
        const message = error?.message || String(error);
        return isbns.map(isbn => ({ isbn, ok: false, records: [], error: message }));
      }
    }).then(chunks => chunks.flat()),
    mapWithConcurrency(sourcePlan.bne, bneConcurrency, async entry => {
      try {
        const records = await fetchBneEvidence(entry.isbn);
        cache = mergeSourceCache(cache, entry.isbn, 'bne', records);
        return { isbn: entry.isbn, ok: true, records: records.length };
      } catch (error) {
        const message = error?.message || String(error);
        cache = mergeSourceCache(cache, entry.isbn, 'bne', [], { error: message });
        return { isbn: entry.isbn, ok: false, error: message };
      } finally {
        if (bneDelayMs > 0) await new Promise(resolve => setTimeout(resolve, bneDelayMs));
      }
    }),
  ]);

  for (const attempt of openAttempts) {
    cache = mergeSourceCache(cache, attempt.isbn, 'open_library', attempt.records, {
      error: attempt.error,
    });
  }
  await saveCache(cachePath, cache);

  const report = buildEditorialEvidenceReport({
    plan,
    catalogItems,
    cache,
  });
  assertEvidenceReport(report, limit);

  const execution = {
    google_successes: googleAttempts.filter(attempt => attempt.ok).length,
    google_errors: googleAttempts.filter(attempt => !attempt.ok).length,
    open_library_successes: openAttempts.filter(attempt => attempt.ok).length,
    open_library_errors: openAttempts.filter(attempt => !attempt.ok).length,
    bne_successes: bneAttempts.filter(attempt => attempt.ok).length,
    bne_errors: bneAttempts.filter(attempt => !attempt.ok).length,
  };

  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDir, 'evidence-report.json'), `${JSON.stringify(report, null, 2)}\n`),
    writeFile(path.join(outputDir, 'editorial-input.json'), `${JSON.stringify({
      schema_version: 1,
      generated_at: report.generated_at,
      batch_id: report.cohort.batch_id,
      title_fields_forbidden: true,
      entries: report.results
        .filter(result => ['READY_EDITORIAL', 'PARTIAL_EDITORIAL'].includes(result.readiness.status))
        .map(result => ({
          isbn: result.isbn,
          representative_id: result.representative_id,
          listing_ids: result.listing_ids,
          title_lock: result.title_lock,
          readiness: result.readiness,
          evidence: result.evidence,
          editorial_input: result.editorial_input,
        })),
    }, null, 2)}\n`),
    writeFile(path.join(outputDir, 'summary.md'), summaryMarkdown(report, execution)),
  ]);

  return { report, execution, sourcePlan };
}

async function main() {
  const { report, execution, sourcePlan } = await runEditorialEvidence({
    limit: positiveInteger(process.env.BOOK_EDITORIAL_EVIDENCE_LIMIT, DEFAULT_EDITORIAL_BATCH_LIMIT),
    outputDir: process.env.BOOK_EDITORIAL_EVIDENCE_OUTPUT_DIR || DEFAULT_EVIDENCE_OUTPUT_DIR,
    cachePath: process.env.BOOK_EDITORIAL_EVIDENCE_CACHE_PATH || DEFAULT_EVIDENCE_CACHE_PATH,
    catalogSource: process.env.BOOK_EDITORIAL_CATALOG_SOURCE || CATALOG_URL,
  });
  console.log(JSON.stringify({
    run: report.run,
    cohort: report.cohort,
    plan: {
      google_books_requests: sourcePlan.google_books.length,
      open_library_isbns: sourcePlan.open_library.length,
      bne_requests: sourcePlan.bne.length,
      cached_google_books: sourcePlan.cached_google_books,
      cached_open_library: sourcePlan.cached_open_library,
      cached_bne: sourcePlan.cached_bne,
    },
    execution,
    readiness: report.readiness,
  }, null, 2));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error(`[book-editorial-2000-evidence] ERROR: ${error?.message || error}`);
    process.exit(1);
  });
}
