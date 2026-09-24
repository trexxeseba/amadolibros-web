#!/usr/bin/env node

// Qué fichas activas faltan enriquecer, y por qué.
//
// Cruza el catálogo público vivo con el registro de enriquecimiento, el caché
// de fuentes bibliográficas, la clasificación por categoría y la cohorte de
// fichas ampliadas. No modifica nada: escribe un resumen en Markdown y un CSV
// priorizado para decidir el próximo lote.
//
// Uso:
//   node scripts/seo/fichas-pendientes-report.mjs
//   FICHAS_PENDIENTES_CATALOG=ruta/catalog.json node scripts/seo/fichas-pendientes-report.mjs

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { CATALOG_URL } from '../../functions/_shared/catalog.js';
import { applyBookEnrichment, getBookEnrichmentByIsbn } from '../../functions/_shared/book-enrichment-registry.js';
import { normalizeCategoryPaths } from '../../functions/_shared/category-paths.js';
import { SHOWCASE_COHORT_V2_URL, normalizeShowcaseCohort } from '../../functions/_shared/showcase-cohort.js';
import { isGenericAuthor, isShowcaseEligible, normalizeValidIsbn } from '../../functions/_shared/showcase-ranking.js';
import { readJsonMaybeGzip } from './book-intelligence-cache-io.mjs';

const DEFAULT_OUTPUT_DIR = 'reports/fichas-pendientes';
const DEFAULT_CACHE_PATH = 'artifacts/book-intelligence/b12-source-cache.json';
const DEFAULT_CATEGORIES_PATH = 'astro-front/public/data/active-categories.json';
const SOURCES = ['google_books', 'open_library', 'bne', 'loc', 'dnb'];
const PRIORITY_VERTICALS = new Set(['biblia', 'reina-valera', 'esoterismo-tarot']);
const UNCATEGORIZED = new Set(['otros-libros', 'otros-productos']);

export const FIELD_LABELS = Object.freeze({
  author: 'autor',
  publisher: 'editorial',
  pages: 'páginas',
  year: 'año',
  language: 'idioma',
  subjects: 'temas',
});

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

async function readJsonSource(source) {
  if (/^https?:\/\//.test(source)) {
    const response = await fetch(source, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`${source} respondió HTTP ${response.status}`);
    return response.json();
  }
  return JSON.parse(await readFile(source, 'utf8'));
}

export function missingFields(item) {
  const bibliography = item?.bibliographic && typeof item.bibliographic === 'object' ? item.bibliographic : {};
  const missing = [];
  if (!clean(item?.author) || isGenericAuthor(item.author)) missing.push('author');
  if (!clean(item?.publisher)) missing.push('publisher');
  if (!(Number(item?.pages) > 0)) missing.push('pages');
  if (!clean(bibliography.publication_year)) missing.push('year');
  if (!clean(bibliography.language)) missing.push('language');
  if (!(Array.isArray(bibliography.subjects) && bibliography.subjects.some(value => clean(value)))) missing.push('subjects');
  return missing;
}

/**
 * Estado de investigación por fuente para un ISBN: consultada con resultado,
 * consultada sin resultado, con error (se reintenta) o nunca consultada.
 */
export function sourceStatus(cacheEntries, isbn) {
  const entry = isbn ? cacheEntries?.[isbn] : null;
  const status = {};
  for (const source of SOURCES) {
    const record = entry?.[source];
    if (!record?.fetched_at) status[source] = 'pendiente';
    else if (clean(record.error)) status[source] = 'error';
    else status[source] = (record.records || []).length ? 'encontrado' : 'sin_datos';
  }
  return status;
}

/**
 * Clasifica una ficha en el motivo PRINCIPAL por el que sigue sin enriquecer.
 * El orden importa: cada motivo pide una acción distinta.
 */
export function pendingReason({ isbn, enriched, missing, sources }) {
  if (!missing.length) return 'completa';
  if (!isbn) return 'sin_isbn_valido';
  if (sources.google_books === 'pendiente' || sources.google_books === 'error') return 'falta_google_books';
  if (Object.values(sources).some(value => value === 'pendiente' || value === 'error')) return 'falta_otra_fuente';
  if (Object.values(sources).every(value => value === 'sin_datos')) return 'ninguna_fuente_lo_conoce';
  return enriched ? 'enriquecida_incompleta' : 'evidencia_insuficiente';
}

