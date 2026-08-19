import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const INSPECTION_ENDPOINT = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';
const DEFAULT_SITE_URL = 'sc-domain:amadolibros.com';
const DEFAULT_ACTIVE_SITEMAP = 'https://www.amadolibros.com/sitemap-books-active.xml';
const DEFAULT_BY_REQUEST_SITEMAP = 'https://www.amadolibros.com/sitemap-books-paused.xml';
const DEFAULT_ACTIVE_DAILY = 200;
const DEFAULT_BY_REQUEST_DAILY = 600;
const DEFAULT_CONCURRENCY = 8;

function assertPositiveInt(value, label, max = 2000) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0 || number > max) {
    throw new Error(`${label} debe ser un entero entre 1 y ${max}.`);
  }
  return number;
}

export function parseIsoDate(value, label = 'fecha') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) throw new Error(`${label} debe usar YYYY-MM-DD.`);
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} no es válida.`);
  }
  return date;
}

export function dayOrdinal(value) {
  const date = typeof value === 'string' ? parseIsoDate(value) : value;
  return Math.floor(date.getTime() / 86_400_000);
}

function decodeXml(value) {
  return String(value)
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'");
}

export function sitemapUrls(xml) {
  return [...String(xml || '').matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)]
    .map((match) => decodeXml(match[1]).trim())
    .filter(Boolean);
}

export function rotationSlice(urls, dailySize, ordinal) {
  const size = assertPositiveInt(dailySize, 'dailySize');
  const unique = [...new Set((urls || []).map((url) => String(url).trim()).filter(Boolean))].sort();
  if (!unique.length) return { rows: [], cycleCount: 0, cycleIndex: 0, start: 0, end: 0 };
  const cycleCount = Math.ceil(unique.length / size);
  const cycleIndex = ((Number(ordinal) % cycleCount) + cycleCount) % cycleCount;
  const start = cycleIndex * size;
  const end = Math.min(start + size, unique.length);
  return {
    rows: unique.slice(start, end),
    cycleCount,
    cycleIndex,
    start,
    end,
  };
}

async function fetchWithRetry(url, options = {}, maxAttempts = 4, parse = 'json') {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(45_000) });
      const body = await response.text();
      if (response.ok) return parse === 'text' ? body : (body ? JSON.parse(body) : {});
      const error = new Error(`HTTP ${response.status}: ${body.slice(0, 1000)}`);
      if (![429, 500, 502, 503, 504].includes(response.status)) throw error;
      lastError = error;
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 750 * 2 ** (attempt - 1)));
  }
  throw lastError;
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
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, worker));
  return results;
}

export async function inspectUrl(row, { siteUrl, accessToken, fetchFn = fetchWithRetry } = {}) {
  try {
    const response = await fetchFn(INSPECTION_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ inspectionUrl: row.page, siteUrl, languageCode: 'es-419' }),
    });
    const result = response.inspectionResult?.indexStatusResult || {};
    return {
      page: row.page,
      cohort: row.cohort,
      rotationIndex: row.rotationIndex,
      verdict: result.verdict || '',
      coverageState: result.coverageState || '',
      indexingState: result.indexingState || '',
      robotsTxtState: result.robotsTxtState || '',
      pageFetchState: result.pageFetchState || '',
      userCanonical: result.userCanonical || '',
      googleCanonical: result.googleCanonical || '',
      lastCrawlTime: result.lastCrawlTime || '',
      error: '',
    };
  } catch (error) {
    return {
      page: row.page,
      cohort: row.cohort,
      rotationIndex: row.rotationIndex,
      verdict: '',
      coverageState: '',
      indexingState: '',
      robotsTxtState: '',
      pageFetchState: '',
      userCanonical: '',
      googleCanonical: '',
      lastCrawlTime: '',
      error: String(error?.message || error),
    };
  }
}

function increment(map, key) {
  const normalized = String(key || '(vacío)');
  map[normalized] = (map[normalized] || 0) + 1;
}

export function summarizeInspectionRows(rows) {
  const summary = {
    requested: rows.length,
    completed: 0,
    errors: 0,
    pass: 0,
    canonicalMismatch: 0,
    coverageStates: {},
    pageFetchStates: {},
    cohorts: {},
  };
  for (const row of rows) {
    if (!summary.cohorts[row.cohort]) {
      summary.cohorts[row.cohort] = { requested: 0, completed: 0, errors: 0, pass: 0, coverageStates: {} };
    }
    const cohort = summary.cohorts[row.cohort];
    cohort.requested += 1;
    if (row.error) {
      summary.errors += 1;
      cohort.errors += 1;
      continue;
    }
    summary.completed += 1;
    cohort.completed += 1;
    if (row.verdict === 'PASS') {
      summary.pass += 1;
      cohort.pass += 1;
    }
    increment(summary.coverageStates, row.coverageState);
    increment(summary.pageFetchStates, row.pageFetchState);
    increment(cohort.coverageStates, row.coverageState);
    if (row.userCanonical && row.googleCanonical && row.userCanonical !== row.googleCanonical) {
      summary.canonicalMismatch += 1;
    }
  }
  return summary;
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function rowsToCsv(rows) {
  const headers = [
    'page', 'cohort', 'rotationIndex', 'verdict', 'coverageState', 'indexingState',
    'robotsTxtState', 'pageFetchState', 'userCanonical', 'googleCanonical', 'lastCrawlTime', 'error',
  ];
  return `${headers.map(csvCell).join(',')}\n${rows.map((row) => headers.map((h) => csvCell(row[h])).join(',')).join('\n')}\n`;
}

function summaryMarkdown({ date, siteUrl, selections, summary }) {
  const lines = [
    '# GSC URL Inspection — rotación diaria',
    '',
    `- Fecha UTC: ${date}`,
    `- Propiedad: \`${siteUrl}\``,
    `- Inspecciones: **${summary.completed}/${summary.requested}**`,
    `- PASS: **${summary.pass}**`,
    `- Errores: **${summary.errors}**`,
    `- Canonical distinto Google/usuario: **${summary.canonicalMismatch}**`,
    '',
    '## Selección',
    '',
    '| Cohorte | URLs sitemap | Hoy | Bloque | Bloques del ciclo |',
    '| --- | ---: | ---: | ---: | ---: |',
  ];
  for (const [cohort, value] of Object.entries(selections)) {
    lines.push(`| ${cohort} | ${value.totalUrls} | ${value.rows.length} | ${value.cycleIndex + 1} | ${value.cycleCount} |`);
  }
  lines.push(
    '',
    '## Resultado por cohorte',
    '',
    '| Cohorte | Completadas | PASS | Errores |',
    '| --- | ---: | ---: | ---: |',
  );
  for (const [cohort, value] of Object.entries(summary.cohorts)) {
    lines.push(`| ${cohort} | ${value.completed}/${value.requested} | ${value.pass} | ${value.errors} |`);
  }
  lines.push('', '## Coverage states', '');
  for (const [state, count] of Object.entries(summary.coverageStates).sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${state}: **${count}**`);
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const accessToken = process.env.GSC_ACCESS_TOKEN;
  const siteUrl = process.env.GSC_SITE_URL || DEFAULT_SITE_URL;
  const outputDir = process.env.GSC_INSPECTION_OUTPUT_DIR || 'artifacts/gsc-inspection-rotation';
  const rotationDate = process.env.GSC_ROTATION_DATE || new Date().toISOString().slice(0, 10);
  const activeDaily = assertPositiveInt(process.env.GSC_ACTIVE_DAILY || DEFAULT_ACTIVE_DAILY, 'GSC_ACTIVE_DAILY');
  const byRequestDaily = assertPositiveInt(process.env.GSC_BY_REQUEST_DAILY || DEFAULT_BY_REQUEST_DAILY, 'GSC_BY_REQUEST_DAILY');
  const concurrency = assertPositiveInt(process.env.GSC_INSPECTION_CONCURRENCY || DEFAULT_CONCURRENCY, 'GSC_INSPECTION_CONCURRENCY', 32);
  const activeSitemapUrl = process.env.GSC_ACTIVE_SITEMAP_URL || DEFAULT_ACTIVE_SITEMAP;
  const byRequestSitemapUrl = process.env.GSC_BY_REQUEST_SITEMAP_URL || DEFAULT_BY_REQUEST_SITEMAP;

  if (!accessToken) throw new Error('Falta GSC_ACCESS_TOKEN.');
  const ordinal = dayOrdinal(rotationDate);
  await mkdir(outputDir, { recursive: true });

  const [activeXml, byRequestXml] = await Promise.all([
    fetchWithRetry(activeSitemapUrl, {}, 4, 'text'),
    fetchWithRetry(byRequestSitemapUrl, {}, 4, 'text'),
  ]);
  const activeUrls = sitemapUrls(activeXml);
  const byRequestUrls = sitemapUrls(byRequestXml);
  if (!activeUrls.length || !byRequestUrls.length) throw new Error('Los sitemaps deben contener URLs.');

  const active = rotationSlice(activeUrls, activeDaily, ordinal);
  const byRequest = rotationSlice(byRequestUrls, byRequestDaily, ordinal);
  const selections = {
    by_request: { ...byRequest, totalUrls: byRequestUrls.length },
    active: { ...active, totalUrls: activeUrls.length },
  };
  const sample = [
    ...byRequest.rows.map((page, rotationIndex) => ({ page, cohort: 'by_request', rotationIndex })),
    ...active.rows.map((page, rotationIndex) => ({ page, cohort: 'active', rotationIndex })),
  ];

  const rows = await mapWithConcurrency(
    sample,
    concurrency,
    (row) => inspectUrl(row, { siteUrl, accessToken }),
  );
  const summary = summarizeInspectionRows(rows);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    rotationDate,
    siteUrl,
    quotaBudget: {
      plannedRequests: sample.length,
      documentedPerSiteDailyLimit: 2000,
    },
    selections: Object.fromEntries(Object.entries(selections).map(([key, value]) => [key, {
      totalUrls: value.totalUrls,
      selected: value.rows.length,
      cycleIndex: value.cycleIndex,
      cycleCount: value.cycleCount,
      start: value.start,
      end: value.end,
    }])),
    summary,
    rows,
  };

  await Promise.all([
    writeFile(path.join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`),
    writeFile(path.join(outputDir, 'inspection.csv'), rowsToCsv(rows)),
    writeFile(path.join(outputDir, 'report-summary.md'), summaryMarkdown({ date: rotationDate, siteUrl, selections, summary })),
  ]);

  if (summary.completed === 0) throw new Error('Ninguna URL pudo inspeccionarse.');
  if (summary.errors > Math.max(10, Math.ceil(summary.requested * 0.1))) {
    throw new Error(`Demasiados errores de inspección: ${summary.errors}/${summary.requested}.`);
  }
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
