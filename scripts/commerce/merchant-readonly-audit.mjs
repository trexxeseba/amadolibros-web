import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const API_ROOT = 'https://merchantapi.googleapis.com';
const DEFAULT_ACCOUNT_ID = '5330457716';
const DEFAULT_FEED_URL = 'https://www.amadolibros.com/feed.xml';
const DAY_MS = 24 * 60 * 60 * 1000;

function asText(value) {
  return String(value ?? '').trim();
}

function asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function upper(value) {
  return asText(value).toUpperCase();
}

function isDynamicRemarketing(value) {
  const normalized = upper(value);
  return normalized.includes('DYNAMIC') || normalized.includes('REMARKETING') || normalized === 'DISPLAY_ADS';
}

function isUy(value) {
  return upper(value) === 'UY';
}

function safeFetchUri(value) {
  const raw = asText(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '[configured]';
  }
}

export function countFeedItems(xml) {
  return [...String(xml || '').matchAll(/<item(?:\s|>)/gi)].length;
}

export function summarizeDataSource(source = {}) {
  const typeKeys = [
    'primaryProductDataSource',
    'supplementalProductDataSource',
    'localInventoryDataSource',
    'regionalInventoryDataSource',
    'promotionDataSource',
    'productReviewDataSource',
    'merchantReviewDataSource',
  ];
  const type = typeKeys.find(key => source[key] != null) || 'unknown';
  const fileInput = source.fileInput || {};
  const fetchSettings = fileInput.fetchSettings || source.fetchSettings || {};
  const timeOfDay = fetchSettings.timeOfDay || {};

  return {
    name: asText(source.name) || null,
    dataSourceId: asText(source.dataSourceId) || null,
    displayName: asText(source.displayName) || '(sin nombre)',
    input: asText(source.input) || null,
    type,
    fileInputType: asText(fileInput.fileInputType || fileInput.inputType) || null,
    fetchUri: safeFetchUri(fetchSettings.fetchUri || fileInput.fetchUri),
    frequency: asText(fetchSettings.frequency) || null,
    dayOfWeek: asText(fetchSettings.dayOfWeek) || null,
    dayOfMonth: fetchSettings.dayOfMonth ?? null,
    timeOfDay: Object.keys(timeOfDay).length
      ? {
          hours: timeOfDay.hours ?? null,
          minutes: timeOfDay.minutes ?? null,
          seconds: timeOfDay.seconds ?? null,
        }
      : null,
  };
}

export function summarizeAccountIssue(issue = {}) {
  const impacted = Array.isArray(issue.impactedDestinations)
    ? issue.impactedDestinations
    : Array.isArray(issue.impacts)
      ? issue.impacts
      : [];
  return {
    name: asText(issue.name) || null,
    title: asText(issue.title) || asText(issue.description) || '(sin título)',
    severity: asText(issue.severity) || null,
    detail: asText(issue.detail) || null,
    documentationUri: asText(issue.documentationUri || issue.documentation) || null,
    impactedDestinations: impacted.map(row => ({
      reportingContext: asText(row.reportingContext) || null,
      impacts: Array.isArray(row.impacts)
        ? row.impacts.map(impact => ({
            regionCode: asText(impact.regionCode) || null,
            severity: asText(impact.severity) || null,
          }))
        : [],
    })),
  };
}

export function aggregateDynamicRemarketingUy(rows = []) {
  const matching = rows.filter(row => isUy(row?.country) && isDynamicRemarketing(row?.reportingContext));
  return matching.reduce((summary, row) => {
    const stats = row.stats || {};
    summary.rows += 1;
    summary.contexts.push(asText(row.reportingContext));
    summary.active += asNumber(stats.activeCount);
    summary.pending += asNumber(stats.pendingCount);
    summary.disapproved += asNumber(stats.disapprovedCount);
    summary.expiring += asNumber(stats.expiringCount);
    for (const issue of Array.isArray(row.itemLevelIssues) ? row.itemLevelIssues : []) {
      const key = asText(issue.code) || '(sin código)';
      const current = summary.issueCounts.get(key) || {
        code: key,
        severity: asText(issue.severity) || null,
        resolution: asText(issue.resolution) || null,
        attribute: asText(issue.attribute) || null,
        description: asText(issue.description) || null,
        detail: asText(issue.detail) || null,
        documentationUri: asText(issue.documentationUri) || null,
        productCount: 0,
      };
      current.productCount += asNumber(issue.productCount);
      summary.issueCounts.set(key, current);
    }
    return summary;
  }, {
    rows: 0,
    contexts: [],
    active: 0,
    pending: 0,
    disapproved: 0,
    expiring: 0,
    issueCounts: new Map(),
  });
}

