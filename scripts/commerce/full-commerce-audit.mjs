import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectCoverBytes } from '../../worker-sync/cover-mirror.js';
import { isBookProduct } from '../../functions/feed.xml.js';

const DEFAULT_BASE_URL = 'https://www.amadolibros.com';
const DEFAULT_CATALOG_URL = 'https://pub-b2b408811ae24e3da04cda79c6ff084d.r2.dev/catalog.json';
const MERCHANT_MIN_500_ENFORCEMENT_DATE = Date.parse('2027-01-31T00:00:00Z');

function text(value) {
  return String(value || '').trim();
}

function decodeXml(value) {
  return text(value)
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'").replaceAll('&amp;', '&');
}

function tag(block, name) {
  const match = block.match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return match ? decodeXml(match[1]) : '';
}

export function parseMerchantFeed(xml) {
  return [...String(xml || '').matchAll(/<item>([\s\S]*?)<\/item>/gi)].map(match => ({
    id: tag(match[1], 'g:id'),
    title: tag(match[1], 'g:title'),
    description: tag(match[1], 'g:description'),
    link: tag(match[1], 'g:link'),
    image_link: tag(match[1], 'g:image_link'),
    availability: tag(match[1], 'g:availability'),
    price: tag(match[1], 'g:price'),
    condition: tag(match[1], 'g:condition'),
    gtin: tag(match[1], 'g:gtin'),
  }));
}

function parsePrice(value) {
  const match = text(value).match(/^([0-9]+(?:\.[0-9]+)?)\s+([A-Z]{3})$/);
  return match ? { amount: Number(match[1]), currency: match[2] } : null;
}

function issue(severity, code, message, details = {}) {
  return { severity, code, message, ...details };
}

export function auditFeed(catalog, feedItems, { canonicalHost = 'www.amadolibros.com' } = {}) {
  const catalogItems = Array.isArray(catalog?.items) ? catalog.items : [];
  const byId = new Map(catalogItems.map(item => [String(item.id), item]));
  const issues = [];
  const seen = new Set();

  for (const row of feedItems) {
    if (!row.id || seen.has(row.id)) {
      issues.push(issue('critical', 'FEED_ID_DUPLICATE_OR_EMPTY', 'ID vacío o duplicado en el feed.', { id: row.id || null }));
    }
    seen.add(row.id);
    const source = byId.get(row.id);
    if (!source) {
      issues.push(issue('critical', 'FEED_ID_NOT_IN_CATALOG', 'Oferta ausente del catálogo vivo.', { id: row.id }));
      continue;
    }
    if (source.status !== 'active' || !(Number(source.available_quantity) > 0)) {
      issues.push(issue('critical', 'FEED_STOCK_MISMATCH', 'Oferta no activa o sin stock en el catálogo.', { id: row.id }));
    }
    if (!isBookProduct(source)) {
      issues.push(issue('critical', 'FEED_NON_BOOK', 'Producto sin identidad bibliográfica enviado como libro.', { id: row.id, title: row.title }));
    }
    const price = parsePrice(row.price);
    if (!price || price.currency !== 'UYU') {
      issues.push(issue('critical', 'FEED_PRICE_INVALID', 'Precio o moneda inválidos.', { id: row.id, price: row.price }));
    } else if (price.amount !== Number(source.price)) {
      issues.push(issue('critical', 'FEED_PRICE_MISMATCH', 'Precio del feed distinto al catálogo.', {
        id: row.id, feed_price: price.amount, catalog_price: Number(source.price),
      }));
    }
    const explicitCurrency = text(source.currency || source.currency_id).toUpperCase();
    if (explicitCurrency && explicitCurrency !== 'UYU') {
      issues.push(issue('critical', 'CATALOG_CURRENCY_MISMATCH', 'Producto con moneda de origen distinta de UYU.', { id: row.id, currency: explicitCurrency }));
    }
    for (const [field, raw] of [['link', row.link], ['image_link', row.image_link]]) {
      try {
        const url = new URL(raw);
        if (url.protocol !== 'https:' || url.hostname !== canonicalHost) {
          issues.push(issue('critical', `FEED_${field.toUpperCase()}_EXTERNAL`, `${field} no está bajo dominio propio HTTPS.`, { id: row.id, url: raw }));
        }
      } catch {
        issues.push(issue('critical', `FEED_${field.toUpperCase()}_INVALID`, `${field} inválido.`, { id: row.id, url: raw }));
      }
    }
    if (row.title.length > 150 || !row.title) {
      issues.push(issue('warning', 'FEED_TITLE_LENGTH', 'Título vacío o mayor a 150 caracteres.', { id: row.id, length: row.title.length }));
    }
    if (!row.description) {
      issues.push(issue('warning', 'FEED_DESCRIPTION_EMPTY', 'Descripción vacía.', { id: row.id }));
    }
  }

  return {
    catalog_items: catalogItems.length,
    feed_items: feedItems.length,
    unique_feed_ids: seen.size,
    critical: issues.filter(row => row.severity === 'critical').length,
    warnings: issues.filter(row => row.severity === 'warning').length,
    issues,
  };
}

