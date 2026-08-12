'use strict';

const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');

const API_ROOT = 'https://analyticsdata.googleapis.com/v1beta';
const ORGANIC_FILTER = {
  filter: {
    fieldName: 'sessionDefaultChannelGroup',
    stringFilter: { matchType: 'EXACT', value: 'Organic Search' },
  },
};

const AI_REFERRAL_SOURCES = [
  'chatgpt.com',
  'chat.openai.com',
  'claude.ai',
  'gemini.google.com',
  'bard.google.com',
  'perplexity.ai',
  'copilot.microsoft.com',
];

const AI_REFERRAL_FILTER = {
  filter: {
    fieldName: 'sessionSource',
    inListFilter: {
      values: AI_REFERRAL_SOURCES,
      caseSensitive: false,
    },
  },
};

const WHATSAPP_EVENT_FILTER = {
  filter: {
    fieldName: 'eventName',
    stringFilter: { matchType: 'EXACT', value: 'whatsapp_click' },
  },
};

const REPORTS = [
  {
    id: 'organic-summary',
    metrics: [
      'sessions',
      'totalUsers',
      'engagedSessions',
      'engagementRate',
      'keyEvents',
      'sessionKeyEventRate',
      'ecommercePurchases',
      'purchaseRevenue',
    ],
    filter: ORGANIC_FILTER,
  },
  {
    id: 'organic-landing-pages',
    dimensions: ['landingPagePlusQueryString'],
    metrics: [
      'sessions',
      'totalUsers',
      'engagedSessions',
      'engagementRate',
      'keyEvents',
      'sessionKeyEventRate',
      'ecommercePurchases',
      'purchaseRevenue',
    ],
    filter: ORGANIC_FILTER,
  },
  {
    id: 'organic-devices',
    dimensions: ['deviceCategory'],
    metrics: [
      'sessions',
      'totalUsers',
      'engagedSessions',
      'engagementRate',
      'ecommercePurchases',
      'purchaseRevenue',
    ],
    filter: ORGANIC_FILTER,
  },
  {
    id: 'organic-source-medium',
    dimensions: ['sessionSourceMedium'],
    metrics: ['sessions', 'totalUsers', 'engagedSessions', 'engagementRate'],
    filter: ORGANIC_FILTER,
  },
  {
    id: 'event-inventory',
    dimensions: ['eventName'],
    metrics: ['eventCount', 'totalUsers'],
  },
  {
    id: 'all-landing-pages',
    dimensions: ['sessionSource', 'sessionMedium', 'landingPagePlusQueryString'],
    metrics: [
      'sessions',
      'totalUsers',
      'engagedSessions',
      'engagementRate',
      'keyEvents',
      'sessionKeyEventRate',
    ],
  },
  {
    id: 'ai-referral-sources',
    dimensions: ['sessionSource', 'sessionMedium'],
    metrics: [
      'sessions',
      'totalUsers',
      'engagedSessions',
      'engagementRate',
      'keyEvents',
      'sessionKeyEventRate',
    ],
    filter: AI_REFERRAL_FILTER,
  },
  {
    id: 'ai-referral-landing-pages',
    dimensions: ['sessionSource', 'sessionMedium', 'landingPagePlusQueryString'],
    metrics: [
      'sessions',
      'totalUsers',
      'engagedSessions',
      'engagementRate',
      'keyEvents',
      'sessionKeyEventRate',
    ],
    filter: AI_REFERRAL_FILTER,
  },
  {
    id: 'whatsapp-intent',
    dimensions: ['sessionSource', 'sessionMedium', 'landingPagePlusQueryString'],
    metrics: ['sessions', 'totalUsers', 'eventCount'],
    filter: WHATSAPP_EVENT_FILTER,
  },
  {
    id: 'whatsapp-click-pages',
    dimensions: ['pagePath'],
    metrics: ['eventCount', 'totalUsers'],
    filter: WHATSAPP_EVENT_FILTER,
  },
  {
    id: 'organic-ecommerce-events',
    dimensions: ['eventName'],
    metrics: ['eventCount', 'totalUsers'],
    filter: {
      andGroup: {
        expressions: [
          ORGANIC_FILTER,
          {
            filter: {
              fieldName: 'eventName',
              inListFilter: {
                values: ['view_item', 'add_to_cart', 'begin_checkout', 'purchase'],
              },
            },
          },
        ],
      },
    },
  },
];

