#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { normalizeIsbnToGtin } from '../../functions/feed.xml.js';

const DEFAULT_LIMIT = 3000;
const BOOK_DOMAIN = 'MLU-BOOKS';
const KNOWN_LANGUAGES = new Set([
  'aleman',
  'castellano',
  'espanol',
  'frances',
  'ingles',
  'italiano',
  'portugues',
]);
const KNOWN_FORMATS = new Set([
  'bolsillo',
  'cartone',
  'papel',
  'rustica',
  'tapa blanda',
  'tapa dura',
]);
const BAD_AUTHORS = new Set([
  'autor',
  'autor a',
  'desconocido',
  'n a',
  'no aplica',
  'sin autor',
  'unknown',
]);

export function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isbn13(item) {
  return normalizeIsbnToGtin(item?.isbn).gtin || '';
}

function imageCount(item) {
  return [
    ...(Array.isArray(item?.pictures) ? item.pictures : []),
    item?.thumbnail,
  ].filter(value => /^https?:\/\//i.test(String(value || ''))).length;
}

function validTitle(item) {
  const title = String(item?.title || '').trim();
  const letters = title.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g)?.length || 0;
  return title.length >= 10 && title.length <= 180 && letters >= 7 && !title.includes('\uFFFD');
}

function validAuthor(item) {
  const author = String(item?.author || '').trim();
  const normalized = normalizeText(author);
  const letters = author.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g)?.length || 0;
  const digits = author.match(/\d/g)?.length || 0;
  return author.length >= 4 &&
    author.length <= 120 &&
    letters >= 4 &&
    digits <= 2 &&
    !BAD_AUTHORS.has(normalized);
}

function validPublicationYear(value) {
  const year = Number(String(value || '').trim());
  return Number.isInteger(year) && year >= 1500 && year <= 2027;
}

function evidence(item) {
  const bibliographic = item?.bibliographic && typeof item.bibliographic === 'object'
    ? item.bibliographic
    : {};
  return {
    images: imageCount(item),
    catalogProduct: Boolean(String(item?.catalog_product_id || '').trim()),
    catalogListing: item?.catalog_listing === true,
    language: KNOWN_LANGUAGES.has(normalizeText(bibliographic.language)),
    format: KNOWN_FORMATS.has(normalizeText(bibliographic.format)),
    publicationYear: validPublicationYear(bibliographic.publication_year),
    conciseTitle: String(item?.title || '').trim().length <= 120,
  };
}

function qualityScore(item) {
  const current = evidence(item);
  return Math.min(current.images, 4) * 4 +
    (current.catalogProduct ? 10 : 0) +
    (current.catalogListing ? 4 : 0) +
    (current.language ? 5 : 0) +
    (current.format ? 3 : 0) +
    (current.publicationYear ? 5 : 0) +
    (current.conciseTitle ? 4 : 0);
}

function qualityFillEligible(item) {
  const current = evidence(item);
  return current.images >= 2 &&
    current.catalogProduct &&
    current.language &&
    current.publicationYear;
}

function productIdFromPage(value) {
  return String(value || '').match(/\/libro\/(MLU\d+)/i)?.[1]?.toUpperCase() || null;
}

function demandByProductId(gscRows = []) {
  const demand = new Map();
  for (const row of gscRows) {
    const id = productIdFromPage(row?.keys?.[0]);
    if (!id) continue;
    const candidate = {
      clicks: Number(row.clicks) || 0,
      impressions: Number(row.impressions) || 0,
      position: Number(row.position) || null,
    };
    const current = demand.get(id);
    if (!current || candidate.impressions > current.impressions) demand.set(id, candidate);
  }
  return demand;
}

function compareRepresentative(a, b) {
  return b.demand.impressions - a.demand.impressions ||
    b.demand.clicks - a.demand.clicks ||
    b.qualityScore - a.qualityScore ||
    a.item.id.localeCompare(b.item.id);
}

function compareSelection(a, b) {
  return Number(b.demand.impressions > 0) - Number(a.demand.impressions > 0) ||
    b.demand.impressions - a.demand.impressions ||
    b.demand.clicks - a.demand.clicks ||
    b.qualityScore - a.qualityScore ||
    a.item.id.localeCompare(b.item.id);
}

