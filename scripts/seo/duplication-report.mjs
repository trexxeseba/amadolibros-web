import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const R2_BASE = process.env.SEO_R2_BASE || 'https://pub-b2b408811ae24e3da04cda79c6ff084d.r2.dev';
const CATALOG_URL = process.env.SEO_CATALOG_URL || `${R2_BASE}/catalog.json`;
const MANIFEST_URL = process.env.SEO_MANIFEST_URL || `${R2_BASE}/catalog/manifest.json`;
const OUTPUT_DIR = process.env.SEO_OUTPUT_DIR || 'artifacts/seo';
const OUTPUT_DATE = process.env.SEO_OUTPUT_DATE || new Date().toISOString().slice(0, 10);

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeIsbn(value) {
  const normalized = String(value || '').toUpperCase().replace(/[^0-9X]/g, '');
  return normalized.length === 10 || normalized.length === 13 ? normalized : '';
}

function normalizeCatalogProductId(value) {
  return String(value || '').trim().toUpperCase();
}

function titleAuthorKey(item) {
  const title = normalizeText(item.title);
  const author = normalizeText(item.author);
  return title ? `${title}||${author}` : '';
}

export function classifyMlCatalogOrigin(group) {
  const items = Array.isArray(group) ? group : [];
  const rawIds = items.map((item) => normalizeCatalogProductId(item?.catalog_product_id));
  const ids = [...new Set(rawIds.filter(Boolean))].sort();
  const presentCount = rawIds.filter(Boolean).length;
  const listingValues = [...new Set(
    items
      .map((item) => typeof item?.catalog_listing === 'boolean' ? item.catalog_listing : null)
      .filter((value) => value !== null),
  )].sort();

  let origin = 'bibliographic_only';
  if (ids.length > 1) {
    origin = 'catalog_product_conflict';
  } else if (ids.length === 1) {
    if (presentCount !== items.length) {
      origin = 'catalog_product_partial';
    } else if (listingValues.includes(true) && listingValues.includes(false)) {
      origin = 'ml_common_plus_catalog';
    } else {
      origin = 'same_ml_catalog_product';
    }
  } else if (items.some((item) => item?.catalog_listing === true)) {
    origin = 'catalog_listing_without_product_id';
  }

  return {
    origin,
    catalogProductIds: ids,
    catalogListingValues: listingValues,
  };
}

export function summarizeMlOrigins(groups) {
  const summary = {
    totalGroups: 0,
    mlCommonPlusCatalogGroups: 0,
    sameMlCatalogProductGroups: 0,
    bibliographicOnlyGroups: 0,
    catalogProductPartialGroups: 0,
    catalogProductConflictGroups: 0,
    catalogListingWithoutProductIdGroups: 0,
  };

  for (const group of Array.isArray(groups) ? groups : []) {
    summary.totalGroups += 1;
    const origin = group?.mlCatalogIdentity?.origin;
    if (origin === 'ml_common_plus_catalog') summary.mlCommonPlusCatalogGroups += 1;
    else if (origin === 'same_ml_catalog_product') summary.sameMlCatalogProductGroups += 1;
    else if (origin === 'catalog_product_partial') summary.catalogProductPartialGroups += 1;
    else if (origin === 'catalog_product_conflict') summary.catalogProductConflictGroups += 1;
    else if (origin === 'catalog_listing_without_product_id') summary.catalogListingWithoutProductIdGroups += 1;
    else summary.bibliographicOnlyGroups += 1;
  }

  summary.mlIdentityExplainedGroups =
    summary.mlCommonPlusCatalogGroups + summary.sameMlCatalogProductGroups;
  summary.mlIdentityExplainedPct = summary.totalGroups > 0
    ? Math.round((summary.mlIdentityExplainedGroups / summary.totalGroups) * 10000) / 100
    : 0;
  summary.mlCommonPlusCatalogPct = summary.totalGroups > 0
    ? Math.round((summary.mlCommonPlusCatalogGroups / summary.totalGroups) * 10000) / 100
    : 0;

  return summary;
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'AmadoLibros-SEO-Baseline/1.0' } });
  if (!response.ok) throw new Error(`${url} respondió HTTP ${response.status}`);
  return response.json();
}

async function fetchMaybeGzipJson(key, fallbackKey) {
  const selectedKey = key || fallbackKey;
  if (!selectedKey) return null;
  const response = await fetch(`${R2_BASE}/${selectedKey}`, {
    headers: { 'user-agent': 'AmadoLibros-SEO-Baseline/1.0', 'accept-encoding': 'identity' },
  });
  if (!response.ok) return null;
  const bytes = Buffer.from(await response.arrayBuffer());
  if (selectedKey.endsWith('.gz')) return JSON.parse(gunzipSync(bytes).toString('utf8'));
  return JSON.parse(bytes.toString('utf8'));
}

function expandIndex(payload) {
  if (!payload || !Array.isArray(payload.fields) || !Array.isArray(payload.items)) return [];
  return payload.items.map((row) => {
    if (!Array.isArray(row)) return null;
    return Object.fromEntries(payload.fields.map((field, index) => [field, row[index] ?? null]));
  }).filter(Boolean);
}

