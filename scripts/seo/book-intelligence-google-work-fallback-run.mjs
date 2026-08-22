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
import {
  fetchGoogleBooksWorkEvidence,
  googleWorkIdentity,
} from './book-intelligence-google-work.mjs';
import { selectResearchCohort } from './book-intelligence-research-run.mjs';

const DEFAULT_LIMIT = 12;
const DEFAULT_OUTPUT_DIR = 'artifacts/book-intelligence/google-work-fallback-1';

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sourceRecordIsSubstantive(record) {
  const topics = Array.isArray(record?.topics) ? record.topics.filter(Boolean) : [];
  return clean(record?.description).length >= 120 || topics.length >= 3;
}

export function buildFallbackResult(item, exactRecords, workRecords, baseline, combined) {
  const substantiveWorkCandidates = (Array.isArray(workRecords) ? workRecords : [])
    .filter(sourceRecordIsSubstantive).length;
  return {
    id: String(item?.id || '').toUpperCase(),
    isbn: clean(item?.isbn),
    title: clean(item?.title),
    author: clean(item?.author),
    gsc_impressions: Number(item?.research?.gsc_impressions) || 0,
    gsc_clicks: Number(item?.research?.gsc_clicks) || 0,
    exact_records: Array.isArray(exactRecords) ? exactRecords.length : 0,
    work_search_candidates: Array.isArray(workRecords) ? workRecords.length : 0,
    work_search_substantive_candidates: substantiveWorkCandidates,
    baseline_tier: baseline.tier,
    final_tier: combined.tier,
    baseline_reason: baseline.reason,
    final_reason: combined.reason,
    accepted_work_source_count: combined.work_source_count,
    independent_work_source_count: combined.independent_work_source_count,
    strong_work_source_count: combined.strong_work_source_count,
    exact_isbn_source_count: combined.exact_isbn_source_count,
    edition_fields_auto_publishable: combined.edition_fields_auto_publishable,
    generation_policy: combined.generation_policy,
    identity_conflicts: combined.identity_conflicts,
  };
}

function tierValue(tier) {
  return tier === 'green' ? 2 : tier === 'yellow' ? 1 : 0;
}

export function fallbackMarkdown(report) {
  const lines = [
    '# FICHAS-VIDRIERA-2 — GOOGLE-WORK-FALLBACK-1',
    '',
    `- Generado: ${report.generated_at}`,
    `- Cohorte: ${report.cohort.selected} ISBN con demanda GSC.`,
    `- Google Books exacto: ${report.sources.exact.matched}/${report.cohort.selected} matches.`,
    `- Fallback título+autor intentado: ${report.sources.work_fallback.attempted}.`,
    `- Fallback HTTP exitoso: ${report.sources.work_fallback.http_successes}; errores: ${report.sources.work_fallback.errors}.`,
    `- ISBN rescatados a un tier superior: ${report.impact.tier_upgrades}.`,
    `- RED → YELLOW: ${report.impact.red_to_yellow}; RED → GREEN: ${report.impact.red_to_green}.`,
    `- Generables antes/después: ${report.impact.generable_before} → ${report.impact.generable_after}.`,
    `- Auto-publicables antes/después: ${report.impact.auto_publish_before} → ${report.impact.auto_publish_after}.`,
    '',
    '## Resultado por ISBN',
    '',
    '| MLU | ISBN | GSC imp. | Exacto | Candidatos obra | Sust. | Tier antes | Tier final |',
    '| --- | --- | ---: | ---: | ---: | ---: | --- | --- |',
    ...report.results.map(result =>
      `| ${result.id} | ${result.isbn} | ${result.gsc_impressions} | ${result.exact_records} | ${result.work_search_candidates} | ${result.work_search_substantive_candidates} | ${result.baseline_tier.toUpperCase()} | ${result.final_tier.toUpperCase()} |`,
    ),
    '',
    '## Regla de seguridad',
    '',
    '- El fallback sólo se ejecuta cuando el ISBN exacto no devolvió registros y existe título+autor confiable.',
    '- Los resultados conservan su ISBN propio. Nunca heredan el ISBN de Amado Libros.',
    '- El motor canónico sólo acepta contenido de otra edición cuando título+autor representan la misma obra.',
    '- Publisher, páginas, formato, año e idioma de otra edición no se publican como hechos de la edición de Amado Libros.',
    '- Sólo lectura. No cambia fichas, renderer, sitemap, canonical, R2, D1, KV ni Producción.',
  ];
  return `${lines.join('\n')}\n`;
}

