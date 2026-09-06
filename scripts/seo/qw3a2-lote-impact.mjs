import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { BOOK_FACT_ENRICHMENTS as LOTE } from '../../functions/_shared/book-enrichment-facts-qw3a2-lote-01.js';
import { applyBookEnrichment } from '../../functions/_shared/book-enrichment-registry.js';
import { isGenericAuthor, normalizeValidIsbn } from '../../functions/_shared/showcase-ranking.js';

// QW3A2 — mide lo que el lote agrega SOBRE EL CATÁLOGO EFECTIVO, no sobre el
// catálogo crudo: el "antes" es la ficha tal como ya se publica (catálogo más
// el registro vigente), así que un dato que ya estaba publicado no vuelve a
// contarse como mejora.
//
// El registro que importa este script YA incluye el lote, así que el "antes"
// se reconstruye quitando los hechos del lote de la ficha efectiva.

const R2_BASE = 'https://pub-b2b408811ae24e3da04cda79c6ff084d.r2.dev';
const CATALOG_URL = `${R2_BASE}/catalog.json`;

const EDITION_FIELDS = Object.freeze([
  'author', 'publisher', 'pages', 'language', 'format', 'edition', 'publication_year', 'topics',
]);

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function existingFact(item, field) {
  const bibliography = item?.bibliographic && typeof item.bibliographic === 'object' ? item.bibliographic : {};
  if (field === 'author') return isGenericAuthor(item?.author) ? null : clean(item?.author) || null;
  if (field === 'publisher') return clean(item?.publisher) || null;
  if (field === 'pages') return Number(item?.pages) > 0 ? Number(item.pages) : null;
  if (field === 'topics') {
    return Array.isArray(bibliography.subjects) && bibliography.subjects.some(clean)
      ? bibliography.subjects.filter(clean)
      : null;
  }
  return clean(bibliography[field]) || null;
}

// El "antes": la ficha efectiva sin los hechos que aporta este lote.
export function withoutLoteFacts(effective, loteRecord) {
  if (!loteRecord) return effective;
  const facts = loteRecord.facts || {};
  const bibliographic = { ...(effective.bibliographic || {}) };
  for (const key of Object.keys(facts.bibliographic || {})) delete bibliographic[key];
  const before = { ...effective, bibliographic };
  if (facts.author) before.author = null;
  if (facts.publisher) before.publisher = null;
  if (facts.pages) before.pages = null;
  return before;
}

export function gainedFields(before, after) {
  return EDITION_FIELDS.filter(field => !existingFact(before, field) && Boolean(existingFact(after, field)));
}

export function summarizeGains(rows) {
  const buckets = { sin_mejora: 0, al_menos_1: 0, al_menos_3: 0 };
  const porCampo = {};
  for (const row of rows) {
    if (row.gained.length === 0) buckets.sin_mejora += 1;
    if (row.gained.length >= 1) buckets.al_menos_1 += 1;
    if (row.gained.length >= 3) buckets.al_menos_3 += 1;
    for (const field of row.gained) porCampo[field] = (porCampo[field] || 0) + 1;
  }
  return { buckets, porCampo };
}

export async function main() {
  const outputDir = process.env.SEO_OUTPUT_DIR || 'artifacts/seo';
  const fetchedAt = new Date().toISOString();
  const response = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`catalog.json respondió HTTP ${response.status}`);
  const catalog = await response.json();

  const loteByIsbn = new Map(LOTE.map(record => [record.isbn, record]));
  const listingsByIsbn = new Map();
  for (const item of Array.isArray(catalog?.items) ? catalog.items : []) {
    if (item?.status !== 'active' || !(Number(item.available_quantity) > 0)) continue;
    const isbn = normalizeValidIsbn(item?.isbn);
    if (!isbn || !loteByIsbn.has(isbn)) continue;
    if (!listingsByIsbn.has(isbn)) listingsByIsbn.set(isbn, []);
    listingsByIsbn.get(isbn).push(item);
  }

  const rows = [];
  for (const record of LOTE) {
    const listings = listingsByIsbn.get(record.isbn) || [];
    // Una edición cuenta la mejora si completa el campo en al menos una de
    // sus publicaciones vivas.
    const gained = new Set();
    for (const listing of listings) {
      const after = applyBookEnrichment(listing);
      const before = withoutLoteFacts(after, record);
      for (const field of gainedFields(before, after)) gained.add(field);
    }
    rows.push({
      isbn: record.isbn,
      listings: listings.map(item => clean(item.id).toUpperCase()),
      publicaciones_vivas: listings.length,
      gained: [...gained],
      fuentes: [...new Set((record.provenance || []).map(source => source.provider))],
    });
  }

  const conPublicaciones = rows.filter(row => row.publicaciones_vivas > 0);
  const summary = summarizeGains(conPublicaciones);

  const report = {
    schemaVersion: 1,
    fetchedAt,
    source: CATALOG_URL,
    catalogUpdatedAt: catalog?.updated_at || null,
    lote: 'qw3a2-lote-01',
    universo: {
      isbn_en_el_lote: rows.length,
      isbn_con_publicacion_viva: conPublicaciones.length,
      isbn_sin_publicacion_viva_hoy: rows.length - conPublicaciones.length,
      publicaciones_alcanzadas: conPublicaciones.reduce((sum, row) => sum + row.publicaciones_vivas, 0),
    },
    conteos: summary.buckets,
    mejoras_por_campo: summary.porCampo,
    rows,
  };

  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, 'qw3a2-lote-impact.json'), `${JSON.stringify(report, null, 2)}\n`);

  console.log('=== QW3A2 — IMPACTO DEL LOTE SOBRE EL CATÁLOGO EFECTIVO ===');
  console.log(JSON.stringify({ ...report, rows: undefined }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