export function selectPausedSeoCohort({ catalogItems = [], gscRows = [], limit = DEFAULT_LIMIT } = {}) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('limit debe ser un entero positivo.');

  const active = catalogItems.filter(item => item?.status === 'active' && Number(item.available_quantity) > 0);
  const activeIsbns = new Set(active.map(isbn13).filter(Boolean));
  const activeCatalogProductIds = new Set(
    active.map(item => String(item.catalog_product_id || '').trim()).filter(Boolean),
  );
  const demand = demandByProductId(gscRows);
  const rejectionCounts = {
    activeEquivalent: 0,
    author: 0,
    domain: 0,
    image: 0,
    isbn: 0,
    title: 0,
  };

  const eligible = [];
  for (const item of catalogItems) {
    if (item?.status !== 'paused') continue;
    if (item.domain_id !== BOOK_DOMAIN) {
      rejectionCounts.domain++;
      continue;
    }
    if (!validTitle(item)) {
      rejectionCounts.title++;
      continue;
    }
    if (!validAuthor(item)) {
      rejectionCounts.author++;
      continue;
    }
    const normalizedIsbn = isbn13(item);
    if (!normalizedIsbn) {
      rejectionCounts.isbn++;
      continue;
    }
    if (imageCount(item) === 0) {
      rejectionCounts.image++;
      continue;
    }
    const catalogProductId = String(item.catalog_product_id || '').trim();
    if (activeIsbns.has(normalizedIsbn) ||
        (catalogProductId && activeCatalogProductIds.has(catalogProductId))) {
      rejectionCounts.activeEquivalent++;
      continue;
    }
    eligible.push({
      item,
      isbn: normalizedIsbn,
      demand: demand.get(item.id) || { clicks: 0, impressions: 0, position: null },
      qualityScore: qualityScore(item),
      qualityFillEligible: qualityFillEligible(item),
    });
  }

  // Una sola URL por ISBN. Si Google ya conoce una de las publicaciones,
  // conserva esa URL; si no, usa la ficha con mejores señales bibliográficas.
  const representativesByIsbn = new Map();
  for (const candidate of eligible) {
    const group = representativesByIsbn.get(candidate.isbn) || [];
    group.push(candidate);
    representativesByIsbn.set(candidate.isbn, group);
  }
  const representatives = [...representativesByIsbn.values()]
    .map(group => group.sort(compareRepresentative)[0]);
  const historical = representatives
    .filter(candidate => candidate.demand.impressions > 0)
    .sort(compareSelection);
  const qualityFill = representatives
    .filter(candidate => candidate.demand.impressions === 0 && candidate.qualityFillEligible)
    .sort(compareSelection);
  const fallback = representatives
    .filter(candidate => candidate.demand.impressions === 0 && !candidate.qualityFillEligible)
    .sort(compareSelection);
  const selected = [...historical, ...qualityFill, ...fallback].slice(0, limit);

  if (selected.length !== limit) {
    throw new Error(`La cohorte quedó en ${selected.length}; se esperaban ${limit} fichas.`);
  }
  if (new Set(selected.map(candidate => candidate.item.id)).size !== selected.length) {
    throw new Error('La cohorte contiene IDs duplicados.');
  }
  if (new Set(selected.map(candidate => candidate.isbn)).size !== selected.length) {
    throw new Error('La cohorte contiene ISBN duplicados.');
  }

  return {
    selected,
    stats: {
      limit,
      active: active.length,
      paused: catalogItems.filter(item => item?.status === 'paused').length,
      eligibleBeforeIsbnDedupe: eligible.length,
      uniqueEligibleIsbns: representatives.length,
      historicalSelected: selected.filter(candidate => candidate.demand.impressions > 0).length,
      qualityFillSelected: selected.filter(candidate =>
        candidate.demand.impressions === 0 && candidate.qualityFillEligible).length,
      fallbackSelected: selected.filter(candidate =>
        candidate.demand.impressions === 0 && !candidate.qualityFillEligible).length,
      historicalImpressions: selected.reduce((sum, candidate) => sum + candidate.demand.impressions, 0),
      historicalClicks: selected.reduce((sum, candidate) => sum + candidate.demand.clicks, 0),
      rejectionCounts,
    },
  };
}

export function cohortModuleSource({ selected, metadata }) {
  const rows = selected.map(candidate => {
    const record = {
      id: candidate.item.id,
      isbn: candidate.isbn,
      source: candidate.demand.impressions > 0 ? 'gsc-demand' : 'catalog-quality',
      impressions: candidate.demand.impressions,
      clicks: candidate.demand.clicks,
      quality_score: candidate.qualityScore,
    };
    return `  Object.freeze(${JSON.stringify(record)}),`;
  });
  return `// Archivo generado por scripts/seo/generate-paused-cohort.mjs.\n` +
    `// No editar la lista a mano: regenerar desde catálogo + Search Console.\n\n` +
    `export const PAUSED_SEO_COHORT_META = Object.freeze(${JSON.stringify(metadata, null, 2)});\n\n` +
    `export const PAUSED_SEO_COHORT = Object.freeze([\n${rows.join('\n')}\n]);\n\n` +
    `const PAUSED_SEO_COHORT_ID_SET = new Set(PAUSED_SEO_COHORT.map(item => item.id));\n\n` +
    `export function isPausedProductInSeoCohort(id) {\n` +
    `  return PAUSED_SEO_COHORT_ID_SET.has(String(id || '').toUpperCase());\n` +
    `}\n`;
}

function cliOptions(argv) {
  const result = { limit: DEFAULT_LIMIT };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error(`Falta valor para ${flag}.`);
    if (flag === '--catalog') result.catalog = value;
    else if (flag === '--gsc') result.gsc = value;
    else if (flag === '--output') result.output = value;
    else if (flag === '--limit') result.limit = Number(value);
    else throw new Error(`Argumento desconocido: ${flag}`);
  }
  if (!result.catalog || !result.gsc || !result.output) {
    throw new Error('Uso: --catalog snapshot.json --gsc search-analytics-page.json --output cohort.js [--limit 3000]');
  }
  return result;
}

async function main() {
  const options = cliOptions(process.argv.slice(2));
  const [catalog, gsc] = await Promise.all([
    readFile(options.catalog, 'utf8').then(JSON.parse),
    readFile(options.gsc, 'utf8').then(JSON.parse),
  ]);
  const result = selectPausedSeoCohort({
    catalogItems: Array.isArray(catalog.items) ? catalog.items : [],
    gscRows: Array.isArray(gsc.rows) ? gsc.rows : [],
    limit: options.limit,
  });
  const metadata = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    catalog_manifest_version: catalog.sources?.paused_manifest_version || null,
    catalog_manifest_generated_at: catalog.sources?.paused_manifest_generated_at || null,
    gsc_date_range: gsc.dateRange || null,
    ...result.stats,
  };
  await writeFile(options.output, cohortModuleSource({ selected: result.selected, metadata }));
  console.log(JSON.stringify(metadata, null, 2));
  console.log(`Escrito: ${path.resolve(options.output)}`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
