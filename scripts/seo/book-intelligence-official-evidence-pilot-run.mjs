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
import { selectResearchCohort } from './book-intelligence-research-run.mjs';
import {
  OFFICIAL_EVIDENCE_PILOT_ISBNS,
  officialEvidenceForIsbn,
} from './book-intelligence-official-evidence-pilot-data.mjs';

const DEFAULT_LIMIT = 12;
const DEFAULT_OUTPUT_DIR = 'artifacts/book-intelligence/official-evidence-pilot-1';

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function tierValue(tier) {
  return tier === 'green' ? 2 : tier === 'yellow' ? 1 : 0;
}

function autoEditionFields(result) {
  return Object.entries(result.edition_fields_auto_publishable || {})
    .filter(([, allowed]) => allowed)
    .map(([field]) => field)
    .sort();
}

export function buildPilotResult(item, googleRecords, officialRecords, baseline, finalResult) {
  return {
    id: String(item?.id || '').toUpperCase(),
    isbn: clean(item?.isbn),
    title: clean(item?.title),
    author: clean(item?.author),
    gsc_impressions: Number(item?.research?.gsc_impressions) || 0,
    gsc_clicks: Number(item?.research?.gsc_clicks) || 0,
    google_records: Array.isArray(googleRecords) ? googleRecords.length : 0,
    official_records: Array.isArray(officialRecords) ? officialRecords.length : 0,
    official_sources: [...new Set((officialRecords || []).map(record => record.source_provider || record.source))],
    baseline_tier: baseline.tier,
    final_tier: finalResult.tier,
    tier_upgraded: tierValue(finalResult.tier) > tierValue(baseline.tier),
    baseline_reason: baseline.reason,
    final_reason: finalResult.reason,
    identity_conflicts_before: baseline.identity_conflicts.length,
    identity_conflicts_after: finalResult.identity_conflicts.length,
    work_source_count: finalResult.work_source_count,
    independent_work_source_count: finalResult.independent_work_source_count,
    strong_work_source_count: finalResult.strong_work_source_count,
    exact_isbn_source_count: finalResult.exact_isbn_source_count,
    can_generate_work_content: finalResult.generation_policy.can_generate_work_content,
    can_auto_publish_work_content: finalResult.generation_policy.can_auto_publish_work_content,
    can_generate_five_topics: finalResult.generation_policy.can_generate_five_topics,
    edition_fields_auto_publishable: autoEditionFields(finalResult),
    edition_fact_conflicts: finalResult.edition_fact_conflicts,
  };
}

export function pilotMarkdown(report) {
  const lines = [
    '# FICHAS-VIDRIERA-2 — OFFICIAL-EVIDENCE-PILOT-1',
    '',
    `- Generado: ${report.generated_at}`,
    `- Cohorte: ${report.cohort.selected} ISBN con demanda GSC.`,
    `- ISBN con evidencia oficial curada: ${report.sources.official.targeted_isbns}.`,
    `- Google Books exacto: ${report.sources.google_books.matched}/${report.cohort.selected} matches; ${report.sources.google_books.errors} errores.`,
    `- Tiers antes: GREEN ${report.classification.before.green}, YELLOW ${report.classification.before.yellow}, RED ${report.classification.before.red}.`,
    `- Tiers después: GREEN ${report.classification.after.green}, YELLOW ${report.classification.after.yellow}, RED ${report.classification.after.red}.`,
    `- Upgrades de tier: ${report.impact.tier_upgrades}.`,
    `- RED → YELLOW: ${report.impact.red_to_yellow}; RED → GREEN: ${report.impact.red_to_green}; YELLOW → GREEN: ${report.impact.yellow_to_green}.`,
    `- Generables: ${report.impact.generable_before} → ${report.impact.generable_after}.`,
    `- Auto-publicables a nivel obra: ${report.impact.auto_publish_before} → ${report.impact.auto_publish_after}.`,
    `- Con 5 temas habilitados: ${report.impact.five_topics_before} → ${report.impact.five_topics_after}.`,
    `- Conflictos de identidad: ${report.impact.identity_conflicts_before} → ${report.impact.identity_conflicts_after}.`,
    '',
    '## Resultado por ISBN',
    '',
    '| MLU | ISBN | GSC imp. | Google | Oficial | Tier antes | Tier final | Conflictos ID | Fuentes oficiales |',
    '| --- | --- | ---: | ---: | ---: | --- | --- | ---: | --- |',
    ...report.results.map(result =>
      `| ${result.id} | ${result.isbn} | ${result.gsc_impressions} | ${result.google_records} | ${result.official_records} | ${result.baseline_tier.toUpperCase()} | ${result.final_tier.toUpperCase()} | ${result.identity_conflicts_after} | ${result.official_sources.join(', ') || '—'} |`,
    ),
    '',
    '## Barreras editoriales',
    '',
    '- No se copian sinopsis externas en el dataset curado; sólo temas/facts cortos y URLs de auditoría.',
    '- Otra edición conserva su ISBN real o null y nunca contamina los datos físicos de la edición vendida.',
    '- GREEN exige dos familias independientes de evidencia de obra y al menos una fuente fuerte.',
    '- Un campo físico sólo queda auto-publicable si existe soporte exacto de ISBN con confianza suficiente y sin conflicto.',
    '- El piloto es read-only: no modifica fichas, renderer, canonical, sitemap, R2, D1, KV ni Producción.',
  ];
  return `${lines.join('\n')}\n`;
}

