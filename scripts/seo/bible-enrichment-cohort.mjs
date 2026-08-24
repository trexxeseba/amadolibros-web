#!/usr/bin/env node
// FICHAS-ENRICHMENT-BIBLIAS-1
//
// Construye la cola real de investigación por EDICIÓN (ISBN-13). No modifica
// el catálogo ni publica contenido: mide el universo activo, consolida
// duplicados y separa lo ya enriquecido de lo que requiere investigación o
// validación editorial.
//
// Uso con el catálogo público:
//   node scripts/seo/bible-enrichment-cohort.mjs
//
// Uso reproducible con una descarga local:
//   BIBLE_CATALOG_SOURCE=/tmp/catalog.json \
//     node scripts/seo/bible-enrichment-cohort.mjs

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { CATALOG_URL } from '../../functions/_shared/catalog.js';
import { listBookEnrichments } from '../../functions/_shared/book-enrichment-registry.js';
import { normalizeValidIsbn } from '../../functions/_shared/showcase-ranking.js';

const DEFAULT_CLASSIFICATIONS = 'astro-front/public/data/active-categories.json';
const DEFAULT_OUTPUT = 'artifacts/fichas-enrichment/bible-cohort-current.json';
const MIN_USEFUL_DESCRIPTION = 80;
const BIBLE_TAGS = new Set(['biblia', 'reina-valera']);

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function bestRepresentative(items) {
  return [...items].sort((a, b) => {
    const stock = (Number(b.available_quantity) || 0) - (Number(a.available_quantity) || 0);
    if (stock !== 0) return stock;
    const description = clean(b.description).length - clean(a.description).length;
    if (description !== 0) return description;
    return clean(a.id).localeCompare(clean(b.id));
  })[0];
}

export function buildBibleEnrichmentCohort({ catalogItems, classifications, enrichments }) {
  const enrichedIsbns = new Set(
    (Array.isArray(enrichments) ? enrichments : [])
      .map(record => normalizeValidIsbn(record?.isbn))
      .filter(Boolean),
  );
  const activeListings = (Array.isArray(catalogItems) ? catalogItems : []).filter(item => {
    const tags = Array.isArray(classifications?.[item?.id]) ? classifications[item.id] : [];
    return item?.status === 'active' && tags.some(tag => BIBLE_TAGS.has(tag));
  });

  const editionsByIsbn = new Map();
  for (const item of activeListings) {
    const isbn = normalizeValidIsbn(item?.isbn);
    if (!isbn) continue;
    if (!editionsByIsbn.has(isbn)) editionsByIsbn.set(isbn, []);
    editionsByIsbn.get(isbn).push(item);
  }

  const editions = [...editionsByIsbn.entries()].map(([isbn, items]) => {
    const representative = bestRepresentative(items);
    const tags = [...new Set(items.flatMap(item => classifications[item.id] || []))];
    const descriptionLength = Math.max(...items.map(item => clean(item.description).length));
    const enriched = enrichedIsbns.has(isbn);
    const status = enriched
      ? 'enriched_verified'
      : descriptionLength < MIN_USEFUL_DESCRIPTION
        ? 'research_external'
        : 'review_catalog_description';
    const stock = items.reduce((total, item) => total + (Number(item.available_quantity) || 0), 0);
    const priorityScore =
      (status === 'research_external' ? 1000 : status === 'review_catalog_description' ? 500 : 0) +
      (tags.includes('reina-valera') ? 250 : 0) +
      Math.min(stock, 100) * 5 +
      Math.min(items.length, 10) * 2;

    return {
      isbn,
      status,
      priority_score: priorityScore,
      title: clean(representative?.title),
      representative_id: clean(representative?.id),
      listing_ids: items.map(item => clean(item.id)).sort(),
      active_listings: items.length,
      total_stock: stock,
      classification_tags: tags.filter(tag => BIBLE_TAGS.has(tag)).sort(),
      description_length: descriptionLength,
      has_useful_catalog_description: descriptionLength >= MIN_USEFUL_DESCRIPTION,
    };
  }).sort((a, b) => b.priority_score - a.priority_score || a.isbn.localeCompare(b.isbn));

  const count = status => editions.filter(edition => edition.status === status).length;
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    scope: 'active Bible and Reina-Valera editions grouped by exact ISBN-13',
    metrics: {
      active_listings: activeListings.length,
      unique_isbn_editions: editions.length,
      listings_without_valid_isbn: activeListings.length - [...editionsByIsbn.values()].reduce((sum, items) => sum + items.length, 0),
      enriched_verified: count('enriched_verified'),
      research_external: count('research_external'),
      review_catalog_description: count('review_catalog_description'),
    },
    editions,
  };
}

async function readJson(source) {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`${source} respondió HTTP ${response.status}`);
    return response.json();
  }
  return JSON.parse(readFileSync(source, 'utf8'));
}

async function main() {
  const catalogSource = process.env.BIBLE_CATALOG_SOURCE || CATALOG_URL;
  const classificationsSource = process.env.BIBLE_CLASSIFICATIONS_SOURCE || DEFAULT_CLASSIFICATIONS;
  const output = process.env.BIBLE_COHORT_OUTPUT || DEFAULT_OUTPUT;
  const [catalog, classificationDocument] = await Promise.all([
    readJson(catalogSource),
    readJson(classificationsSource),
  ]);
  const report = buildBibleEnrichmentCohort({
    catalogItems: catalog?.items,
    classifications: classificationDocument?.items,
    enrichments: listBookEnrichments(),
  });

  mkdirSync(output.split('/').slice(0, -1).join('/') || '.', { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);

  console.log('── Cohorte de enriquecimiento de Biblias ──');
  for (const [key, value] of Object.entries(report.metrics)) {
    console.log(`  ${key.padEnd(34)} ${value}`);
  }
  console.log(`\nEscrito: ${output}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`bible-enrichment-cohort falló: ${error.message}`);
    process.exitCode = 1;
  });
}