function finalizeAggregate(summary) {
  return {
    rows: summary.rows,
    contexts: [...new Set(summary.contexts.filter(Boolean))],
    active: summary.active,
    pending: summary.pending,
    disapproved: summary.disapproved,
    expiring: summary.expiring,
    topIssues: [...summary.issueCounts.values()]
      .sort((a, b) => b.productCount - a.productCount || a.code.localeCompare(b.code))
      .slice(0, 30),
  };
}

function productDestinationState(product, country = 'UY') {
  const rows = Array.isArray(product?.productStatus?.destinationStatuses)
    ? product.productStatus.destinationStatuses.filter(row => isDynamicRemarketing(row.reportingContext))
    : [];
  const approved = rows.some(row => (row.approvedCountries || []).some(isUy));
  const pending = rows.some(row => (row.pendingCountries || []).some(isUy));
  const disapproved = rows.some(row => (row.disapprovedCountries || []).some(isUy));
  if (approved) return 'active';
  if (pending) return 'pending';
  if (disapproved) return 'disapproved';
  return rows.length ? 'other_country' : 'missing_context';
}

export function summarizeProducts(products = [], now = new Date()) {
  const nowMs = now.getTime();
  const issueCounts = new Map();
  const bySource = new Map();
  const destination = {
    active: 0,
    pending: 0,
    disapproved: 0,
    other_country: 0,
    missing_context: 0,
  };
  let archived = 0;
  let expiringWithin3Days = 0;
  let expiringWithin7Days = 0;
  let alreadyExpired = 0;
  let oldestUpdate = null;
  let newestUpdate = null;

  for (const product of products) {
    const source = asText(product.dataSource) || '(sin fuente)';
    bySource.set(source, (bySource.get(source) || 0) + 1);
    if (product.archived === true) archived += 1;

    const state = productDestinationState(product);
    destination[state] += 1;

    const status = product.productStatus || {};
    const expirationMs = Date.parse(status.googleExpirationDate || '');
    if (Number.isFinite(expirationMs)) {
      const distance = expirationMs - nowMs;
      if (distance < 0) alreadyExpired += 1;
      else {
        if (distance <= 3 * DAY_MS) expiringWithin3Days += 1;
        if (distance <= 7 * DAY_MS) expiringWithin7Days += 1;
      }
    }

    const updateMs = Date.parse(status.lastUpdateDate || '');
    if (Number.isFinite(updateMs)) {
      if (oldestUpdate == null || updateMs < oldestUpdate) oldestUpdate = updateMs;
      if (newestUpdate == null || updateMs > newestUpdate) newestUpdate = updateMs;
    }

    for (const issue of Array.isArray(status.itemLevelIssues) ? status.itemLevelIssues : []) {
      const countries = Array.isArray(issue.applicableCountries) ? issue.applicableCountries : [];
      if (!isDynamicRemarketing(issue.reportingContext)) continue;
      if (countries.length && !countries.some(isUy)) continue;
      const key = asText(issue.code) || '(sin código)';
      const current = issueCounts.get(key) || {
        code: key,
        severity: asText(issue.severity) || null,
        resolution: asText(issue.resolution) || null,
        attribute: asText(issue.attribute) || null,
        description: asText(issue.description) || null,
        detail: asText(issue.detail) || null,
        documentation: asText(issue.documentation) || null,
        products: 0,
      };
      current.products += 1;
      issueCounts.set(key, current);
    }
  }

  return {
    processed: products.length,
    archived,
    dynamicRemarketingUy: destination,
    expiringWithin3Days,
    expiringWithin7Days,
    alreadyExpired,
    oldestUpdateDate: oldestUpdate == null ? null : new Date(oldestUpdate).toISOString(),
    newestUpdateDate: newestUpdate == null ? null : new Date(newestUpdate).toISOString(),
    byDataSource: [...bySource.entries()]
      .map(([dataSource, count]) => ({ dataSource, count }))
      .sort((a, b) => b.count - a.count || a.dataSource.localeCompare(b.dataSource)),
    topIssues: [...issueCounts.values()]
      .sort((a, b) => b.products - a.products || a.code.localeCompare(b.code))
      .slice(0, 30),
  };
}