export function auditCatalogSafety(catalog) {
  const items = Array.isArray(catalog?.items) ? catalog.items : [];
  const issues = [];
  for (const item of items) {
    if (item?.status !== 'active' || !(Number(item.available_quantity) > 0)) continue;
    const currency = text(item.currency || item.currency_id).toUpperCase();
    if (currency && currency !== 'UYU') {
      issues.push(issue('warning', 'CATALOG_NON_UYU_REVIEW', 'Publicación activa fuera del checkout UYU.', {
        id: item.id, title: item.title, currency,
      }));
    } else if (!currency) {
      issues.push(issue('warning', 'CATALOG_CURRENCY_LEGACY', 'Publicación sin moneda explícita; se mantiene compatibilidad UYU hasta el próximo sync.', {
        id: item.id, title: item.title,
      }));
    }
    if (!(Number(item.price) > 0)) {
      issues.push(issue('critical', 'CATALOG_PRICE_INVALID', 'Publicación activa con precio inválido.', {
        id: item.id, price: item.price,
      }));
    }
  }
  return {
    items: items.length,
    active_non_uyu: issues.filter(row => row.code === 'CATALOG_NON_UYU_REVIEW').length,
    missing_currency: issues.filter(row => row.code === 'CATALOG_CURRENCY_LEGACY').length,
    critical: issues.filter(row => row.severity === 'critical').length,
    warnings: issues.filter(row => row.severity === 'warning').length,
    issues,
  };
}

export function stableSample(items, limit) {
  if (!Number(limit) || Number(limit) >= items.length) return [...items];
  const count = Math.max(1, Math.floor(Number(limit)));
  return Array.from({ length: count }, (_, index) => items[Math.floor(index * items.length / count)]);
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, worker));
  return results;
}

async function fetchWithRetries(url, { attempts = 3, timeoutMs = 25_000, headers = {} } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
      if (response.status >= 500 && attempt < attempts) continue;
      return response;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Fallo de red.');
}

