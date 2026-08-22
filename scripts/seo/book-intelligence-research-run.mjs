#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { fetchAndConsolidate } from '../categorize/fetch-catalog.js';
import { PAUSED_SEO_COHORT } from '../../functions/_shared/paused-seo-cohort.js';
import {
  classifyBookIntelligenceEvidence,
  summarizeBookIntelligenceEvidence,
} from '../../functions/_shared/book-intelligence-evidence.js';
import {
  chunkOpenLibraryPlan,
  emptySourceCache,
  fetchGoogleBooksEvidence,
  fetchOpenLibraryBatchEvidence,
  mergeSourceCache,
  planBookSourceResearch,
} from './book-intelligence-sources.mjs';

const DEFAULT_LIMIT = 12;
const DEFAULT_OUTPUT_DIR = 'artifacts/book-intelligence/research-run-1';
const DEFAULT_CACHE_PATH = 'scripts/seo/data/book-intelligence/source-cache.json';
const DEFAULT_OPEN_LIBRARY_CONTACT = 'https://www.amadolibros.com';

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function selectResearchCohort({ cohort = [], catalogItems = [], limit = DEFAULT_LIMIT } = {}) {
  const target = positiveInteger(limit, DEFAULT_LIMIT);
  const byId = new Map(
    (Array.isArray(catalogItems) ? catalogItems : [])
      .filter(item => item?.id)
      .map(item => [String(item.id).toUpperCase(), item]),
  );

  const selected = [];
  const missing = [];
  const seenIsbns = new Set();

  for (const candidate of Array.isArray(cohort) ? cohort : []) {
    if (candidate?.source !== 'gsc-demand') continue;
    const id = String(candidate?.id || '').toUpperCase();
    const item = byId.get(id);
    if (!item) {
      missing.push(id);
      continue;
    }
    const isbn = clean(candidate?.isbn);
    if (!isbn || seenIsbns.has(isbn)) continue;
    seenIsbns.add(isbn);
    selected.push({
      ...item,
      isbn,
      research: {
        cohort_source: candidate.source,
        gsc_impressions: Number(candidate.impressions) || 0,
        gsc_clicks: Number(candidate.clicks) || 0,
        quality_score: Number(candidate.quality_score) || 0,
      },
      priority_score: 1,
      gsc_impressions: Number(candidate.impressions) || 0,
      gsc_clicks: Number(candidate.clicks) || 0,
    });
    if (selected.length >= target) break;
  }

  if (selected.length < target) {
    throw new Error(`RESEARCH-RUN-1 resolvió ${selected.length}/${target} fichas con demanda en el catálogo actual.`);
  }

  return {
    selected,
    missing_catalog_ids: missing,
  };
}

async function loadCache(filePath) {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8'));
    return parsed?.entries && typeof parsed.entries === 'object' ? parsed : emptySourceCache();
  } catch (error) {
    if (error?.code === 'ENOENT') return emptySourceCache();
    throw error;
  }
}

async function saveCache(filePath, cache) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(cache, null, 2));
}

function recordsFor(cache, isbn) {
  const entry = cache?.entries?.[isbn] || {};
  return [
    ...(Array.isArray(entry.google_books?.records) ? entry.google_books.records : []),
    ...(Array.isArray(entry.open_library?.records) ? entry.open_library.records : []),
  ];
}

function sourceState(cache, isbn, source) {
  const entry = cache?.entries?.[isbn]?.[source] || null;
  return {
    fetched_at: entry?.fetched_at || null,
    error: entry?.error || null,
    record_count: Array.isArray(entry?.records) ? entry.records.length : 0,
  };
}

export function buildResearchResult(item, classification, cache) {
  return {
    id: String(item?.id || '').toUpperCase(),
    isbn: clean(item?.isbn),
    title: clean(item?.title),
    author: clean(item?.author),
    status: item?.status || null,
    gsc_impressions: Number(item?.research?.gsc_impressions) || 0,
    gsc_clicks: Number(item?.research?.gsc_clicks) || 0,
    quality_score: Number(item?.research?.quality_score) || 0,
    tier: classification.tier,
    reason: classification.reason,
    availability: classification.availability,
    exact_isbn_source_count: classification.exact_isbn_source_count,
    independent_work_source_count: classification.independent_work_source_count,
    strong_work_source_count: classification.strong_work_source_count,
    identity_conflicts: classification.identity_conflicts,
    edition_fact_conflicts: classification.edition_fact_conflicts,
    generation_policy: classification.generation_policy,
    sources: {
      google_books: sourceState(cache, item.isbn, 'google_books'),
      open_library: sourceState(cache, item.isbn, 'open_library'),
    },
  };
}

