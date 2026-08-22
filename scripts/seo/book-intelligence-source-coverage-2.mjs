#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { fetchAndConsolidate } from '../categorize/fetch-catalog.js';
import { PAUSED_SEO_COHORT } from '../../functions/_shared/paused-seo-cohort.js';
import {
  classifyBookIntelligenceEvidence,
  summarizeBookIntelligenceEvidence,
} from '../../functions/_shared/book-intelligence-evidence.js';
import { fetchGoogleBooksEvidence } from './book-intelligence-sources.mjs';
import { fetchLibraryOfCongressEvidence } from './book-intelligence-library-of-congress.mjs';
import { selectResearchCohort } from './book-intelligence-research-run.mjs';

const DEFAULT_LIMIT = 12;
const DEFAULT_OUTPUT_DIR = 'artifacts/book-intelligence/source-coverage-2';

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sourceSummary(attempts) {
  return {
    requested: attempts.length,
    http_successes: attempts.filter(attempt => attempt.ok).length,
    matched: attempts.filter(attempt => attempt.ok && attempt.record_count > 0).length,
    no_match: attempts.filter(attempt => attempt.ok && attempt.record_count === 0).length,
    errors: attempts.filter(attempt => !attempt.ok).length,
  };
}

export function buildCoverageResult(item, classification, googleRecords, libraryRecords) {
  return {
    id: String(item?.id || '').toUpperCase(),
    isbn: clean(item?.isbn),
    title: clean(item?.title),
    author: clean(item?.author),
    gsc_impressions: Number(item?.research?.gsc_impressions) || 0,
    gsc_clicks: Number(item?.research?.gsc_clicks) || 0,
    google_books_records: Array.isArray(googleRecords) ? googleRecords.length : 0,
    library_of_congress_records: Array.isArray(libraryRecords) ? libraryRecords.length : 0,
    library_of_congress_substantive_records: (Array.isArray(libraryRecords) ? libraryRecords : []).filter(record =>
      clean(record.description).length >= 80 || (Array.isArray(record.topics) && record.topics.length >= 3),
    ).length,
    tier: classification.tier,
    reason: classification.reason,
    exact_isbn_source_count: classification.exact_isbn_source_count,
    independent_work_source_count: classification.independent_work_source_count,
    strong_work_source_count: classification.strong_work_source_count,
    identity_conflicts: classification.identity_conflicts,
    generation_policy: classification.generation_policy,
  };
}

export function coverageMarkdown(report) {
  const lines = [
    '# FICHAS-VIDRIERA-2 — SOURCE-COVERAGE-2',
    '',
    `- Generado: ${report.generated_at}`,
    `- Cohorte: ${report.cohort.selected} ISBN con demanda GSC.`,
    `- Google Books: ${report.sources.google_books.matched}/${report.cohort.selected} matches exactos; ${report.sources.google_books.errors} errores.`,
    `- Library of Congress: ${report.sources.library_of_congress.matched}/${report.cohort.selected} matches exactos; ${report.sources.library_of_congress.errors} errores.`,
    `- Library of Congress con evidencia semántica suficiente: ${report.sources.library_of_congress.substantive_matches}/${report.cohort.selected}.`,
    `- Tiers combinados Google + LoC: GREEN ${report.classification.green}, YELLOW ${report.classification.yellow}, RED ${report.classification.red}.`,
    `- Auto-publicables: ${report.classification.auto_publish_work_content}.`,
    '',
    '## Resultado por ISBN',
    '',
    '| MLU | ISBN | GSC imp. | Google | LoC | LoC sust. | Tier | Razón |',
    '| --- | --- | ---: | ---: | ---: | ---: | --- | --- |',
    ...report.results.map(result =>
      `| ${result.id} | ${result.isbn} | ${result.gsc_impressions} | ${result.google_books_records} | ${result.library_of_congress_records} | ${result.library_of_congress_substantive_records} | ${result.tier.toUpperCase()} | ${result.reason} |`,
    ),
    '',
    '## Contrato',
    '',
    '- Sólo lectura contra R2, Google Books y Library of Congress SRU.',
    '- No se modifica ninguna ficha, sitemap, canonical, Worker, R2, D1, KV ni Producción.',
    '- No se guarda el token OAuth y Library of Congress no requiere secreto.',
  ];
  return `${lines.join('\n')}\n`;
}

