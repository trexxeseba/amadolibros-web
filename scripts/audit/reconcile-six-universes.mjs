import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  dedupeByGtinAndCondition,
  isBookProduct,
} from '../../functions/feed.xml.js';

const BASE = (process.env.AUDIT_BASE_URL || 'https://www.amadolibros.com').replace(/\/$/, '');
const RAW_CATALOG_URL = process.env.AUDIT_RAW_CATALOG_URL || 'https://pub-b2b408811ae24e3da04cda79c6ff084d.r2.dev/catalog.json';
const MERCHANT_API_ROOT = 'https://merchantapi.googleapis.com';
const MERCHANT_ACCOUNT_ID = process.env.MERCHANT_ACCOUNT_ID || '5330457716';
const ACCESS_TOKEN = process.env.MERCHANT_ACCESS_TOKEN || '';
const OUTPUT_DIR = process.env.AUDIT_OUTPUT_DIR || 'artifacts/reconcile-six-universes';
const CONCURRENCY = Math.max(1, Math.min(12, Number(process.env.AUDIT_CONCURRENCY) || 8));

function normId(value) {
  const id = String(value || '').trim().toUpperCase();
  return /^MLU\d+$/.test(id) ? id : '';
}

function setDifference(a, b) {
  return [...a].filter(value => !b.has(value)).sort();
}

function setIntersection(a, b) {
  return [...a].filter(value => b.has(value)).sort();
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function responseMeta(response) {
  return {
    status: response.status,
    date: response.headers.get('date'),
    etag: response.headers.get('etag'),
    lastModified: response.headers.get('last-modified'),
    cacheControl: response.headers.get('cache-control'),
    contentType: response.headers.get('content-type'),
    amadoFeedCoverPending: response.headers.get('x-amado-feed-cover-pending'),
  };
}

async function fetchText(url, headers = {}) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'AmadoLibros-Reconcile-0A/1.0', ...headers },
    redirect: 'follow',
    signal: AbortSignal.timeout(60_000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`${url} respondió HTTP ${response.status}`);
  return { body, meta: responseMeta(response), url: response.url };
}

async function fetchJson(url, headers = {}) {
  const result = await fetchText(url, headers);
  return { ...result, data: JSON.parse(result.body) };
}

function idsFromBookLinks(html) {
  const ids = new Set();
  for (const match of String(html || '').matchAll(/href=["']\/libro\/(MLU\d+)(?:\/|["'])/gi)) {
    const id = normId(match[1]);
    if (id) ids.add(id);
  }
  return ids;
}

function totalPagesFromCatalogHtml(html) {
  const direct = String(html || '').match(/Página\s+\d+\s+de\s+(\d+)/i);
  if (direct) return Number(direct[1]);
  let max = 1;
  for (const match of String(html || '').matchAll(/[?&]page=(\d+)/gi)) {
    max = Math.max(max, Number(match[1]) || 1);
  }
  return max;
}

async function mapConcurrent(values, mapper) {
  const results = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, values.length)) }, worker));
  return results;
}

async function fetchCatalogPublic(disponibilidad) {
  const rootPath = `/catalogo?disponibilidad=${encodeURIComponent(disponibilidad)}`;
  const first = await fetchText(`${BASE}${rootPath}`);
  const pages = totalPagesFromCatalogHtml(first.body);
  const byPage = [{ page: 1, ids: idsFromBookLinks(first.body), meta: first.meta }];
  const rest = await mapConcurrent(
    Array.from({ length: Math.max(0, pages - 1) }, (_, index) => index + 2),
    async pageNumber => {
      const url = `${BASE}/catalogo?disponibilidad=${encodeURIComponent(disponibilidad)}&page=${pageNumber}`;
      const result = await fetchText(url);
      return { page: pageNumber, ids: idsFromBookLinks(result.body), meta: result.meta };
    },
  );
  byPage.push(...rest);
  const ids = new Set();
  let linkOccurrences = 0;
  for (const page of byPage) {
    linkOccurrences += page.ids.size;
    for (const id of page.ids) ids.add(id);
  }
  return {
    ids,
    pages,
    linkOccurrences,
    firstResponse: first.meta,
  };
}

function idsFromSitemap(xml) {
  const ids = new Set();
  for (const match of String(xml || '').matchAll(/<loc>([\s\S]*?)<\/loc>/gi)) {
    const id = normId(match[1].match(/\/libro\/(MLU\d+)(?:\/|$)/i)?.[1]);
    if (id) ids.add(id);
  }
  return ids;
}

