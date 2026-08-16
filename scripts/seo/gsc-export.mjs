import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  buildInspectionSample,
  selectCtrOpportunities,
  summarizeInspections,
} from './gsc-analysis.mjs';

const SEARCH_ANALYTICS_ROOT = 'https://www.googleapis.com/webmasters/v3/sites';
const URL_INSPECTION_ENDPOINT = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';
const OUTPUT_DIR = process.env.GSC_OUTPUT_DIR || 'artifacts/gsc';
const ACTIVE_SITEMAP_URL = process.env.GSC_ACTIVE_SITEMAP_URL
  || 'https://www.amadolibros.com/sitemap-books-active.xml';
const ROW_LIMIT = 25000;
const INSPECTION_CONCURRENCY = 8;

function assertDate(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) throw new Error(`${label} debe usar YYYY-MM-DD.`);
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} no es una fecha válida.`);
  }
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function rowsToCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) lines.push(headers.map((header) => csvCell(row[header])).join(','));
  return `${lines.join('\n')}\n`;
}

function analyticsToCsv(rows, dimensions) {
  const headers = [...dimensions, 'clicks', 'impressions', 'ctr', 'position'];
  const normalized = rows.map((row) => {
    const result = {
      clicks: row.clicks ?? 0,
      impressions: row.impressions ?? 0,
      ctr: row.ctr ?? 0,
      position: row.position ?? 0,
    };
    dimensions.forEach((dimension, index) => {
      result[dimension] = row.keys?.[index] ?? '';
    });
    return result;
  });
  return rowsToCsv(headers, normalized);
}

function ctrToCsv(rows) {
  return rowsToCsv(
    [
      'page',
      'clicks',
      'impressions',
      'ctr',
      'position',
      'benchmarkCtr',
      'estimatedMissedClicks',
      'topQueries',
    ],
    rows.map((row) => ({
      ...row,
      topQueries: row.topQueries.map((query) => query.query).join(' | '),
    })),
  );
}

function inspectionsToCsv(rows) {
  return rowsToCsv(
    [
      'page',
      'stratum',
      'verdict',
      'coverageState',
      'indexingState',
      'robotsTxtState',
      'pageFetchState',
      'userCanonical',
      'googleCanonical',
      'lastCrawlTime',
      'error',
    ],
    rows,
  );
}

function decodeXml(value) {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'");
}

function sitemapUrls(xml) {
  return [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((match) => decodeXml(match[1]));
}

async function fetchWithRetry(url, options, maxAttempts = 4, parse = 'json') {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, options);
      const body = await response.text();
      if (response.ok) {
        if (parse === 'text') return body;
        return body ? JSON.parse(body) : {};
      }
      const error = new Error(`Search Console API respondió HTTP ${response.status}: ${body}`);
      if (![429, 500, 502, 503, 504].includes(response.status)) throw error;
      lastError = error;
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 1)));
  }
  throw lastError;
}

async function queryDimensions({ siteUrl, accessToken, startDate, endDate, dimensions }) {
  const rows = [];
  let startRow = 0;
  while (true) {
    const payload = {
      startDate,
      endDate,
      dimensions,
      rowLimit: ROW_LIMIT,
      startRow,
      dataState: 'final',
    };
    const response = await fetchWithRetry(
      `${SEARCH_ANALYTICS_ROOT}/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      },
    );
    const batch = response.rows || [];
    rows.push(...batch);
    if (batch.length < ROW_LIMIT) break;
    startRow += batch.length;
  }
  return rows;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