export function buildGroups(items, keyFn, kind) {
  const buckets = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(item);
  }

  return [...buckets.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([key, group]) => {
      const isbns = [...new Set(group.map((item) => normalizeIsbn(item.isbn)).filter(Boolean))].sort();
      const titleAuthors = [...new Set(group.map(titleAuthorKey).filter(Boolean))].sort();
      let classification;
      if (kind === 'title_author') classification = isbns.length > 1 ? 'isbn_inconsistent' : 'same_book';
      else classification = titleAuthors.length > 1 ? 'isbn_inconsistent' : 'same_book';
      const mlCatalogIdentity = classifyMlCatalogOrigin(group);

      return {
        key,
        kind,
        classification,
        count: group.length,
        isbns,
        titleAuthorKeys: titleAuthors,
        mlCatalogIdentity,
        items: group.map((item) => ({
          id: item.id,
          title: item.title || null,
          author: item.author || null,
          isbn: item.isbn || null,
          status: item.status || null,
          available_quantity: Number(item.available_quantity || 0),
          condition: item.condition || null,
          catalog_listing: typeof item.catalog_listing === 'boolean' ? item.catalog_listing : null,
          catalog_product_id: item.catalog_product_id || null,
          bibliographic: item.bibliographic ? {
            edition: item.bibliographic.edition || null,
            language: item.bibliographic.language || null,
            format: item.bibliographic.format || null,
          } : null,
        })),
      };
    })
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function summarizeGroups(groups) {
  const sameBook = groups.filter((group) => group.classification === 'same_book');
  const inconsistent = groups.filter((group) => group.classification === 'isbn_inconsistent');
  return {
    duplicateGroups: groups.length,
    duplicateListings: groups.reduce((sum, group) => sum + group.count, 0),
    sameBookGroups: sameBook.length,
    isbnInconsistentGroups: inconsistent.length,
    mlCatalogOrigins: summarizeMlOrigins(groups),
    sameBookMlCatalogOrigins: summarizeMlOrigins(sameBook),
  };
}

export async function main() {
  const generatedAt = new Date().toISOString();
  const [catalog, manifest] = await Promise.all([fetchJson(CATALOG_URL), fetchJson(MANIFEST_URL)]);
  const current = manifest?.current || {};

  const [activeIndexPayload, pausedIndexPayload] = await Promise.all([
    fetchMaybeGzipJson(current.active_index_gzip_key, current.active_index_key),
    fetchMaybeGzipJson(current.index_gzip_key, current.index_key),
  ]);
  const activeIndexItems = expandIndex(activeIndexPayload);
  const pausedIndexItems = expandIndex(pausedIndexPayload);

  const catalogItems = Array.isArray(catalog?.items) ? catalog.items : [];
  const activeItems = catalogItems.filter((item) => item.status === 'active' && Number(item.available_quantity) > 0);

  const isbnGroups = buildGroups(activeItems, (item) => normalizeIsbn(item.isbn), 'isbn');
  const titleAuthorGroups = buildGroups(activeItems, titleAuthorKey, 'title_author');

  const activeCatalogIds = new Set(activeItems.map((item) => item.id).filter(Boolean));
  const activeIndexIds = new Set(activeIndexItems.map((item) => item.id).filter(Boolean));
  const onlyCatalog = [...activeCatalogIds].filter((id) => !activeIndexIds.has(id)).sort();
  const onlyIndex = [...activeIndexIds].filter((id) => !activeCatalogIds.has(id)).sort();

  const report = {
    schemaVersion: 2,
    generatedAt,
    sources: {
      catalogUrl: CATALOG_URL,
      manifestUrl: MANIFEST_URL,
      manifestVersion: current.version || null,
      activeIndexKey: current.active_index_gzip_key || current.active_index_key || null,
      pausedIndexKey: current.index_gzip_key || current.index_key || null,
    },
    inventory: {
      catalogItems: catalogItems.length,
      activeCatalogItems: activeItems.length,
      activeIndexItems: activeIndexItems.length,
      pausedIndexItems: pausedIndexItems.length,
      activeIndexParity: {
        onlyInCatalogCount: onlyCatalog.length,
        onlyInIndexCount: onlyIndex.length,
        onlyInCatalogIds: onlyCatalog,
        onlyInIndexIds: onlyIndex,
      },
    },
    methodology: {
      isbn: 'ISBN normalizado a 10/13 caracteres; grupos con 2+ listings. Mismo ISBN con más de un título+autor normalizado se marca isbn_inconsistent.',
      titleAuthor: 'Título y autor sin tildes, minúsculas, puntuación colapsada; grupos con 2+ listings. Más de un ISBN válido dentro del grupo se marca isbn_inconsistent.',
      mlCatalogIdentity: 'Clasifica el origen observable con catalog_listing + catalog_product_id: común+catálogo, mismo producto de catálogo, conflicto, parcial o sólo evidencia bibliográfica. No autoriza canonical por sí solo.',
      scope: 'Solo listings activos con available_quantity > 0 para la clasificación de duplicados; el índice R2 se usa como control de paridad y contexto de inventario.',
    },
    summaries: {
      byIsbn: summarizeGroups(isbnGroups),
      byTitleAuthor: summarizeGroups(titleAuthorGroups),
    },
    groups: {
      byIsbn: isbnGroups,
      byTitleAuthor: titleAuthorGroups,
    },
  };

  await mkdir(OUTPUT_DIR, { recursive: true });
  const outputPath = path.join(OUTPUT_DIR, `duplication-report-${OUTPUT_DATE}.json`);
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ inventory: report.inventory, summaries: report.summaries }));
  console.log(`Escrito: ${outputPath}`);
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