function sourceSummary(results, source) {
  return {
    fetched: results.filter(result => result.sources[source].fetched_at).length,
    matched: results.filter(result => result.sources[source].record_count > 0).length,
    no_match: results.filter(result => result.sources[source].fetched_at && !result.sources[source].error && result.sources[source].record_count === 0).length,
    errors: results.filter(result => result.sources[source].error).length,
  };
}

export function researchMarkdown(report) {
  const lines = [
    '# FICHAS-VIDRIERA-2 — RESEARCH-RUN-1',
    '',
    `- Generado: ${report.generated_at}`,
    `- Cohorte técnica: ${report.cohort.selected} ISBN con demanda GSC, en orden de prioridad real.`,
    `- Catálogo actual: ${report.catalog.total_items} fichas consolidadas.`,
    `- Google Books: ${report.sources.google_books.matched}/${report.cohort.selected} con match exacto; ${report.sources.google_books.errors} errores.`,
    `- Open Library: ${report.sources.open_library.matched}/${report.cohort.selected} con match exacto; ${report.sources.open_library.errors} errores.`,
    `- Tiers: GREEN ${report.classification.green}, YELLOW ${report.classification.yellow}, RED ${report.classification.red}.`,
    `- Auto-publicables por evidencia: ${report.classification.auto_publish_work_content}.`,
    `- Conflictos de identidad: ${report.classification.identity_conflicts}.`,
    '',
    '## Resultado por ISBN',
    '',
    '| MLU | ISBN | GSC imp. | Google | Open Library | Tier | Razón |',
    '| --- | --- | ---: | ---: | ---: | --- | --- |',
    ...report.results.map(result =>
      `| ${result.id} | ${result.isbn} | ${result.gsc_impressions} | ${result.sources.google_books.record_count} | ${result.sources.open_library.record_count} | ${result.tier.toUpperCase()} | ${result.reason} |`,
    ),
    '',
    '## Contrato',
    '',
    '- Sólo lectura contra R2, Google Books y Open Library.',
    '- No se modifica ninguna ficha pública, sitemap, canonical, Worker, R2, D1, KV ni Producción.',
    '- El token OAuth no se escribe en archivos ni en URLs.',
  ];
  return `${lines.join('\n')}\n`;
}

function cliOptions(argv) {
  const options = {
    limit: positiveInteger(process.env.BOOK_INTELLIGENCE_LIMIT, DEFAULT_LIMIT),
    outputDir: process.env.BOOK_INTELLIGENCE_OUTPUT_DIR || DEFAULT_OUTPUT_DIR,
    cachePath: process.env.BOOK_INTELLIGENCE_CACHE_PATH || DEFAULT_CACHE_PATH,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--limit') options.limit = positiveInteger(argv[++index], DEFAULT_LIMIT);
    else if (flag === '--output-dir') options.outputDir = argv[++index];
    else if (flag === '--cache') options.cachePath = argv[++index];
    else throw new Error(`Argumento desconocido: ${flag}`);
  }
  return options;
}