export async function runOfficialEvidencePilot({
  limit = DEFAULT_LIMIT,
  outputDir = DEFAULT_OUTPUT_DIR,
  googleBooksAccessToken = process.env.GOOGLE_BOOKS_ACCESS_TOKEN,
  googleBooksApiKey = process.env.GOOGLE_BOOKS_API_KEY,
} = {}) {
  if (!clean(googleBooksAccessToken) && !clean(googleBooksApiKey)) {
    throw new Error('OFFICIAL-EVIDENCE-PILOT-1 requiere GOOGLE_BOOKS_ACCESS_TOKEN o GOOGLE_BOOKS_API_KEY.');
  }

  const catalog = await fetchAndConsolidate();
  const { selected, missing_catalog_ids: missingCatalogIds } = selectResearchCohort({
    cohort: PAUSED_SEO_COHORT,
    catalogItems: catalog.items,
    limit,
  });

  const results = [];
  const baselines = [];
  const finals = [];
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
    const baseline = classifyBookIntelligenceEvidence(item, googleRecords);
    const finalResult = classifyBookIntelligenceEvidence(item, [...googleRecords, ...officialRecords]);
    baselines.push(baseline);
    finals.push(finalResult);
    results.push(buildPilotResult(item, googleRecords, officialRecords, baseline, finalResult));
  }

  const before = summarizeBookIntelligenceEvidence(baselines);
  const after = summarizeBookIntelligenceEvidence(finals);
  const report = {
    schema_version: 1,
    run: 'FICHAS-VIDRIERA-2/OFFICIAL-EVIDENCE-PILOT-1',
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
      total_items: catalog.items.length,
      fetched_at: catalog.fetched_at,
    },
    sources: {
      google_books: {
        requested: googleAttempts.length,
        http_successes: googleAttempts.filter(attempt => attempt.ok).length,
        matched: googleAttempts.filter(attempt => attempt.ok && attempt.record_count > 0).length,
        errors: googleAttempts.filter(attempt => !attempt.ok).length,
      },
      official: {
        targeted_isbns: OFFICIAL_EVIDENCE_PILOT_ISBNS.length,
        records: OFFICIAL_EVIDENCE_PILOT_ISBNS.reduce(
          (sum, isbn) => sum + officialEvidenceForIsbn(isbn).length,
          0,
        ),
      },
    },
    classification: { before, after },
    impact: {
      tier_upgrades: results.filter(result => result.tier_upgraded).length,
      red_to_yellow: results.filter(result => result.baseline_tier === 'red' && result.final_tier === 'yellow').length,
      red_to_green: results.filter(result => result.baseline_tier === 'red' && result.final_tier === 'green').length,
      yellow_to_green: results.filter(result => result.baseline_tier === 'yellow' && result.final_tier === 'green').length,
      generable_before: baselines.filter(result => result.generation_policy.can_generate_work_content).length,
      generable_after: finals.filter(result => result.generation_policy.can_generate_work_content).length,
      auto_publish_before: baselines.filter(result => result.generation_policy.can_auto_publish_work_content).length,
      auto_publish_after: finals.filter(result => result.generation_policy.can_auto_publish_work_content).length,
      five_topics_before: baselines.filter(result => result.generation_policy.can_generate_five_topics).length,
      five_topics_after: finals.filter(result => result.generation_policy.can_generate_five_topics).length,
      identity_conflicts_before: baselines.reduce((sum, result) => sum + result.identity_conflicts.length, 0),
      identity_conflicts_after: finals.reduce((sum, result) => sum + result.identity_conflicts.length, 0),
    },
    results,
    attempts: {
      google_errors: googleAttempts.filter(attempt => !attempt.ok),
    },
  };

  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, 'official-evidence-pilot-1-report.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(outputDir, 'report-summary.md'), pilotMarkdown(report));

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
  const report = await runOfficialEvidencePilot(cliOptions(process.argv.slice(2)));
  console.log(JSON.stringify({
    run: report.run,
    cohort: report.cohort,
    sources: report.sources,
    classification: report.classification,
    impact: report.impact,
  }, null, 2));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error(`[official-evidence-pilot-1] ERROR: ${error?.message || error}`);
    process.exit(1);
  });
}