export async function runGoogleWorkFallback({
  limit = DEFAULT_LIMIT,
  outputDir = DEFAULT_OUTPUT_DIR,
  googleBooksAccessToken = process.env.GOOGLE_BOOKS_ACCESS_TOKEN,
  googleBooksApiKey = process.env.GOOGLE_BOOKS_API_KEY,
} = {}) {
  if (!clean(googleBooksAccessToken) && !clean(googleBooksApiKey)) {
    throw new Error('GOOGLE-WORK-FALLBACK-1 requiere GOOGLE_BOOKS_ACCESS_TOKEN o GOOGLE_BOOKS_API_KEY.');
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
  const exactAttempts = [];
  const workAttempts = [];

  for (const item of selected) {
    let exactRecords = [];
    try {
      exactRecords = await fetchGoogleBooksEvidence(item.isbn, {
        accessToken: googleBooksAccessToken,
        apiKey: googleBooksApiKey,
      });
      exactAttempts.push({ isbn: item.isbn, ok: true, record_count: exactRecords.length });
    } catch (error) {
      exactAttempts.push({ isbn: item.isbn, ok: false, record_count: 0, error: error?.message || String(error) });
    }

    const baseline = classifyBookIntelligenceEvidence(item, exactRecords);
    baselines.push(baseline);

    let workRecords = [];
    if (exactRecords.length === 0) {
      const identity = googleWorkIdentity(item);
      if (!identity) {
        workAttempts.push({ isbn: item.isbn, ok: true, skipped: true, reason: 'missing_reliable_title_author', record_count: 0 });
      } else {
        try {
          workRecords = await fetchGoogleBooksWorkEvidence(item, {
            accessToken: googleBooksAccessToken,
            apiKey: googleBooksApiKey,
            maxResults: 10,
          });
          workAttempts.push({ isbn: item.isbn, ok: true, skipped: false, record_count: workRecords.length });
        } catch (error) {
          workAttempts.push({ isbn: item.isbn, ok: false, skipped: false, record_count: 0, error: error?.message || String(error) });
        }
      }
    }

    const combined = classifyBookIntelligenceEvidence(item, [...exactRecords, ...workRecords]);
    finals.push(combined);
    results.push(buildFallbackResult(item, exactRecords, workRecords, baseline, combined));
  }

  const baselineSummary = summarizeBookIntelligenceEvidence(baselines);
  const finalSummary = summarizeBookIntelligenceEvidence(finals);
  const tierUpgrades = results.filter(result => tierValue(result.final_tier) > tierValue(result.baseline_tier));

  const report = {
    schema_version: 1,
    run: 'FICHAS-VIDRIERA-2/GOOGLE-WORK-FALLBACK-1',
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
      exact: {
        requested: exactAttempts.length,
        http_successes: exactAttempts.filter(attempt => attempt.ok).length,
        matched: exactAttempts.filter(attempt => attempt.ok && attempt.record_count > 0).length,
        errors: exactAttempts.filter(attempt => !attempt.ok).length,
      },
      work_fallback: {
        attempted: workAttempts.filter(attempt => !attempt.skipped).length,
        skipped_missing_identity: workAttempts.filter(attempt => attempt.skipped).length,
        http_successes: workAttempts.filter(attempt => !attempt.skipped && attempt.ok).length,
        with_any_candidates: workAttempts.filter(attempt => !attempt.skipped && attempt.ok && attempt.record_count > 0).length,
        errors: workAttempts.filter(attempt => !attempt.skipped && !attempt.ok).length,
      },
    },
    classification: {
      before: baselineSummary,
      after: finalSummary,
    },
    impact: {
      tier_upgrades: tierUpgrades.length,
      red_to_yellow: results.filter(result => result.baseline_tier === 'red' && result.final_tier === 'yellow').length,
      red_to_green: results.filter(result => result.baseline_tier === 'red' && result.final_tier === 'green').length,
      generable_before: baselines.filter(result => result.generation_policy.can_generate_work_content).length,
      generable_after: finals.filter(result => result.generation_policy.can_generate_work_content).length,
      auto_publish_before: baselines.filter(result => result.generation_policy.can_auto_publish_work_content).length,
      auto_publish_after: finals.filter(result => result.generation_policy.can_auto_publish_work_content).length,
    },
    results,
    attempts: {
      exact_errors: exactAttempts.filter(attempt => !attempt.ok),
      work_errors: workAttempts.filter(attempt => !attempt.ok),
    },
  };

  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, 'google-work-fallback-1-report.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(outputDir, 'report-summary.md'), fallbackMarkdown(report));

  if (exactAttempts.length && !exactAttempts.some(attempt => attempt.ok)) {
    throw new Error('Google Books exacto no completó ninguna consulta HTTP.');
  }
  const plannedWork = workAttempts.filter(attempt => !attempt.skipped);
  if (plannedWork.length && !plannedWork.some(attempt => attempt.ok)) {
    throw new Error('Google Books título+autor no completó ninguna consulta HTTP.');
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
  const report = await runGoogleWorkFallback(cliOptions(process.argv.slice(2)));
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
    console.error(`[google-work-fallback-1] ERROR: ${error?.message || error}`);
    process.exit(1);
  });
}