export async function auditImages(feedItems, { limit = 0, concurrency = 12 } = {}) {
  const selected = stableSample(feedItems, limit);
  const rows = await mapWithConcurrency(selected, concurrency, async item => {
    try {
      const response = await fetchWithRetries(item.image_link, {
        headers: { 'user-agent': 'AmadoLibros-Full-Commerce-Audit/1.0', accept: 'image/*' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const image = inspectCoverBytes(bytes, response.headers.get('content-type'));
      return {
        id: item.id, ok: true, status: response.status,
        source: response.headers.get('x-cover-source') || 'unknown',
        width: image.width, height: image.height, bytes: bytes.byteLength,
        meets_500: image.width >= 500 && image.height >= 500,
        meets_1024: image.width >= 1024 && image.height >= 1024,
      };
    } catch (error) {
      return { id: item.id, ok: false, error: String(error?.message || error) };
    }
  });
  const valid = rows.filter(row => row.ok);
  return {
    inspected: rows.length,
    valid: valid.length,
    failed: rows.length - valid.length,
    meets_500: valid.filter(row => row.meets_500).length,
    below_500: valid.filter(row => !row.meets_500).length,
    meets_1024: valid.filter(row => row.meets_1024).length,
    sources: Object.fromEntries([...new Set(valid.map(row => row.source))].map(source => [source, valid.filter(row => row.source === source).length])),
    failures: rows.filter(row => !row.ok).slice(0, 100),
    low_resolution_examples: valid.filter(row => !row.meets_500).slice(0, 100),
  };
}

function locs(xml) {
  return [...String(xml || '').matchAll(/<loc>([\s\S]*?)<\/loc>/gi)].map(match => decodeXml(match[1]));
}

export async function fetchSitemapUrls(baseUrl) {
  const root = new URL('/sitemap.xml', baseUrl).toString();
  const response = await fetchWithRetries(root);
  if (!response.ok) throw new Error(`sitemap.xml respondió HTTP ${response.status}`);
  const xml = await response.text();
  const rootLocs = locs(xml);
  if (!/<sitemapindex\b/i.test(xml)) return rootLocs;
  const children = await mapWithConcurrency(rootLocs, 8, async sitemapUrl => {
    const childUrl = new URL(new URL(sitemapUrl).pathname, baseUrl).toString();
    const child = await fetchWithRetries(childUrl);
    if (!child.ok) throw new Error(`${childUrl} respondió HTTP ${child.status}`);
    return locs(await child.text());
  });
  return [...new Set(children.flat())];
}

function htmlValue(html, regex) {
  return decodeXml(html.match(regex)?.[1] || '');
}

export function inspectProductHtml(html, requestedUrl, { expectIndexable = true } = {}) {
  const robots = htmlValue(html, /<meta[^>]+name=["']robots["'][^>]+content=["']([^"']+)/i);
  const canonical = htmlValue(html, /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)/i);
  const titleValue = htmlValue(html, /<title>([\s\S]*?)<\/title>/i);
  const h1 = htmlValue(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i).replace(/<[^>]+>/g, '').trim();
  const productSchema = /"@type"\s*:\s*(?:"(?:Product|Book)"|\[[^\]]*"(?:Product|Book)")/i.test(html);
  const noindex = /\bnoindex\b/i.test(robots);
  const issues = [];
  if (expectIndexable && noindex) issues.push('NOINDEX_LIVE');
  if (!expectIndexable && !noindex) issues.push('PREVIEW_INDEXABLE');
  if (!canonical) issues.push('CANONICAL_MISSING');
  if (!titleValue) issues.push('TITLE_MISSING');
  if (!h1) issues.push('H1_MISSING');
  if (!productSchema) issues.push('PRODUCT_SCHEMA_MISSING');
  let canonicalMatches = false;
  try { canonicalMatches = new URL(canonical).pathname === new URL(requestedUrl).pathname; } catch {}
  if (canonical && !canonicalMatches) issues.push('CANONICAL_PATH_MISMATCH');
  return { robots, canonical, title: titleValue, h1, product_schema: productSchema, issues };
}

export async function auditPages(urls, baseUrl, { limit = 0, concurrency = 12, expectIndexable = true } = {}) {
  const bookUrls = urls.filter(url => {
    try { return new URL(url).pathname.startsWith('/libro/'); } catch { return false; }
  });
  const selected = stableSample(bookUrls.sort(), limit);
  const rows = await mapWithConcurrency(selected, concurrency, async originalUrl => {
    const target = new URL(new URL(originalUrl).pathname, baseUrl).toString();
    try {
      const response = await fetchWithRetries(target, { headers: { 'user-agent': 'AmadoLibros-Full-Commerce-Audit/1.0' } });
      const html = await response.text();
      const inspection = inspectProductHtml(html, target, { expectIndexable });
      const issues = [];
      if (response.status !== 200) issues.push(`HTTP_${response.status}`);
      issues.push(...inspection.issues);
      return { url: target, status: response.status, ok: issues.length === 0, issues, ...inspection };
    } catch (error) {
      return { url: target, status: null, ok: false, issues: ['NETWORK_ERROR'], error: String(error?.message || error) };
    }
  });
  return {
    sitemap_book_urls: bookUrls.length,
    inspected: rows.length,
    passed: rows.filter(row => row.ok).length,
    failed: rows.filter(row => !row.ok).length,
    failures: rows.filter(row => !row.ok).slice(0, 200),
  };
}

export async function runFullCommerceAudit({
  baseUrl = DEFAULT_BASE_URL,
  catalogUrl = DEFAULT_CATALOG_URL,
  imageLimit = 0,
  pageLimit = 0,
  concurrency = 12,
  expectIndexable = true,
} = {}) {
  const startedAt = new Date().toISOString();
  const [catalogResponse, feedResponse, sitemapUrls] = await Promise.all([
    fetchWithRetries(catalogUrl),
    fetchWithRetries(new URL('/feed.xml', baseUrl).toString()),
    fetchSitemapUrls(baseUrl),
  ]);
  if (!catalogResponse.ok) throw new Error(`Catálogo respondió HTTP ${catalogResponse.status}`);
  if (!feedResponse.ok) throw new Error(`Feed respondió HTTP ${feedResponse.status}`);
  const catalog = await catalogResponse.json();
  const feedItems = parseMerchantFeed(await feedResponse.text());
  const [images, pages] = await Promise.all([
    auditImages(feedItems, { limit: imageLimit, concurrency }),
    auditPages(sitemapUrls, baseUrl, { limit: pageLimit, concurrency, expectIndexable }),
  ]);
  const feed = auditFeed(catalog, feedItems);
  const catalogSafety = auditCatalogSafety(catalog);
  const min500Enforced = Date.now() >= MERCHANT_MIN_500_ENFORCEMENT_DATE;
  images.minimum_500_enforced = min500Enforced;
  images.resolution_critical = min500Enforced ? images.below_500 : 0;
  const critical = catalogSafety.critical + feed.critical + images.failed +
    images.resolution_critical + pages.failed;
  return {
    schema_version: 1,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    scope: { base_url: baseUrl, catalog_url: catalogUrl, image_limit: imageLimit, page_limit: pageLimit, expect_indexable: expectIndexable },
    live_status_only: true,
    note: 'Los estados históricos de GSC no se clasifican como fallas vivas.',
    result: critical === 0 ? 'pass' : 'fail',
    critical,
    catalog: catalogSafety,
    feed,
    images,
    pages,
  };
}

async function main() {
  const outputDir = process.env.COMMERCE_OUTPUT_DIR || 'artifacts/commerce';
  const report = await runFullCommerceAudit({
    baseUrl: process.env.COMMERCE_BASE_URL || DEFAULT_BASE_URL,
    catalogUrl: process.env.CATALOG_URL || DEFAULT_CATALOG_URL,
    imageLimit: Number(process.env.COMMERCE_IMAGE_LIMIT || 0),
    pageLimit: Number(process.env.COMMERCE_PAGE_LIMIT || 0),
    concurrency: Number(process.env.COMMERCE_CONCURRENCY || 12),
    expectIndexable: process.env.COMMERCE_EXPECT_INDEXABLE !== 'false',
  });
  await mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `full-commerce-audit-${new Date().toISOString().slice(0, 10)}.json`);
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    result: report.result,
    critical: report.critical,
    feed: {
      catalog_items: report.feed.catalog_items,
      feed_items: report.feed.feed_items,
      critical: report.feed.critical,
      warnings: report.feed.warnings,
    },
    catalog: {
      items: report.catalog.items,
      active_non_uyu: report.catalog.active_non_uyu,
      missing_currency: report.catalog.missing_currency,
      critical: report.catalog.critical,
    },
    images: {
      inspected: report.images.inspected,
      valid: report.images.valid,
      failed: report.images.failed,
      meets_500: report.images.meets_500,
      below_500: report.images.below_500,
      sources: report.images.sources,
    },
    pages: {
      sitemap_book_urls: report.pages.sitemap_book_urls,
      inspected: report.pages.inspected,
      passed: report.pages.passed,
      failed: report.pages.failed,
    },
  }, null, 2));
  console.log(`Escrito: ${outputPath}`);
  if (process.env.COMMERCE_FAIL_ON_CRITICAL === 'true' && report.critical > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