export function buildDiagnosis({ alert, feedCount, dataSources, accountIssues, aggregate, products }) {
  const facts = [];
  const hypotheses = [];
  const active = aggregate?.active || products?.dynamicRemarketingUy?.active || 0;
  const primarySources = dataSources.filter(row => row.type === 'primaryProductDataSource');

  facts.push(`El correo informó una caída de ${alert.previousActive} a ${alert.currentActive} artículos activos para Dynamic remarketing en UY.`);
  if (feedCount != null) facts.push(`El feed público contiene ${feedCount} ofertas en esta lectura.`);
  if (products) facts.push(`Merchant devolvió ${products.processed} productos procesados.`);
  if (active) facts.push(`La API informó ${active} productos activos para Dynamic remarketing en UY.`);
  if (aggregate?.pending) facts.push(`${aggregate.pending} productos están pendientes para ese destino.`);
  if (aggregate?.disapproved) facts.push(`${aggregate.disapproved} productos están rechazados para ese destino.`);
  if (aggregate?.expiring || products?.expiringWithin3Days) {
    facts.push(`${aggregate?.expiring || products?.expiringWithin3Days} productos aparecen próximos a vencer.`);
  }
  if (accountIssues.length) facts.push(`Hay ${accountIssues.length} problemas de cuenta devueltos por la API.`);

  if (feedCount != null && active && feedCount > active) {
    hypotheses.push({
      confidence: 'high',
      text: `Hay ${feedCount - active} ofertas en el feed que no están activas para Dynamic remarketing UY; la causa debe localizarse en procesamiento, vencimiento, reglas o rechazos de Merchant.`,
    });
  }
  if (feedCount != null && alert.previousActive > feedCount) {
    hypotheses.push({
      confidence: 'medium',
      text: `La cifra anterior de activos superaba al feed actual por ${alert.previousActive - feedCount}; esto es compatible con productos antiguos o una fuente adicional que luego vencieron o dejaron de servir.`,
    });
  }
  if (primarySources.length > 1) {
    hypotheses.push({
      confidence: 'high',
      text: `Merchant tiene ${primarySources.length} fuentes primarias; hay que revisar si una fuente vieja o automática está duplicando o caducando productos.`,
    });
  }
  if (products?.expiringWithin3Days > 0) {
    hypotheses.push({
      confidence: 'high',
      text: `${products.expiringWithin3Days} productos procesados vencen dentro de 3 días y pueden explicar parte de la alerta.`,
    });
  }

  return { facts, hypotheses };
}

async function requestJson(url, accessToken) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(60_000),
  });
  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : {}; } catch {}
  if (!response.ok) {
    const error = new Error(data?.error?.message || `HTTP ${response.status}`);
    error.status = response.status;
    error.apiStatus = data?.error?.status || null;
    error.details = Array.isArray(data?.error?.details)
      ? data.error.details.map(row => ({
          type: row?.['@type'] || null,
          reason: row?.reason || row?.metadata?.service || null,
        }))
      : [];
    throw error;
  }
  return data || {};
}

async function listAll({ endpoint, arrayField, pageSize, accessToken }) {
  const rows = [];
  let pageToken = '';
  for (let page = 0; page < 30; page += 1) {
    const url = new URL(endpoint);
    url.searchParams.set('pageSize', String(pageSize));
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const data = await requestJson(url, accessToken);
    if (Array.isArray(data[arrayField])) rows.push(...data[arrayField]);
    pageToken = asText(data.nextPageToken);
    if (!pageToken) return rows;
  }
  throw new Error(`Paginación excedió 30 páginas para ${arrayField}`);
}

function endpointError(error) {
  return {
    message: asText(error?.message) || 'Error desconocido',
    httpStatus: Number(error?.status) || null,
    apiStatus: asText(error?.apiStatus) || null,
    details: Array.isArray(error?.details) ? error.details : [],
  };
}

