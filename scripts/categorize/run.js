// scripts/categorize/run.js
//
// Orquesta la clasificación del catálogo completo:
//   correcciones manuales > reglas > mejor categoría disponible
// (CF-CATEGORÍAS-2C: ningún activo queda sin primaryCategoryId — el peor
// caso es "otros-libros"/"otros-productos", nunca una exclusión silenciosa).
//
// No llama IA (eso es un lote aparte, y requeriría aprobación de gasto).
// No toca R2/D1/KV/producción — solo lee scripts/categorize/data/catalog-snapshot.json
// (generado por fetch-catalog.js) y escribe scripts/categorize/data/classifications.json
// (gitignored — ver .gitignore) más un resumen chico versionable.
//
// Reanudación: si ya existe classifications.json de una corrida anterior con
// el mismo taxonomyVersion+rulesVersion para un MLU sin corrección manual
// nueva, no se reclasifica — se reusa el resultado tal cual (evita recorrer
// de nuevo lo ya resuelto si se interrumpe y se vuelve a correr).
//
// Uso: node scripts/categorize/run.js

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { classify, validateClassification } from './classify.js';
import { TAXONOMY_VERSION } from './taxonomy.js';
import { RULES_VERSION } from './rules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const SNAPSHOT_PATH = path.join(DATA_DIR, 'catalog-snapshot.json');
const OUTPUT_PATH = path.join(DATA_DIR, 'classifications.json');
const CORRECTIONS_PATH = path.join(__dirname, 'manual-corrections.json');
const SUMMARY_PATH = path.join(__dirname, 'last-run-summary.json');

export function loadManualCorrections() {
  if (!existsSync(CORRECTIONS_PATH)) return new Map();
  const list = JSON.parse(readFileSync(CORRECTIONS_PATH, 'utf8'));
  const map = new Map();
  for (const correction of list) map.set(correction.mlu, correction);
  return map;
}

function loadPreviousOutput(outputPath) {
  if (!existsSync(outputPath)) return new Map();
  try {
    const list = JSON.parse(readFileSync(outputPath, 'utf8'));
    return new Map(list.map(r => [r.mlu, r]));
  } catch {
    return new Map(); // salida corrupta de una corrida interrumpida — reclasificar todo
  }
}

function sameVersion(prev) {
  return prev && prev.taxonomyVersion === TAXONOMY_VERSION && prev.rulesVersion === RULES_VERSION;
}

export function run({ snapshotPath = SNAPSHOT_PATH, outputPath = OUTPUT_PATH, correctionsPath = CORRECTIONS_PATH } = {}) {
  if (!existsSync(snapshotPath)) {
    throw new Error(
      `No existe ${snapshotPath} — correr primero: node scripts/categorize/fetch-catalog.js`
    );
  }
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  const corrections = correctionsPath === CORRECTIONS_PATH
    ? loadManualCorrections()
    : new Map(JSON.parse(readFileSync(correctionsPath, 'utf8')).map(c => [c.mlu, c]));
  const previous = loadPreviousOutput(outputPath);

  const seenMlu = new Set();
  const results = [];
  const errors = [];
  let reusedFromPrevious = 0;
  let reclassified = 0;
  let manualApplied = 0;

  for (const item of snapshot.items) {
    const mlu = item.id;
    if (seenMlu.has(mlu)) continue; // consolidación por MLU — nunca dos resultados para el mismo id
    seenMlu.add(mlu);

    const record = {
      mlu,
      title: item.title,
      author: item.author,
      publisher: item.publisher,
      isbn: item.isbn,
      status: item.status,
    };

    const correction = corrections.get(mlu) || null;
    const prevResult = previous.get(mlu);

    let result;
    if (correction) {
      result = classify(record, correction);
      manualApplied += 1;
    } else if (sameVersion(prevResult) && prevResult.method !== 'manual') {
      // Ya resuelto en una corrida anterior con la misma versión de reglas/
      // taxonomía y sin corrección manual pendiente — no se reclasifica.
      result = prevResult;
      reusedFromPrevious += 1;
    } else {
      result = classify(record, null);
      reclassified += 1;
    }

    const validationErrors = validateClassification(result);
    if (validationErrors.length > 0) {
      errors.push({ mlu, errors: validationErrors });
    }
    // needsReview también si la confianza queda por debajo del umbral, aunque
    // haya categoría — classify() ya lo marca; acá solo lo dejamos pasar.
    results.push({ ...result, status: item.status, title: item.title });
  }

  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(results));

  const summary = buildSummary(results, snapshot, { reusedFromPrevious, reclassified, manualApplied, errors });
  if (outputPath === OUTPUT_PATH) writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));

  return { results, summary, errors };
}

function buildSummary(results, snapshot, meta) {
  const byType = { book: 0, magazine: 0, music: 0, object: 0, other: 0 };
  const byCategory = {};
  const bySubcategory = {};
  const byMethod = {};
  let needsReview = 0;
  for (const r of results) {
    byType[r.type] = (byType[r.type] || 0) + 1;
    if (r.primaryCategoryId) byCategory[r.primaryCategoryId] = (byCategory[r.primaryCategoryId] || 0) + 1;
    if (r.subcategoryId) bySubcategory[r.subcategoryId] = (bySubcategory[r.subcategoryId] || 0) + 1;
    byMethod[r.method] = (byMethod[r.method] || 0) + 1;
    if (r.needsReview) needsReview += 1;
  }
  return {
    run_at: new Date().toISOString(),
    taxonomy_version: TAXONOMY_VERSION,
    rules_version: RULES_VERSION,
    snapshot_fetched_at: snapshot.fetched_at,
    mlu_unicos_procesados: results.length,
    reused_from_previous_run: meta.reusedFromPrevious,
    reclassified_this_run: meta.reclassified,
    manual_corrections_applied: meta.manualApplied,
    by_type: byType,
    by_category: byCategory,
    by_subcategory: bySubcategory,
    by_method: byMethod,
    needs_review: needsReview,
    validation_errors: meta.errors,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { summary, errors } = run();
  console.log(JSON.stringify(summary, null, 2));
  if (errors.length > 0) {
    console.error(`[run] ${errors.length} errores de validación — ver arriba.`);
    process.exit(1);
  }
}
