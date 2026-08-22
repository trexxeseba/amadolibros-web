#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { fetchAndConsolidate } from '../categorize/fetch-catalog.js';
import { PAUSED_SEO_COHORT } from '../../functions/_shared/paused-seo-cohort.js';
import { classifyBookIntelligenceEvidence } from '../../functions/_shared/book-intelligence-evidence.js';
import { fetchGoogleBooksEvidence } from './book-intelligence-sources.mjs';
import { selectResearchCohort } from './book-intelligence-research-run.mjs';
import { officialEvidenceForIsbn } from './book-intelligence-official-evidence-pilot-data.mjs';
import {
  buildBookIntelligenceManifest,
  buildBookIntelligenceManifestEntry,
} from './book-intelligence-enrichment-manifest.mjs';

const DEFAULT_LIMIT = 12;
const DEFAULT_OUTPUT_DIR = 'artifacts/book-intelligence/enrichment-manifest-1';

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function summaryMarkdown(report) {
  const lines = [
    '# FICHAS-VIDRIERA-2 — ENRICHMENT-MANIFEST-1',
    '',
    `- Generado: ${report.generated_at}`,
    `- Cohorte: ${report.cohort.selected} ISBN con demanda GSC.`,
    `- Decisiones: auto_publish ${report.manifest.counts.auto_publish}, review ${report.manifest.counts.review}, hold ${report.manifest.counts.hold}.`,
    `- Entradas con temas oficiales: ${report.quality.entries_with_topics}.`,
    `- Entradas con hechos de edición auto-publicables: ${report.quality.entries_with_edition_fields}.`,
    `- Campos de edición bloqueados por conflicto: ${report.quality.blocked_edition_fields}.`,
    `- Google Books: ${report.sources.google_books.matched}/${report.cohort.selected} matches exactos; ${report.sources.google_books.errors} errores.`,
    '',
    '## Decisiones por producto',
    '',
    '| MLU | ISBN | Tier | Decisión | Temas | Campos edición | Review |',
    '| --- | --- | --- | --- | ---: | ---: | --- |',
    ...report.manifest.entries.map(entry => {
      const editionFields = Object.keys(entry.edition.auto_publishable_fields || {}).length;
      return `| ${entry.product_id} | ${entry.isbn || '—'} | ${entry.tier.toUpperCase()} | ${entry.decision} | ${entry.work.topic_seeds.length} | ${editionFields} | ${entry.review.required ? 'sí' : 'no'} |`;
    }),
    '',
    '## Contrato',
    '',
    '- El manifest no contiene description, summary ni author_context externos.',
    '- Los topic_seeds provienen únicamente del snapshot oficial curado.',
    '- Google Books puede elevar confianza y aportar provenance, pero no copy al manifest.',
    '- GREEN habilita auto_publish a nivel de obra; YELLOW queda review; RED queda hold.',
    '- Los hechos de edición sólo aparecen cuando el motor canónico los marcó auto-publicables y conservan provenance por campo.',
    '- Este lote no renderiza ni publica ninguna ficha.',
  ];
  return `${lines.join('\n')}\n`;
}

export async function runEnrichmentManifest({
  limit = DEFAULT_LIMIT,
  outputDir = DEFAULT_OUTPUT_DIR,
  googleBooksAccessToken = process.env.GOOGLE_BOOKS_ACCESS_TOKEN,
  googleBooksApiKey = process.env.GOOGLE_BOOKS_API_KEY,
} = {}) {
  if (!clean(googleBooksAccessToken) && !clean(googleBooksApiKey)) {
    throw new Error('ENRICHMENT-MANIFEST-1 requiere GOOGLE_BOOKS_ACCESS_TOKEN o GOOGLE_BOOKS_API_KEY.');
  }

  const catalog = await fetchAndConsolidate();
  const { selected, missing_catalog_ids: missingCatalogIds } = selectResearchCohort({
    cohort: PAUSED_SEO_COHORT,
    catalogItems: catalog.items,
    limit,
  });

  const entries = [];
  const googleAttempts = [];

  for (const item of selected) {
    let googleRecords = [];
    try {
      googleRecords = await fetchGoogleBooksEvidence(item.isbn, {
        accessToken: googleBooksAccessToken,
        apiKey: googleBooksApiKey,
      });
      googleAttempts.push({ isbn: item.isbn, ok: true, record_count: googleRecords.length });
    } catch (error) {
      googleAttempts.push({
        isbn: item.isbn,
        ok: false,
        record_count: 0,
        error: error?.message || String(error),
      });
    }

    const officialRecords = [...officialEvidenceForIsbn(item.isbn)];
    const allRecords = [...googleRecords, ...officialRecords];
    const classification = classifyBookIntelligenceEvidence(item, allRecords);
    entries.push(buildBookIntelligenceManifestEntry({
      item,
      classification,
      officialRecords,
      allRecords,
    }));
  }

  const catalogVersion = catalog.sources?.paused_manifest_version || catalog.fetched_at || null;
  const manifest = buildBookIntelligenceManifest(entries, {
    generatedAt: new Date().toISOString(),
    catalogVersion,
  });

  const quality = {
    entries_with_topics: manifest.entries.filter(entry => entry.work.topic_seeds.length > 0).length,
    entries_with_edition_fields: manifest.entries.filter(entry => Object.keys(entry.edition.auto_publishable_fields).length > 0).length,
    blocked_edition_fields: manifest.entries.reduce((sum, entry) => sum + entry.edition.blocked_fields.length, 0),
    provenance_records: manifest.entries.reduce((sum, entry) => sum + entry.provenance.length, 0),
  };

  const report = {
    schema_version: 1,
    run: 'FICHAS-VIDRIERA-2/ENRICHMENT-MANIFEST-1',
    generated_at: manifest.generated_at,
    cohort: {
      requested: positiveInteger(limit, DEFAULT_LIMIT),
      selected: selected.length,
      demand_only: true,
      missing_catalog_ids: missingCatalogIds,
      total_impressions: selected.reduce((sum, item) => sum + (Number(item.research?.gsc_impressions) || 0), 0),
      total_clicks: selected.reduce((sum, item) => sum + (Number(item.research?.gsc_clicks) || 0), 0),
    },
    sources: {
      google_books: {
        requested: googleAttempts.length,
        http_successes: googleAttempts.filter(attempt => attempt.ok).length,
        matched: googleAttempts.filter(attempt => attempt.ok && attempt.record_count > 0).length,
        errors: googleAttempts.filter(attempt => !attempt.ok).length,
      },
    },
    quality,
    manifest,
    attempts: {
      google_errors: googleAttempts.filter(attempt => !attempt.ok),
    },
  };

  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, 'enrichment-manifest.json'), JSON.stringify(manifest, null, 2));
  await writeFile(path.join(outputDir, 'enrichment-manifest-report.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(outputDir, 'report-summary.md'), summaryMarkdown(report));

  if (googleAttempts.length && !googleAttempts.some(attempt => attempt.ok)) {
    throw new Error('Google Books no completó ninguna consulta HTTP.');
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
  const report = await runEnrichmentManifest(cliOptions(process.argv.slice(2)));
  console.log(JSON.stringify({
    run: report.run,
    cohort: report.cohort,
    sources: report.sources,
    quality: report.quality,
    counts: report.manifest.counts,
  }, null, 2));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error(`[enrichment-manifest-1] ERROR: ${error?.message || error}`);
    process.exit(1);
  });
}