async function runEndpoint(name, fn) {
  try {
    return { name, ok: true, data: await fn(), error: null };
  } catch (error) {
    return { name, ok: false, data: null, error: endpointError(error) };
  }
}

function markdownEscape(value) {
  return asText(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function reportMarkdown(report) {
  const lines = [
    '# Merchant Center — auditoría de solo lectura',
    '',
    `- Cuenta: ${report.accountId}`,
    `- Generado: ${report.generatedAt}`,
    `- Feed público: ${report.publicFeed.ok ? `${report.publicFeed.items} ofertas` : `error: ${report.publicFeed.error}`}`,
    '',
    '## Alerta recibida',
    '',
    `Dynamic remarketing UY: ${report.alert.previousActive} → ${report.alert.currentActive} (${report.alert.dropPercent}% de descenso; ${report.alert.dropCount} artículos).`,
    '',
  ];

  if (report.dynamicRemarketingUy) {
    const row = report.dynamicRemarketingUy;
    lines.push(
      '## Estado API — Dynamic remarketing UY',
      '',
      '| Activos | Pendientes | Rechazados | Próximos a vencer |',
      '| ---: | ---: | ---: | ---: |',
      `| ${row.active} | ${row.pending} | ${row.disapproved} | ${row.expiring} |`,
      '',
    );
  }

  if (report.products) {
    const product = report.products;
    lines.push(
      '## Productos procesados',
      '',
      `- Total procesado: ${product.processed}`,
      `- Vencen en 3 días: ${product.expiringWithin3Days}`,
      `- Vencen en 7 días: ${product.expiringWithin7Days}`,
      `- Archivados: ${product.archived}`,
      '',
    );
  }

  lines.push('## Fuentes de datos', '', '| Fuente | Tipo | Entrada | Frecuencia | URI segura |', '| --- | --- | --- | --- | --- |');
  if (!report.dataSources.length) lines.push('| — | — | — | — | — |');
  for (const source of report.dataSources) {
    lines.push(`| ${markdownEscape(source.displayName)} | ${source.type} | ${source.input || '—'} | ${source.frequency || '—'} | ${markdownEscape(source.fetchUri || '—')} |`);
  }
  lines.push('', '## Diagnóstico', '');
  for (const fact of report.diagnosis.facts) lines.push(`- Hecho: ${fact}`);
  for (const hypothesis of report.diagnosis.hypotheses) lines.push(`- Hipótesis ${hypothesis.confidence}: ${hypothesis.text}`);

  lines.push('', '## Problemas principales', '', '| Código | Severidad | Productos | Descripción |', '| --- | --- | ---: | --- |');
  const issues = report.dynamicRemarketingUy?.topIssues?.length
    ? report.dynamicRemarketingUy.topIssues
    : report.products?.topIssues || [];
  if (!issues.length) lines.push('| — | — | 0 | Sin problemas devueltos para este destino |');
  for (const issue of issues.slice(0, 20)) {
    lines.push(`| ${markdownEscape(issue.code)} | ${issue.severity || '—'} | ${issue.productCount ?? issue.products ?? 0} | ${markdownEscape(issue.description || issue.detail || '—')} |`);
  }

  lines.push('', '## Endpoints', '');
  for (const endpoint of report.endpoints) {
    lines.push(`- ${endpoint.name}: ${endpoint.ok ? 'OK' : `ERROR ${endpoint.error?.httpStatus || ''} ${endpoint.error?.apiStatus || ''} — ${endpoint.error?.message || ''}`}`);
  }
  lines.push('', '> Esta auditoría no modifica, recupera, crea ni elimina productos o fuentes. Todas las llamadas a Merchant API son GET.');
  return `${lines.join('\n')}\n`;
}

export async function main() {
  const accessToken = asText(process.env.MERCHANT_ACCESS_TOKEN);
  const accountId = asText(process.env.MERCHANT_ACCOUNT_ID) || DEFAULT_ACCOUNT_ID;
  const outputDir = asText(process.env.MERCHANT_OUTPUT_DIR) || 'artifacts/merchant';
  const feedUrl = asText(process.env.MERCHANT_PUBLIC_FEED_URL) || DEFAULT_FEED_URL;
  if (!accessToken) throw new Error('Falta MERCHANT_ACCESS_TOKEN.');
  if (!/^\d+$/.test(accountId)) throw new Error('MERCHANT_ACCOUNT_ID inválido.');

  const parent = `accounts/${accountId}`;
  const endpoints = [];
  endpoints.push(await runEndpoint('accountIssues', () => listAll({
    endpoint: `${API_ROOT}/accounts/v1/${parent}/issues?languageCode=es-419&timeZone=America%2FMontevideo`,
    arrayField: 'accountIssues',
    pageSize: 100,
    accessToken,
  })));
  endpoints.push(await runEndpoint('dataSources', () => listAll({
    endpoint: `${API_ROOT}/datasources/v1/${parent}/dataSources`,
    arrayField: 'dataSources',
    pageSize: 1000,
    accessToken,
  })));
  endpoints.push(await runEndpoint('aggregateProductStatuses', () => listAll({
    endpoint: `${API_ROOT}/issueresolution/v1/${parent}/aggregateProductStatuses`,
    arrayField: 'aggregateProductStatuses',
    pageSize: 250,
    accessToken,
  })));
  endpoints.push(await runEndpoint('products', () => listAll({
    endpoint: `${API_ROOT}/products/v1/${parent}/products`,
    arrayField: 'products',
    pageSize: 1000,
    accessToken,
  })));

  const byName = Object.fromEntries(endpoints.map(row => [row.name, row]));
  const publicFeed = await (async () => {
    try {
      const response = await fetch(feedUrl, { signal: AbortSignal.timeout(60_000) });
      const xml = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return { ok: true, url: feedUrl, items: countFeedItems(xml), bytes: Buffer.byteLength(xml) };
    } catch (error) {
      return { ok: false, url: feedUrl, items: null, bytes: null, error: asText(error?.message) };
    }
  })();

  const dataSources = (byName.dataSources.data || []).map(summarizeDataSource);
  const accountIssues = (byName.accountIssues.data || []).map(summarizeAccountIssue);
  const aggregate = finalizeAggregate(aggregateDynamicRemarketingUy(byName.aggregateProductStatuses.data || []));
  const products = byName.products.ok ? summarizeProducts(byName.products.data || [], new Date()) : null;
  const alert = {
    observedAt: '2026-08-17T00:20:00-03:00',
    previousActive: 3745,
    currentActive: 2981,
    dropCount: 764,
    dropPercent: 20,
    reportingContext: 'Dynamic remarketing',
    country: 'UY',
  };
  const dynamicRemarketingUy = aggregate.rows ? aggregate : products
    ? {
        rows: 0,
        contexts: [],
        active: products.dynamicRemarketingUy.active,
        pending: products.dynamicRemarketingUy.pending,
        disapproved: products.dynamicRemarketingUy.disapproved,
        expiring: products.expiringWithin3Days,
        topIssues: products.topIssues,
      }
    : null;

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    accountId,
    alert,
    publicFeed,
    endpoints: endpoints.map(row => ({ name: row.name, ok: row.ok, error: row.error })),
    dataSources,
    accountIssues,
    aggregateStatuses: byName.aggregateProductStatuses.ok ? byName.aggregateProductStatuses.data : null,
    dynamicRemarketingUy,
    products,
    diagnosis: buildDiagnosis({
      alert,
      feedCount: publicFeed.ok ? publicFeed.items : null,
      dataSources,
      accountIssues,
      aggregate: dynamicRemarketingUy,
      products,
    }),
  };

  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDir, 'merchant-readonly-report.json'), `${JSON.stringify(report, null, 2)}\n`),
    writeFile(path.join(outputDir, 'report-summary.md'), reportMarkdown(report)),
    writeFile(path.join(outputDir, 'account-issues.json'), `${JSON.stringify(accountIssues, null, 2)}\n`),
    writeFile(path.join(outputDir, 'data-sources.json'), `${JSON.stringify(dataSources, null, 2)}\n`),
  ]);

  console.log(JSON.stringify({
    accountId,
    publicFeedItems: publicFeed.items,
    dynamicRemarketingUy,
    processedProducts: products?.processed ?? null,
    endpointFailures: endpoints.filter(row => !row.ok).map(row => row.name),
  }));

  if (!byName.aggregateProductStatuses.ok && !byName.products.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
