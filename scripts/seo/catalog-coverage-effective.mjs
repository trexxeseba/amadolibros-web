import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { normalizeIsbnToGtin, normalizePublisherForDescription } from '../../functions/feed.xml.js';
import { applyBookEnrichment } from '../../functions/_shared/book-enrichment-registry.js';
import { isGenericAuthor, realAuthor } from '../../functions/_shared/generic-author.js';

// Cobertura REAL de lo que se publica, en dos capas sobre el MISMO universo y
// el MISMO snapshot:
//
//   - `crudo`: el catálogo tal como llega de Mercado Libre.
//   - `efectivo`: el mismo ítem después de applyBookEnrichment(), que es lo
//     que realmente ve la ficha publicada, el JSON-LD y el feed.
//
// Además separa "campo no vacío" de "campo útil":
//   - autor no vacío  vs  autor REAL (descarta 'Desconocido', 'Varios', etc.).
//   - descripción no vacía vs descripción útil por umbral de longitud.

const R2_BASE = 'https://pub-b2b408811ae24e3da04cda79c6ff084d.r2.dev';
const CATALOG_URL = `${R2_BASE}/catalog.json`;

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function positiveNumber(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

function descriptionLength(item) {
  return clean(item?.description).length;
}

function pct(count, total) {
  return total ? Number(((count / total) * 100).toFixed(2)) : 0;
}

export function coverageFor(items) {
  const metric = predicate => {
    const count = items.filter(predicate).length;
    return { count, missing: items.length - count, percent: pct(count, items.length) };
  };
  return {
    author_no_vacio: metric(item => clean(item.author) !== ''),
    author_real: metric(item => Boolean(realAuthor(item.author))),
    author_generico: metric(item => clean(item.author) !== '' && isGenericAuthor(item.author)),
    isbn_valido: metric(item => normalizeIsbnToGtin(item.isbn).valid),
    publisher_real: metric(item => Boolean(normalizePublisherForDescription(item.publisher))),
    pages: metric(item => positiveNumber(item.pages)),
    language: metric(item => clean(item?.bibliographic?.language) !== ''),
    format: metric(item => clean(item?.bibliographic?.format) !== ''),
    edition: metric(item => clean(item?.bibliographic?.edition) !== ''),
    publication_year: metric(item => clean(item?.bibliographic?.publication_year) !== ''),
    genre: metric(item => clean(item?.bibliographic?.genre) !== ''),
    description_no_vacia: metric(item => descriptionLength(item) > 0),
    description_80: metric(item => descriptionLength(item) >= 80),
    description_util_280: metric(item => descriptionLength(item) >= 280),
    description_700: metric(item => descriptionLength(item) >= 700),
  };
}

function deltaTable(raw, effective) {
  const rows = {};
  for (const key of Object.keys(raw)) {
    rows[key] = {
      crudo: raw[key].count,
      efectivo: effective[key].count,
      ganancia: effective[key].count - raw[key].count,
      percent_crudo: raw[key].percent,
      percent_efectivo: effective[key].percent,
    };
  }
  return rows;
}

export async function main() {
  const outputDir = process.env.SEO_OUTPUT_DIR || 'artifacts/seo';
  const fetchedAt = new Date().toISOString();
  const response = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`catalog.json respondió HTTP ${response.status}`);
  const catalog = await response.json();

  // Mismo universo que catalog-quality-audit.mjs: activos con stock.
  const raw = (Array.isArray(catalog?.items) ? catalog.items : [])
    .filter(item => item?.status === 'active' && Number(item.available_quantity) > 0);
  const effective = raw.map(item => applyBookEnrichment(item));

  const rawCoverage = coverageFor(raw);
  const effectiveCoverage = coverageFor(effective);

  const enrichedItems = raw.filter((item, index) => effective[index] !== item).length;

  const report = {
    schemaVersion: 1,
    fetchedAt,
    source: CATALOG_URL,
    catalogUpdatedAt: catalog?.updated_at || null,
    universe: { activeWithStock: raw.length, itemsTocadosPorEnriquecimiento: enrichedItems },
    crudo: rawCoverage,
    efectivo: effectiveCoverage,
    delta: deltaTable(rawCoverage, effectiveCoverage),
  };

  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, 'catalog-coverage-effective.json'), `${JSON.stringify(report, null, 2)}\n`);

  console.log('=== COBERTURA CRUDA vs EFECTIVA (mismo universo y snapshot) ===');
  console.log(JSON.stringify({
    fetchedAt,
    catalogUpdatedAt: report.catalogUpdatedAt,
    universe: report.universe,
    delta: report.delta,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
