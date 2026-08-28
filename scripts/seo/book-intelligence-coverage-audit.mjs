#!/usr/bin/env node

// B11: mide el catálogo activo completo. Separa publicaciones MLU de
// ediciones únicas por ISBN para que el avance editorial no mezcle unidades.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { CATALOG_URL, PRODUCTION_MANIFEST_URL, R2_BASE } from '../../functions/_shared/catalog.js';
import { listBookEnrichments } from '../../functions/_shared/book-enrichment-registry.js';
import { normalizeValidIsbn } from '../../functions/_shared/showcase-ranking.js';

function activeAndSellable(item) {
  return item?.status === 'active' && Number(item?.available_quantity) > 0;
}

export function expandCompactIndex(payload) {
  if (!payload || !Array.isArray(payload.fields) || !Array.isArray(payload.items)) return [];
  const derived = payload.derived_fields && typeof payload.derived_fields === 'object'
    ? payload.derived_fields
    : {};
  return payload.items.map(row => {
    if (!Array.isArray(row)) return null;
    return {
      ...derived,
      ...Object.fromEntries(payload.fields.map((field, index) => [field, row[index] ?? null])),
    };
  }).filter(Boolean);
}

export function auditBookEnrichmentCoverage(catalog, {
  enrichedIsbns = listBookEnrichments().map(entry => entry.isbn),
  generatedAt = new Date().toISOString(),
  source = null,
} = {}) {
  if (!catalog || !Array.isArray(catalog.items)) {
    throw new Error('catalog.json inválido: falta items[].');
  }

  const active = catalog.items.filter(activeAndSellable);
  const registry = new Set(enrichedIsbns.map(normalizeValidIsbn).filter(Boolean));
  const listingsByIsbn = new Map();
  const withoutValidIsbn = [];

  for (const item of active) {
    const isbn = normalizeValidIsbn(item?.isbn);
    if (!isbn) {
      withoutValidIsbn.push(item);
      continue;
    }
    if (!listingsByIsbn.has(isbn)) listingsByIsbn.set(isbn, []);
    listingsByIsbn.get(isbn).push(item);
  }

  const activeIsbns = [...listingsByIsbn.keys()];
  const enrichedActiveIsbns = activeIsbns.filter(isbn => registry.has(isbn));
  const pendingActiveIsbns = activeIsbns.filter(isbn => !registry.has(isbn));
  const listingsWithValidIsbn = [...listingsByIsbn.values()].reduce((total, listings) => total + listings.length, 0);
  const enrichedListings = enrichedActiveIsbns.reduce(
    (total, isbn) => total + listingsByIsbn.get(isbn).length,
    0,
  );

  return {
    schema_version: 1,
    generated_at: generatedAt,
    source,
    catalog_updated_at: catalog.updated_at || null,
    inventory: {
      catalog_listings: catalog.items.length,
      active_sellable_listings: active.length,
      active_listings_with_valid_isbn: listingsWithValidIsbn,
      active_listings_without_valid_isbn: withoutValidIsbn.length,
      active_unique_valid_isbns: activeIsbns.length,
      duplicate_active_listings_over_unique_isbn: listingsWithValidIsbn - activeIsbns.length,
    },
    coverage: {
      registry_unique_isbns: registry.size,
      active_enriched_unique_isbns: enrichedActiveIsbns.length,
      active_pending_unique_isbns: pendingActiveIsbns.length,
      active_enriched_listings: enrichedListings,
      active_pending_listings_with_valid_isbn: listingsWithValidIsbn - enrichedListings,
      active_listings_pending_identity_classification: withoutValidIsbn.length,
      registry_isbns_without_active_listing: [...registry].filter(isbn => !listingsByIsbn.has(isbn)).length,
    },
    complete: pendingActiveIsbns.length === 0 && withoutValidIsbn.length === 0,
  };
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'AmadoLibros-B11-Coverage/1.0' },
  });
  if (!response.ok) throw new Error(`${url} respondió HTTP ${response.status}.`);
  return response.json();
}

async function fetchActiveIndex(current) {
  const selectedKey = current?.active_index_gzip_key || current?.active_index_key;
  if (!selectedKey) throw new Error('El manifest productivo no declara active_index.');
  const response = await fetch(`${R2_BASE}/${selectedKey}`, {
    headers: {
      'user-agent': 'AmadoLibros-B11-Coverage/1.0',
      'accept-encoding': 'identity',
    },
  });
  if (!response.ok) throw new Error(`active-index respondió HTTP ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const payload = selectedKey.endsWith('.gz')
    ? JSON.parse(gunzipSync(bytes).toString('utf8'))
    : JSON.parse(bytes.toString('utf8'));
  return { key: selectedKey, payload };
}

async function main() {
  const catalogSource = process.env.BOOK_ENRICHMENT_CATALOG_SOURCE || CATALOG_URL;
  const manifestSource = process.env.BOOK_ENRICHMENT_MANIFEST_SOURCE || PRODUCTION_MANIFEST_URL;
  const [catalog, manifest] = await Promise.all([
    fetchJson(catalogSource),
    fetchJson(manifestSource),
  ]);
  const activeIndex = await fetchActiveIndex(manifest?.current);
  const activeIndexItems = expandCompactIndex(activeIndex.payload);
  const catalogActive = Array.isArray(catalog?.items) ? catalog.items.filter(activeAndSellable) : [];
  const report = auditBookEnrichmentCoverage({
    updated_at: manifest?.checked_at || catalog?.updated_at || null,
    items: activeIndexItems,
  }, { source: `${R2_BASE}/${activeIndex.key}` });
  report.sources = {
    catalog: catalogSource,
    manifest: manifestSource,
    active_index: `${R2_BASE}/${activeIndex.key}`,
  };
  report.inventory.catalog_json_active_sellable_listings = catalogActive.length;
  report.inventory.active_index_minus_catalog_json = activeIndexItems.length - catalogActive.length;
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error(`[b11-coverage] ERROR: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