export function priorityScore({ stock, listings, missing, uncategorized, inShowcase }) {
  return Math.min(stock, 50) * 4 +
    Math.min(listings, 5) * 15 +
    missing.length * 20 +
    (uncategorized ? 25 : 0) +
    (inShowcase ? 0 : 30);
}

function csvCell(value) {
  const text = Array.isArray(value) ? value.join(' · ') : String(value ?? '');
  return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function countBy(rows, key) {
  const counts = new Map();
  for (const row of rows) counts.set(row[key], (counts.get(row[key]) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

const REASON_COPY = Object.freeze({
  completa: 'Tiene los seis datos básicos.',
  sin_isbn_valido: 'Sin ISBN válido: no se puede buscar por edición. Hay que cargar el ISBN en MercadoLibre o completar a mano.',
  falta_google_books: 'Google Books todavía no se consultó para este ISBN: lo cubren las próximas corridas diarias.',
  falta_otra_fuente: 'Falta consultar alguna biblioteca u Open Library (o dio error): se reintenta sola.',
  ninguna_fuente_lo_conoce: 'Ninguna fuente conoce el ISBN: completar a mano o con otra fuente.',
  evidencia_insuficiente: 'Hay evidencia, pero no alcanza la regla de publicación (dos fuentes o una oficial, sin conflicto).',
  enriquecida_incompleta: 'Ya enriquecida, pero las fuentes no traen los datos que faltan.',
});

export function buildReport({ catalogItems, categoryItems = {}, cacheEntries = {}, showcaseIds = new Set() }) {
  const active = (Array.isArray(catalogItems) ? catalogItems : []).filter(isShowcaseEligible);
  const listingsByIsbn = new Map();
  for (const item of active) {
    const isbn = normalizeValidIsbn(item.isbn);
    if (isbn) listingsByIsbn.set(isbn, (listingsByIsbn.get(isbn) || 0) + 1);
  }

  const rows = active.map(raw => {
    const item = applyBookEnrichment(raw);
    const isbn = normalizeValidIsbn(item.isbn);
    const enriched = Boolean(getBookEnrichmentByIsbn(isbn));
    const missing = missingFields(item);
    const sources = sourceStatus(cacheEntries, isbn);
    const paths = normalizeCategoryPaths(categoryItems[item.id]);
    const category = paths[0] ? paths[0].join('/') : 'sin-clasificar';
    const uncategorized = !paths.length || paths.every(([categoryId]) => UNCATEGORIZED.has(categoryId));
    const inShowcase = enriched || showcaseIds.has(item.id) ||
      paths.flat().some(tag => PRIORITY_VERTICALS.has(tag));
    const stock = Number(item.available_quantity) || 0;
    const listings = isbn ? listingsByIsbn.get(isbn) || 1 : 1;
    return {
      id: item.id,
      title: clean(item.title),
      isbn: isbn || '',
      stock,
      listings,
      category,
      uncategorized,
      enriched,
      inShowcase,
      missing,
      sources,
      reason: pendingReason({ isbn, enriched, missing, sources }),
      score: priorityScore({ stock, listings, missing, uncategorized, inShowcase }),
    };
  });

  rows.sort((a, b) => b.score - a.score || b.stock - a.stock || a.id.localeCompare(b.id));
  return rows;
}

export function renderSummary(rows, { generatedAt, catalogUpdatedAt }) {
  const pending = rows.filter(row => row.reason !== 'completa');
  const fieldCounts = Object.keys(FIELD_LABELS)
    .map(field => [FIELD_LABELS[field], rows.filter(row => row.missing.includes(field)).length]);
  const pendingIsbns = new Set(pending.filter(row => row.isbn).map(row => row.isbn));
  const googlePending = new Set(pending
    .filter(row => row.reason === 'falta_google_books')
    .map(row => row.isbn));

  const lines = [
    '# Fichas activas que faltan enriquecer',
    '',
    `Generado ${generatedAt} sobre el catálogo del ${catalogUpdatedAt || 'N/D'}.`,
    '',
    '| | Fichas |',
    '| --- | ---: |',
    `| Fichas activas vendibles | **${rows.length}** |`,
    `| Con los seis datos básicos | ${rows.length - pending.length} |`,
    `| **Les falta al menos un dato** | **${pending.length}** (${pendingIsbns.size} ISBN distintos) |`,
    `| Ya en el registro de enriquecimiento | ${rows.filter(row => row.enriched).length} |`,
    `| Sin ficha ampliada (texto automático) | ${rows.filter(row => !row.inShowcase).length} |`,
    `| Sin categoría (otros-libros / sin clasificar) | ${rows.filter(row => row.uncategorized).length} |`,
    '',
    '## Qué dato falta',
    '',
    '| Dato | Fichas sin el dato |',
    '| --- | ---: |',
    ...fieldCounts.map(([label, count]) => `| ${label} | ${count} |`),
    '',
    '## Por qué sigue pendiente (y qué hacer)',
    '',
    '| Motivo | Fichas | Qué hacer |',
    '| --- | ---: | --- |',
    ...countBy(pending, 'reason').map(([reason, count]) => `| \`${reason}\` | ${count} | ${REASON_COPY[reason] || ''} |`),
    '',
    `ISBN que todavía esperan Google Books: **${googlePending.size}** (a 900 por día, ${Math.ceil(googlePending.size / 900)} corridas).`,
    '',
    '## Las 40 primeras por prioridad',
    '',
    'Prioridad = stock, publicaciones repetidas del mismo ISBN, datos faltantes, sin categoría y sin ficha ampliada.',
    '',
    '| # | MLU | Título | Stock | Falta | Motivo |',
    '| ---: | --- | --- | ---: | --- | --- |',
    ...pending.slice(0, 40).map((row, index) =>
      `| ${index + 1} | ${row.id} | ${row.title.replace(/\|/g, '/').slice(0, 70)} | ${row.stock} | ${row.missing.map(field => FIELD_LABELS[field]).join(', ')} | \`${row.reason}\` |`),
    '',
    'El listado completo está en `fichas-pendientes.csv`, en el mismo orden.',
    '',
  ];
  return lines.join('\n');
}

export function renderCsv(rows) {
  const header = ['prioridad', 'mlu', 'titulo', 'isbn', 'stock', 'publicaciones_mismo_isbn', 'categoria', 'enriquecida',
    'ficha_ampliada', 'falta', 'motivo', ...SOURCES];
  const body = rows
    .filter(row => row.reason !== 'completa')
    .map((row, index) => [
      index + 1, row.id, row.title, row.isbn, row.stock, row.listings, row.category,
      row.enriched ? 'si' : 'no', row.inShowcase ? 'si' : 'no',
      row.missing.map(field => FIELD_LABELS[field]), row.reason,
      ...SOURCES.map(source => row.sources[source]),
    ].map(csvCell).join(','));
  return `${[header.join(','), ...body].join('\n')}\n`;
}

async function main() {
  const outputDir = process.env.FICHAS_PENDIENTES_OUTPUT_DIR || DEFAULT_OUTPUT_DIR;
  const catalog = await readJsonSource(process.env.FICHAS_PENDIENTES_CATALOG || CATALOG_URL);
  const categories = JSON.parse(await readFile(process.env.FICHAS_PENDIENTES_CATEGORIES || DEFAULT_CATEGORIES_PATH, 'utf8'));
  const cache = await readJsonMaybeGzip(process.env.FICHAS_PENDIENTES_CACHE || DEFAULT_CACHE_PATH);
  let showcaseIds = new Set();
  try {
    const cohort = normalizeShowcaseCohort(await readJsonSource(process.env.FICHAS_PENDIENTES_COHORT || SHOWCASE_COHORT_V2_URL));
    showcaseIds = cohort?.ids instanceof Set ? cohort.ids : new Set(cohort?.ids || []);
  } catch (error) {
    console.warn(`No se pudo leer la cohorte de fichas ampliadas: ${error.message}`);
  }

  const rows = buildReport({
    catalogItems: catalog?.items,
    categoryItems: categories?.items || {},
    cacheEntries: cache?.data?.entries || {},
    showcaseIds,
  });
  const summary = renderSummary(rows, {
    generatedAt: new Date().toISOString(),
    catalogUpdatedAt: catalog?.updated_at,
  });

  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, 'README.md'), summary);
  await writeFile(path.join(outputDir, 'fichas-pendientes.csv'), renderCsv(rows));
  console.log(summary);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
