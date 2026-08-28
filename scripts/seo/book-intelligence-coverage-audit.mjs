#!/usr/bin/env node

// B11: mide el catálogo activo completo. Separa publicaciones MLU de
// ediciones únicas por ISBN para que el avance editorial no mezcle unidades.

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { CATALOG_URL } from '../../functions/_shared/catalog.js';
import { listBookEnrichments } from '../../functions/_shared/book-enrichment-registry.js';
import { normalizeValidIsbn } from '../../functions/_shared/showcase-ranking.js';

function activeAndSellable(item) {
  return item?.status === 'active' && Number(item?.available_quantity) > 0;
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

async function main() {
  const source = process.env.BOOK_ENRICHMENT_CATALOG_SOURCE || CATALOG_URL;
  const response = await fetch(source, {
    headers: { 'user-agent': 'AmadoLibros-B11-Coverage/1.0' },
  });
  if (!response.ok) throw new Error(`catalog.json respondió HTTP ${response.status}.`);
  const report = auditBookEnrichmentCoverage(await response.json(), { source });
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error(`[b11-coverage] ERROR: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