function idsFromFeed(xml) {
  const ids = new Set();
  for (const match of String(xml || '').matchAll(/<g:id>([\s\S]*?)<\/g:id>/gi)) {
    const id = normId(match[1]);
    if (id) ids.add(id);
  }
  return ids;
}

async function merchantRequestJson(url) {
  if (!ACCESS_TOKEN) throw new Error('Falta MERCHANT_ACCESS_TOKEN');
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      Accept: 'application/json',
      'user-agent': 'AmadoLibros-Reconcile-0A/1.0',
    },
    signal: AbortSignal.timeout(60_000),
  });
  const raw = await response.text();
  const data = raw ? JSON.parse(raw) : {};
  if (!response.ok) throw new Error(data?.error?.message || `Merchant HTTP ${response.status}`);
  return data;
}

async function merchantListAll(endpoint, arrayField, pageSize = 1000) {
  const rows = [];
  let pageToken = '';
  for (let page = 0; page < 30; page += 1) {
    const url = new URL(endpoint);
    url.searchParams.set('pageSize', String(pageSize));
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const data = await merchantRequestJson(url);
    if (Array.isArray(data[arrayField])) rows.push(...data[arrayField]);
    pageToken = String(data.nextPageToken || '').trim();
    if (!pageToken) return rows;
  }
  throw new Error(`Merchant excedió 30 páginas en ${arrayField}`);
}

function summarizeDataSource(source) {
  return {
    name: String(source?.name || ''),
    id: String(source?.dataSourceId || ''),
    displayName: String(source?.displayName || ''),
    input: String(source?.input || ''),
    type: source?.primaryProductDataSource ? 'primary' : 'other',
  };
}

function merchantSourceBucket(source, sourceByName) {
  const meta = sourceByName.get(String(source || '')) || {};
  const input = String(meta.input || '').toUpperCase();
  const display = String(meta.displayName || '').toUpperCase();
  if (input === 'AUTOFEED' || display === 'AMADOLIBROS.COM') return 'autofeed';
  if (input === 'FILE' || display.includes('PRODUCTS SOURCE 3')) return 'file';
  if (input === 'API' || display.includes('CONTENT API')) return 'api';
  return 'other';
}

function feedEligibilityReason(item) {
  if (!item?.id || !item?.permalink) return 'missing_id_or_permalink';
  if (!/^MLU\d+$/.test(String(item.id))) return 'invalid_id';
  if (item.status !== 'active') return 'not_active';
  if (!(Number(item.available_quantity) > 0)) return 'no_stock';
  if (!(Number(item.price) > 0)) return 'missing_or_invalid_price';
  const currency = String(item.currency || item.currency_id || '').trim().toUpperCase();
  if (currency !== 'UYU') return 'currency_not_uyu_or_missing';
  if (!isBookProduct(item)) return 'not_verified_book';
  return 'eligible_pre_dedupe';
}

function buildFeedFunnel(rawItems, feedIds) {
  const reasons = new Map();
  const eligible = [];
  for (const item of rawItems) {
    const reason = feedEligibilityReason(item);
    if (reason === 'eligible_pre_dedupe') eligible.push(item);
    else reasons.set(normId(item.id) || String(item.id || ''), reason);
  }

  const representatives = dedupeByGtinAndCondition(eligible);
  const representativeIds = new Set(representatives.map(item => normId(item.id)).filter(Boolean));
  for (const item of eligible) {
    const id = normId(item.id);
    if (!id) continue;
    if (!representativeIds.has(id)) reasons.set(id, 'duplicate_gtin_condition');
    else if (feedIds.has(id)) reasons.set(id, 'included_in_file_feed');
    else reasons.set(id, 'post_dedupe_not_in_live_feed_likely_cover_gate_or_snapshot_drift');
  }

  const counts = {};
  for (const reason of reasons.values()) counts[reason] = (counts[reason] || 0) + 1;
  const feedNotInRaw = [...feedIds].filter(id => !rawItems.some(item => normId(item.id) === id));
  return {
    rawCount: rawItems.length,
    eligiblePreDedupe: eligible.length,
    representativesAfterDedupe: representatives.length,
    liveFeedCount: feedIds.size,
    counts,
    feedNotInRaw,
    reasonById: reasons,
  };
}

function sample(values, limit = 25) {
  return values.slice(0, limit);
}

function setSummary(name, set) {
  return { name, count: set.size };
}