async function inspectUrl({ page, stratum }, { siteUrl, accessToken }) {
  try {
    const response = await fetchWithRetry(URL_INSPECTION_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ inspectionUrl: page, siteUrl, languageCode: 'es-419' }),
    });
    const result = response.inspectionResult?.indexStatusResult || {};
    return {
      page,
      stratum,
      verdict: result.verdict || '',
      coverageState: result.coverageState || '',
      indexingState: result.indexingState || '',
      robotsTxtState: result.robotsTxtState || '',
      pageFetchState: result.pageFetchState || '',
      userCanonical: result.userCanonical || '',
      googleCanonical: result.googleCanonical || '',
      lastCrawlTime: result.lastCrawlTime || '',
      referringUrls: result.referringUrls || [],
      sitemap: result.sitemap || [],
      error: '',
    };
  } catch (error) {
    return {
      page,
      stratum,
      verdict: '',
      coverageState: '',
      indexingState: '',
      robotsTxtState: '',
      pageFetchState: '',
      userCanonical: '',
      googleCanonical: '',
      lastCrawlTime: '',
      referringUrls: [],
      sitemap: [],
      error: error.message,
    };
  }
}

function reportSummaryMarkdown({ siteUrl, startDate, endDate, ctrReport, inspectionSummary }) {
  const pass = inspectionSummary.verdicts.PASS || 0;
  const lines = [
    '## GSC: indexación y oportunidades CTR',
    '',
    `- Propiedad: \`${siteUrl}\``,
    `- Período: ${startDate} a ${endDate}`,
    `- Fichas con impresiones: ${ctrReport.benchmark.pageCount}`,
    `- CTR agregado de fichas: ${(ctrReport.benchmark.ctr * 100).toFixed(2)}%`,
    `- Oportunidades CTR seleccionadas: ${ctrReport.rows.length}`,
    `- URLs inspeccionadas: ${inspectionSummary.completed}/${inspectionSummary.requested}`,
    `- Veredicto PASS: ${pass}`,
    `- Errores de inspección: ${inspectionSummary.errors}`,
    '',
    '### Primeras oportunidades CTR',
    '',
    '| URL | Impresiones | CTR | Posición | Clics potenciales |',
    '| --- | ---: | ---: | ---: | ---: |',
  ];
  for (const row of ctrReport.rows.slice(0, 10)) {
    lines.push(`| ${row.page} | ${row.impressions} | ${(row.ctr * 100).toFixed(2)}% | ${row.position.toFixed(1)} | ${row.estimatedMissedClicks.toFixed(1)} |`);
  }
  lines.push('', 'Los CSV y JSON completos quedan en el artefacto de la corrida.', '');
  return lines.join('\n');
}