function assertDate(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) {
    throw new Error(`${label} debe usar formato YYYY-MM-DD.`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} no es una fecha válida.`);
  }
}

function buildRequest(report, startDate, endDate) {
  return {
    dateRanges: [{ startDate, endDate }],
    dimensions: (report.dimensions || []).map((name) => ({ name })),
    metrics: report.metrics.map((name) => ({ name })),
    ...(report.filter ? { dimensionFilter: report.filter } : {}),
    keepEmptyRows: true,
    limit: '100000',
    returnPropertyQuota: true,
  };
}

function normalizeReport(report, response, context) {
  const dimensions = (response.dimensionHeaders || []).map(({ name }) => name);
  const metrics = (response.metricHeaders || []).map(({ name, type }) => ({ name, type }));
  const rows = (response.rows || []).map((row) => ({
    dimensions: Object.fromEntries(
      dimensions.map((name, index) => [name, row.dimensionValues?.[index]?.value ?? '']),
    ),
    metrics: Object.fromEntries(
      metrics.map(({ name }, index) => [name, row.metricValues?.[index]?.value ?? '']),
    ),
  }));

  return {
    report: report.id,
    property: context.property,
    dateRange: { startDate: context.startDate, endDate: context.endDate },
    extractedAt: context.extractedAt,
    rowCount: Number(response.rowCount || rows.length),
    dimensions,
    metrics,
    rows,
    totals: response.totals || [],
    propertyQuota: response.propertyQuota || null,
  };
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function toCsv(report) {
  const metricNames = report.metrics.map(({ name }) => name);
  const headers = [...report.dimensions, ...metricNames];
  const lines = [headers.map(csvCell).join(',')];
  for (const row of report.rows) {
    lines.push(
      headers
        .map((name) => csvCell(row.dimensions[name] ?? row.metrics[name] ?? ''))
        .join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

async function fetchWithRetry(url, options, maxAttempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response.json();
      const body = await response.text();
      const error = new Error(`GA4 Data API respondió HTTP ${response.status}: ${body}`);
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

async function main() {
  const propertyId = process.env.GA4_PROPERTY_ID;
  const accessToken = process.env.GA4_ACCESS_TOKEN;
  const startDate = process.env.GA4_START_DATE || '2026-07-01';
  const endDate = process.env.GA4_END_DATE || '2026-07-31';
  const outputDir = process.env.GA4_OUTPUT_DIR || 'artifacts/ga4';

  if (!/^\d+$/.test(propertyId || '')) throw new Error('Falta GA4_PROPERTY_ID numérico.');
  if (!accessToken) throw new Error('Falta GA4_ACCESS_TOKEN.');
  assertDate(startDate, 'GA4_START_DATE');
  assertDate(endDate, 'GA4_END_DATE');
  if (startDate > endDate) throw new Error('GA4_START_DATE no puede ser posterior a GA4_END_DATE.');

  const extractedAt = new Date().toISOString();
  const context = {
    property: `properties/${propertyId}`,
    startDate,
    endDate,
    extractedAt,
  };
  await mkdir(outputDir, { recursive: true });

  const manifest = {
    property: context.property,
    dateRange: { startDate, endDate },
    extractedAt,
    reports: [],
  };

  for (const report of REPORTS) {
    process.stdout.write(`Extrayendo ${report.id}... `);
    const response = await fetchWithRetry(
      `${API_ROOT}/${context.property}:runReport`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(buildRequest(report, startDate, endDate)),
      },
    );
    const normalized = normalizeReport(report, response, context);
    await Promise.all([
      writeFile(path.join(outputDir, `${report.id}.json`), `${JSON.stringify(normalized, null, 2)}\n`),
      writeFile(path.join(outputDir, `${report.id}.csv`), toCsv(normalized)),
    ]);
    manifest.reports.push({
      id: report.id,
      rowCount: normalized.rowCount,
      json: `${report.id}.json`,
      csv: `${report.id}.csv`,
    });
    console.log(`${normalized.rowCount} filas.`);
  }

  await writeFile(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Extracción terminada en ${outputDir}.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  AI_REFERRAL_SOURCES,
  REPORTS,
  assertDate,
  buildRequest,
  normalizeReport,
  toCsv,
};
