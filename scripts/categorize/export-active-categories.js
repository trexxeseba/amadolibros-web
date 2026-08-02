// scripts/categorize/export-active-categories.js
//
// Genera el artefacto compacto que consume /catalogo en Preview para el
// filtro de categoría — mlu -> categoryId, solo activos, solo libros ya
// resueltos (no objetos ni pendientes). Deliberadamente chico (no el
// classifications.json completo de 6MB) para poder fetchearse en cada
// request sin costo real. No modifica el dato original de MELI, no toca
// R2/D1/KV — solo lee scripts/categorize/data/classifications.json (ya
// generado por run.js) y escribe un archivo estático versionado que se
// despliega junto con el sitio (astro-front/public/).
//
// Uso: node scripts/categorize/export-active-categories.js

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CATEGORIES } from './taxonomy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLASSIFICATIONS_PATH = path.join(__dirname, 'data', 'classifications.json');
const SUMMARY_PATH = path.join(__dirname, 'last-run-summary.json');
const OUT_PATH = path.join(__dirname, '..', '..', 'astro-front', 'public', 'data', 'active-categories.json');

function main() {
  const results = JSON.parse(readFileSync(CLASSIFICATIONS_PATH, 'utf8'));
  const summary = JSON.parse(readFileSync(SUMMARY_PATH, 'utf8'));

  const items = {};
  const counts = {};
  for (const r of results) {
    if (r.status !== 'active' || r.type !== 'book' || !r.categoryId) continue;
    items[r.mlu] = r.categoryId;
    counts[r.categoryId] = (counts[r.categoryId] || 0) + 1;
  }

  const categories = CATEGORIES.filter(c => counts[c.id] > 0);

  const out = {
    generated_at: new Date().toISOString(),
    taxonomy_version: summary.taxonomy_version,
    rules_version: summary.rules_version,
    categories,
    counts,
    items,
  };

  mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  const json = JSON.stringify(out);
  writeFileSync(OUT_PATH, json);
  console.log(`[export-active-categories] ${Object.keys(items).length} MLU activos en ${categories.length} categorías -> ${OUT_PATH}`);
  console.log(`[export-active-categories] tamaño: ${(json.length / 1024).toFixed(1)} KB`);
}

main();
