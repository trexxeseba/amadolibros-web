import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const API_ROOT = 'https://www.googleapis.com/webmasters/v3/sites';
const OUTPUT_DIR = process.env.GSC_OUTPUT_DIR || 'artifacts/gsc';
const ROW_LIMIT = 25000;

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

function toCsv(rows, dimension) {
  const headers = [dimension, 'clicks', 'impressions', 'ctr', 'position'];
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) {
    lines.push([
      row.keys?.[0] ?? '',
      row.clicks ?? 0,
      row.impressions ?? 0,
      row.ctr ?? 0,
      row.position ?? 0,
    ].map(csvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

async function fetchWithRetry(url, options, maxAttempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, options);
      const body = await response.text();
      if (response.ok) return body ? JSON.parse(body) : {};
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

async function queryDimension({ siteUrl, accessToken, startDate, endDate, dimension }) {
  const rows = [];
  let startRow = 0;
  while (true) {
    const payload = {
      startDate,
      endDate,
      dimensions: [dimension],
      rowLimit: ROW_LIMIT,
      startRow,
      dataState: 'final',
    };
    const response = await fetchWithRetry(
      `${API_ROOT}/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
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

async function main() {
  const accessToken = process.env.GSC_ACCESS_TOKEN;
  const siteUrl = process.env.GSC_SITE_URL;
  const startDate = process.env.GSC_START_DATE;
  const endDate = process.env.GSC_END_DATE;

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

  for (const dimension of ['page', 'query']) {
    process.stdout.write(`Extrayendo GSC por ${dimension}... `);
    const rows = await queryDimension({ siteUrl, accessToken, startDate, endDate, dimension });
    const report = {
      schemaVersion: 1,
      siteUrl,
      dimension,
      dateRange: { startDate, endDate },
      extractedAt,
      rowCount: rows.length,
      rows,
    };
    const baseName = `search-analytics-${dimension}`;
    await Promise.all([
      writeFile(path.join(OUTPUT_DIR, `${baseName}.json`), `${JSON.stringify(report, null, 2)}\n`),
      writeFile(path.join(OUTPUT_DIR, `${baseName}.csv`), toCsv(rows, dimension)),
    ]);
    manifest.reports.push({ dimension, rowCount: rows.length, json: `${baseName}.json`, csv: `${baseName}.csv` });
    console.log(`${rows.length} filas.`);
  }

  await writeFile(path.join(OUTPUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Extracción terminada en ${OUTPUT_DIR}.`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