async function main() {
  const accessToken = process.env.GSC_ACCESS_TOKEN;
  const siteUrl = process.env.GSC_SITE_URL;
  const startDate = process.env.GSC_START_DATE;
  const endDate = process.env.GSC_END_DATE;
  const inspectionSampleSize = Number(process.env.GSC_INSPECTION_SAMPLE_SIZE || 400);

  if (!accessToken) throw new Error('Falta GSC_ACCESS_TOKEN.');
  if (!siteUrl) throw new Error('Falta GSC_SITE_URL.');
  assertDate(startDate, 'GSC_START_DATE');
  assertDate(endDate, 'GSC_END_DATE');
  if (startDate > endDate) throw new Error('GSC_START_DATE no puede ser posterior a GSC_END_DATE.');

  await mkdir(OUTPUT_DIR, { recursive: true });
  const extractedAt = new Date().toISOString();
  const manifest = {
    schemaVersion: 1,
    siteUrl,
    dateRange: { startDate, endDate },
    extractedAt,
    reports: [],
  };
  const analyticsReports = new Map();

  for (const dimensions of [['page'], ['query'], ['page', 'query']]) {
    const label = dimensions.join('-');
    process.stdout.write(`Extrayendo GSC por ${label}... `);
    const rows = await queryDimensions({ siteUrl, accessToken, startDate, endDate, dimensions });
    const report = {
      schemaVersion: 1,
      siteUrl,
      dimension: dimensions.length === 1 ? dimensions[0] : undefined,
      dimensions,
      dateRange: { startDate, endDate },
      extractedAt,
      rowCount: rows.length,
      rows,
    };
    const baseName = `search-analytics-${label}`;
    await Promise.all([
      writeFile(path.join(OUTPUT_DIR, `${baseName}.json`), `${JSON.stringify(report, null, 2)}\n`),
      writeFile(path.join(OUTPUT_DIR, `${baseName}.csv`), analyticsToCsv(rows, dimensions)),
    ]);
    manifest.reports.push({
      type: 'search-analytics',
      dimension: dimensions.length === 1 ? dimensions[0] : undefined,
      dimensions,
      rowCount: rows.length,
      json: `${baseName}.json`,
      csv: `${baseName}.csv`,
    });
    analyticsReports.set(label, rows);
    console.log(`${rows.length} filas.`);
  }

  const ctrReport = selectCtrOpportunities({
    pageRows: analyticsReports.get('page'),
    pageQueryRows: analyticsReports.get('page-query'),
  });
  await Promise.all([
    writeFile(path.join(OUTPUT_DIR, 'ctr-opportunities.json'), `${JSON.stringify(ctrReport, null, 2)}\n`),
    writeFile(path.join(OUTPUT_DIR, 'ctr-opportunities.csv'), ctrToCsv(ctrReport.rows)),
  ]);
  manifest.reports.push({
    type: 'ctr-opportunities',
    rowCount: ctrReport.rows.length,
    json: 'ctr-opportunities.json',
    csv: 'ctr-opportunities.csv',
  });

  process.stdout.write(`Descargando sitemap activo ${ACTIVE_SITEMAP_URL}... `);
  const sitemapXml = await fetchWithRetry(ACTIVE_SITEMAP_URL, {}, 4, 'text');
  const activeUrls = sitemapUrls(sitemapXml);
  console.log(`${activeUrls.length} URLs.`);
  if (!activeUrls.length) throw new Error('El sitemap activo no devolvió URLs.');

  const inspectionSample = buildInspectionSample({
    sitemapUrls: activeUrls,
    pageRows: analyticsReports.get('page'),
    ctrOpportunities: ctrReport.rows,
    size: inspectionSampleSize,
  });
  console.log(`Inspeccionando ${inspectionSample.length} fichas con concurrencia ${INSPECTION_CONCURRENCY}...`);
  const inspections = await mapWithConcurrency(
    inspectionSample,
    INSPECTION_CONCURRENCY,
    (sample) => inspectUrl(sample, { siteUrl, accessToken }),
  );
  const inspectionSummary = summarizeInspections(inspections);
  const inspectionReport = {
    schemaVersion: 1,
    siteUrl,
    sitemapUrl: ACTIVE_SITEMAP_URL,
    extractedAt,
    sampleSize: inspectionSample.length,
    sampleMethod: 'CTR/alta demanda + vistas en Search + activas sin impresiones; selección estable por URL',
    summary: inspectionSummary,
    rows: inspections,
  };
  await Promise.all([
    writeFile(path.join(OUTPUT_DIR, 'url-inspection-sample.json'), `${JSON.stringify(inspectionReport, null, 2)}\n`),
    writeFile(path.join(OUTPUT_DIR, 'url-inspection-sample.csv'), inspectionsToCsv(inspections)),
  ]);
  manifest.reports.push({
    type: 'url-inspection-sample',
    rowCount: inspections.length,
    json: 'url-inspection-sample.json',
    csv: 'url-inspection-sample.csv',
  });

  const summaryMarkdown = reportSummaryMarkdown({
    siteUrl,
    startDate,
    endDate,
    ctrReport,
    inspectionSummary,
  });
  await Promise.all([
    writeFile(path.join(OUTPUT_DIR, 'report-summary.md'), summaryMarkdown),
    writeFile(path.join(OUTPUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`),
  ]);

  console.log(`Extracción terminada en ${OUTPUT_DIR}.`);
  if (inspectionSummary.completed === 0) {
    throw new Error('Ninguna URL pudo inspeccionarse; revisar permisos de la cuenta de servicio en Search Console.');
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