export async function runResearch({
  limit = DEFAULT_LIMIT,
  outputDir = DEFAULT_OUTPUT_DIR,
  cachePath = DEFAULT_CACHE_PATH,
  googleBooksAccessToken = process.env.GOOGLE_BOOKS_ACCESS_TOKEN,
  googleBooksApiKey = process.env.GOOGLE_BOOKS_API_KEY,
  openLibraryContact = process.env.OPEN_LIBRARY_CONTACT || DEFAULT_OPEN_LIBRARY_CONTACT,
} = {}) {
  if (!clean(googleBooksAccessToken) && !clean(googleBooksApiKey)) {
    throw new Error('RESEARCH-RUN-1 requiere GOOGLE_BOOKS_ACCESS_TOKEN o GOOGLE_BOOKS_API_KEY.');
  }

  const catalog = await fetchAndConsolidate();
  const { selected, missing_catalog_ids: missingCatalogIds } = selectResearchCohort({
    cohort: PAUSED_SEO_COHORT,
    catalogItems: catalog.items,
    limit,
  });

  let cache = await loadCache(cachePath);
  const plan = planBookSourceResearch(selected, cache, {
    googleBooksBudget: selected.length,
    openLibraryBudget: selected.length,
  });

  const googleAttempts = [];
  for (const entry of plan.google_books) {
    try {
      const records = await fetchGoogleBooksEvidence(entry.isbn, {
        accessToken: googleBooksAccessToken,
        apiKey: googleBooksApiKey,
      });
      cache = mergeSourceCache(cache, entry.isbn, 'google_books', records);
      googleAttempts.push({ isbn: entry.isbn, ok: true, records: records.length });
    } catch (error) {
      cache = mergeSourceCache(cache, entry.isbn, 'google_books', [], { error: error?.message || String(error) });
      googleAttempts.push({ isbn: entry.isbn, ok: false, error: error?.message || String(error) });
    }
  }

  const openLibraryAttempts = [];
  for (const chunk of chunkOpenLibraryPlan(plan)) {
    const isbns = chunk.map(entry => entry.isbn);
    try {
      const records = await fetchOpenLibraryBatchEvidence(isbns, { contact: openLibraryContact });
      for (const isbn of isbns) {
        const isbnRecords = records.filter(record => record.isbn === isbn);
        cache = mergeSourceCache(cache, isbn, 'open_library', isbnRecords);
        openLibraryAttempts.push({ isbn, ok: true, records: isbnRecords.length });
      }
    } catch (error) {
      for (const isbn of isbns) {
        cache = mergeSourceCache(cache, isbn, 'open_library', [], { error: error?.message || String(error) });
        openLibraryAttempts.push({ isbn, ok: false, error: error?.message || String(error) });
      }
    }
  }

  await saveCache(cachePath, cache);

  const classifications = selected.map(item =>
    classifyBookIntelligenceEvidence(item, recordsFor(cache, item.isbn)),
  );
  const summary = summarizeBookIntelligenceEvidence(classifications);
  const results = selected.map((item, index) => buildResearchResult(item, classifications[index], cache));
  const generatedAt = new Date().toISOString();
  const report = {
    schema_version: 1,
    run: 'FICHAS-VIDRIERA-2/RESEARCH-RUN-1',
    generated_at: generatedAt,
    cohort: {
      requested: positiveInteger(limit, DEFAULT_LIMIT),
      selected: selected.length,
      demand_only: true,
      missing_catalog_ids: missingCatalogIds,
      total_impressions: selected.reduce((sum, item) => sum + (Number(item.research?.gsc_impressions) || 0), 0),
      total_clicks: selected.reduce((sum, item) => sum + (Number(item.research?.gsc_clicks) || 0), 0),
    },
    catalog: {
      fetched_at: catalog.fetched_at,
      total_items: catalog.items.length,
      active_total_raw: catalog.sources?.active_total_raw ?? null,
      paused_total_raw: catalog.sources?.paused_total_raw ?? null,
      paused_manifest_version: catalog.sources?.paused_manifest_version ?? null,
    },
    plan: {
      eligible_unique_isbns: plan.eligible_unique_isbns,
      google_books_requests: plan.google_books.length,
      open_library_isbns: plan.open_library.length,
      cached_google_books: plan.cached_google_books,
      cached_open_library: plan.cached_open_library,
    },
    execution: {
      google_books_http_successes: googleAttempts.filter(attempt => attempt.ok).length,
      google_books_errors: googleAttempts.filter(attempt => !attempt.ok).length,
      open_library_http_successes: openLibraryAttempts.filter(attempt => attempt.ok).length,
      open_library_errors: openLibraryAttempts.filter(attempt => !attempt.ok).length,
    },
    sources: {
      google_books: sourceSummary(results, 'google_books'),
      open_library: sourceSummary(results, 'open_library'),
    },
    classification: summary,
    results,
  };

  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, 'research-run-1-report.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(outputDir, 'report-summary.md'), researchMarkdown(report));

  const googleWasPlanned = plan.google_books.length > 0;
  const googleHadSuccessfulHttp = googleAttempts.some(attempt => attempt.ok);
  if (googleWasPlanned && !googleHadSuccessfulHttp) {
    throw new Error('Google Books no completó ninguna consulta HTTP: revisar scope Books/API habilitada para el proyecto WIF.');
  }

  return report;
}

async function main() {
  const options = cliOptions(process.argv.slice(2));
  const report = await runResearch(options);
  console.log(JSON.stringify({
    run: report.run,
    selected: report.cohort.selected,
    sources: report.sources,
    classification: report.classification,
  }, null, 2));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error(`[research-run-1] ERROR: ${error?.message || error}`);
    process.exit(1);
  });
}