async function main() {
  const generatedAt = new Date().toISOString();

  const [
    rawCatalog,
    publicAvailable,
    publicOrder,
    activeSitemap,
    pausedSitemap,
    fileFeed,
  ] = await Promise.all([
    fetchJson(RAW_CATALOG_URL),
    fetchCatalogPublic('disponibles'),
    fetchCatalogPublic('encargo'),
    fetchText(`${BASE}/sitemap-books-active.xml`),
    fetchText(`${BASE}/sitemap-books-paused.xml`),
    fetchText(`${BASE}/feed.xml`),
  ]);

  const rawItems = Array.isArray(rawCatalog.data?.items) ? rawCatalog.data.items : [];
  const rawActiveIds = new Set(rawItems.map(item => normId(item.id)).filter(Boolean));
  const sitemapActiveIds = idsFromSitemap(activeSitemap.body);
  const sitemapPausedIds = idsFromSitemap(pausedSitemap.body);
  const feedIds = idsFromFeed(fileFeed.body);

  const parent = `accounts/${MERCHANT_ACCOUNT_ID}`;
  const [dataSourceRows, products] = await Promise.all([
    merchantListAll(`${MERCHANT_API_ROOT}/datasources/v1/${parent}/dataSources`, 'dataSources', 250),
    merchantListAll(`${MERCHANT_API_ROOT}/products/v1/${parent}/products`, 'products', 1000),
  ]);
  const dataSources = dataSourceRows.map(summarizeDataSource);
  const sourceByName = new Map(dataSources.map(row => [row.name, row]));
  const merchantProcessedIds = new Set();
  const merchantAutoFeedIds = new Set();
  const merchantFileIds = new Set();
  const merchantApiIds = new Set();
  const merchantOtherIds = new Set();

  for (const product of products) {
    const id = normId(product?.offerId);
    if (!id) continue;
    merchantProcessedIds.add(id);
    const bucket = merchantSourceBucket(product?.dataSource, sourceByName);
    if (bucket === 'autofeed') merchantAutoFeedIds.add(id);
    else if (bucket === 'file') merchantFileIds.add(id);
    else if (bucket === 'api') merchantApiIds.add(id);
    else merchantOtherIds.add(id);
  }

  const funnel = buildFeedFunnel(rawItems, feedIds);
  const publicAllIds = new Set([...publicAvailable.ids, ...publicOrder.ids]);
  const union = new Set([
    ...rawActiveIds,
    ...publicAllIds,
    ...sitemapActiveIds,
    ...sitemapPausedIds,
    ...feedIds,
    ...merchantProcessedIds,
  ]);

  const rows = [...union].sort().map(id => ({
    id,
    raw_active: rawActiveIds.has(id) ? 1 : 0,
    public_available: publicAvailable.ids.has(id) ? 1 : 0,
    public_by_request: publicOrder.ids.has(id) ? 1 : 0,
    sitemap_active: sitemapActiveIds.has(id) ? 1 : 0,
    sitemap_by_request: sitemapPausedIds.has(id) ? 1 : 0,
    file_feed: feedIds.has(id) ? 1 : 0,
    merchant_autofeed: merchantAutoFeedIds.has(id) ? 1 : 0,
    merchant_file: merchantFileIds.has(id) ? 1 : 0,
    merchant_api: merchantApiIds.has(id) ? 1 : 0,
    merchant_processed: merchantProcessedIds.has(id) ? 1 : 0,
    feed_funnel_reason: funnel.reasonById.get(id) || '',
  }));

  const comparisons = {
    publicAvailable_missingFromSitemapActive: setDifference(publicAvailable.ids, sitemapActiveIds),
    sitemapActive_missingFromPublicAvailable: setDifference(sitemapActiveIds, publicAvailable.ids),
    publicByRequest_inCohort: setIntersection(publicOrder.ids, sitemapPausedIds),
    publicByRequest_outsideCohort: setDifference(publicOrder.ids, sitemapPausedIds),
    cohort_missingFromPublicByRequest: setDifference(sitemapPausedIds, publicOrder.ids),
    fileFeed_missingFromMerchantFile: setDifference(feedIds, merchantFileIds),
    merchantFile_missingFromLiveFeed: setDifference(merchantFileIds, feedIds),
    autoFeed_fileOverlap: setIntersection(merchantAutoFeedIds, merchantFileIds),
    autoFeedOnly: setDifference(merchantAutoFeedIds, merchantFileIds),
    fileOnly: setDifference(merchantFileIds, merchantAutoFeedIds),
    merchantProcessedOutsideRawActive: setDifference(merchantProcessedIds, rawActiveIds),
  };

  const report = {
    schemaVersion: 1,
    generatedAt,
    sourceSnapshots: {
      rawCatalog: { url: RAW_CATALOG_URL, updatedAt: rawCatalog.data?.updated_at || rawCatalog.data?.generated_at || null, response: rawCatalog.meta },
      publicCatalogAvailable: { pages: publicAvailable.pages, response: publicAvailable.firstResponse },
      publicCatalogByRequest: { pages: publicOrder.pages, response: publicOrder.firstResponse },
      sitemapActive: { url: `${BASE}/sitemap-books-active.xml`, response: activeSitemap.meta },
      sitemapByRequest: { url: `${BASE}/sitemap-books-paused.xml`, response: pausedSitemap.meta },
      fileFeed: { url: `${BASE}/feed.xml`, response: fileFeed.meta },
      merchant: { accountId: MERCHANT_ACCOUNT_ID, processedRows: products.length },
    },
    universes: [
      setSummary('raw_active_catalog', rawActiveIds),
      setSummary('public_catalog_available', publicAvailable.ids),
      setSummary('public_catalog_by_request', publicOrder.ids),
      setSummary('sitemap_active', sitemapActiveIds),
      setSummary('sitemap_by_request', sitemapPausedIds),
      setSummary('file_feed', feedIds),
      setSummary('merchant_autofeed', merchantAutoFeedIds),
      setSummary('merchant_file', merchantFileIds),
      setSummary('merchant_api', merchantApiIds),
      setSummary('merchant_processed_unique_offer_ids', merchantProcessedIds),
    ],
    merchantDataSources: dataSources,
    feedFunnel: {
      rawCount: funnel.rawCount,
      eligiblePreDedupe: funnel.eligiblePreDedupe,
      representativesAfterDedupe: funnel.representativesAfterDedupe,
      liveFeedCount: funnel.liveFeedCount,
      counts: funnel.counts,
      feedNotInRawCount: funnel.feedNotInRaw.length,
      feedNotInRawExamples: sample(funnel.feedNotInRaw),
    },
    comparisons: Object.fromEntries(Object.entries(comparisons).map(([key, values]) => [key, {
      count: values.length,
      examples: sample(values),
    }])),
  };

  const markdown = [
    '# Auditoría 0A — reconciliación de universos por ID',
    '',
    `Generado: ${generatedAt}`,
    '',
    '## Universos',
    '',
    '| Universo | IDs únicos |',
    '| --- | ---: |',
    ...report.universes.map(row => `| ${row.name} | ${row.count} |`),
    '',
    '## Funnel catálogo activo → FILE',
    '',
    `- Catálogo activo bruto: ${funnel.rawCount}`,
    `- Elegibles antes de dedupe: ${funnel.eligiblePreDedupe}`,
    `- Representantes después de GTIN+condition: ${funnel.representativesAfterDedupe}`,
    `- Feed live: ${funnel.liveFeedCount}`,
    '',
    '| Causa | Cantidad |',
    '| --- | ---: |',
    ...Object.entries(funnel.counts).sort((a, b) => b[1] - a[1]).map(([reason, count]) => `| ${reason} | ${count} |`),
    '',
    '## Cruces clave',
    '',
    ...Object.entries(report.comparisons).map(([key, value]) => `- ${key}: **${value.count}**${value.examples.length ? ` — ejemplos: ${value.examples.slice(0, 8).join(', ')}` : ''}`),
    '',
    '## Fuentes Merchant',
    '',
    '| Nombre | Input | ID |',
    '| --- | --- | --- |',
    ...dataSources.map(row => `| ${row.displayName || row.name} | ${row.input || '—'} | ${row.id || '—'} |`),
    '',
    'Esta auditoría es de sólo lectura. No modifica catálogo, Merchant ni producción.',
    '',
  ].join('\n');

  const csvColumns = Object.keys(rows[0] || { id: '' });
  const csv = [
    csvColumns.join(','),
    ...rows.map(row => csvColumns.map(column => csvEscape(row[column])).join(',')),
  ].join('\n') + '\n';

  await mkdir(OUTPUT_DIR, { recursive: true });
  await Promise.all([
    writeFile(path.join(OUTPUT_DIR, 'reconcile-summary.json'), JSON.stringify(report, null, 2) + '\n'),
    writeFile(path.join(OUTPUT_DIR, 'reconcile-by-id.csv'), csv),
    writeFile(path.join(OUTPUT_DIR, 'report-summary.md'), markdown),
  ]);

  console.log(markdown);
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