export async function runSourceCoverage({
  limit = DEFAULT_LIMIT,
  outputDir = DEFAULT_OUTPUT_DIR,
  googleBooksAccessToken = process.env.GOOGLE_BOOKS_ACCESS_TOKEN,
  googleBooksApiKey = process.env.GOOGLE_BOOKS_API_KEY,
  locDelayMs = Number(process.env.LIBRARY_OF_CONGRESS_DELAY_MS ?? 150),
} = {}) {
  if (!clean(googleBooksAccessToken) && !clean(googleBooksApiKey)) {
    throw new Error('SOURCE-COVERAGE-2 requiere GOOGLE_BOOKS_ACCESS_TOKEN o GOOGLE_BOOKS_API_KEY.');
  }

  const catalog = await fetchAndConsolidate();
  const { selected, missing_catalog_ids: missingCatalogIds } = selectResearchCohort({
    cohort: PAUSED_SEO_COHORT,
    catalogItems: catalog.items,
    limit,
  });

  const googleByIsbn = new Map();
  const libraryByIsbn = new Map();
  const googleAttempts = [];
  const libraryAttempts = [];

  for (const item of selected) {
    try {
      const records = await fetchGoogleBooksEvidence(item.isbn, {
        accessToken: googleBooksAccessToken,
        apiKey: googleBooksApiKey,
      });
      googleByIsbn.set(item.isbn, records);
      googleAttempts.push({ isbn: item.isbn, ok: true, record_count: records.length });
    } catch (error) {
      googleByIsbn.set(item.isbn, []);
      googleAttempts.push({ isbn: item.isbn, ok: false, record_count: 0, error: error?.message || String(error) });
    }

    try {
      const records = await fetchLibraryOfCongressEvidence(item.isbn);
      libraryByIsbn.set(item.isbn, records);
      libraryAttempts.push({ isbn: item.isbn, ok: true, record_count: records.length });
    } catch (error) {
      libraryByIsbn.set(item.isbn, []);
      libraryAttempts.push({ isbn: item.isbn, ok: false, record_count: 0, error: error?.message || String(error) });
    }

    if (Number.isFinite(locDelayMs) && locDelayMs > 0) await sleep(Math.min(locDelayMs, 2_000));
  }

  const classifications = selected.map(item => classifyBookIntelligenceEvidence(item, [
    ...(googleByIsbn.get(item.isbn) || []),
    ...(libraryByIsbn.get(item.isbn) || []),
  ]));
  const results = selected.map((item, index) => buildCoverageResult(
    item,
    classifications[index],
    googleByIsbn.get(item.isbn) || [],
    libraryByIsbn.get(item.isbn) || [],
  ));
  const librarySummary = sourceSummary(libraryAttempts);
  librarySummary.substantive_matches = results.filter(result => result.library_of_congress_substantive_records > 0).length;

  const report = {
    schema_version: 1,
    run: 'FICHAS-VIDRIERA-2/SOURCE-COVERAGE-2',
    generated_at: new Date().toISOString(),
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
    sources: {
      google_books: sourceSummary(googleAttempts),
      library_of_congress: librarySummary,
    },
    classification: summarizeBookIntelligenceEvidence(classifications),
    results,
  };

  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, 'source-coverage-2-report.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(outputDir, 'report-summary.md'), coverageMarkdown(report));

  if (googleAttempts.length && !googleAttempts.some(attempt => attempt.ok)) {
    throw new Error('Google Books no completó ninguna consulta HTTP.');
  }
  if (libraryAttempts.length && !libraryAttempts.some(attempt => attempt.ok)) {
    throw new Error('Library of Congress SRU no completó ninguna consulta HTTP.');
  }

  return report;
}

function cliOptions(argv) {
  const options = {
    limit: positiveInteger(process.env.BOOK_INTELLIGENCE_LIMIT, DEFAULT_LIMIT),
    outputDir: process.env.BOOK_INTELLIGENCE_OUTPUT_DIR || DEFAULT_OUTPUT_DIR,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--limit') options.limit = positiveInteger(argv[++index], DEFAULT_LIMIT);
    else if (flag === '--output-dir') options.outputDir = argv[++index];
    else throw new Error(`Argumento desconocido: ${flag}`);
  }
  return options;
}

async function main() {
  const report = await runSourceCoverage(cliOptions(process.argv.slice(2)));
  console.log(JSON.stringify({
    run: report.run,
    cohort: report.cohort,
    sources: report.sources,
    classification: report.classification,
  }, null, 2));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error(`[source-coverage-2] ERROR: ${error?.message || error}`);
    process.exit(1);
  });
}
