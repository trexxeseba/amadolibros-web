// scripts/categorize/export-active-categories.js
//
// Genera el artefacto compacto que consume /catalogo en Preview — mlu ->
// [[categoryId, subcategoryId?], ...], para el universo público completo (activos +
// pausados; los cerrados/eliminados nunca entran al snapshot de origen, ver
// fetch-catalog.js). Deliberadamente chico (no el classifications.json
// completo de ~7MB). No modifica el dato original de MELI, no toca
// R2/D1/KV — solo lee scripts/categorize/data/classifications.json (ya
// generado por run.js) y escribe un archivo estático versionado que se
// despliega junto con el sitio (astro-front/public/).
//
// CF-CATEGORÍAS-2C: incluye "otros-productos" (antes excluido) y las
// subcategorías reales de cada categoría con libros activos.
// CF-CATEGORÍAS-2D: incluye también pausados — "Todos" en /catalogo debe
// ser activos + pausados visibles, con la misma clasificación y filtros.
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

  const items = {}; // schema v2: mlu -> [[categoryId, subcategoryId?], ...]
  const counts = {}; // categoryId -> count
  const subCounts = {}; // "categoryId/subcategoryId" -> count

  for (const r of results) {
    if ((r.status !== 'active' && r.status !== 'paused') || !r.primaryCategoryId) continue;
    const rawPaths = [
      { categoryId: r.primaryCategoryId, subcategoryId: r.subcategoryId ?? null },
      ...((r.secondaryCategoryPaths?.length
        ? r.secondaryCategoryPaths
        : (r.secondaryCategoryIds || []).map(categoryId => ({ categoryId, subcategoryId: null })))),
    ];
    const seenPaths = new Set();
    const paths = [];
    for (const pathEntry of rawPaths) {
      const categoryId = pathEntry?.categoryId;
      const subcategoryId = pathEntry?.subcategoryId ?? null;
      if (!categoryId) continue;
      const key = `${categoryId}/${subcategoryId || ''}`;
      if (seenPaths.has(key)) continue;
      seenPaths.add(key);
      paths.push(subcategoryId ? [categoryId, subcategoryId] : [categoryId]);
    }
    items[r.mlu] = paths;

    const seenCategories = new Set();
    for (const [categoryId, subcategoryId] of paths) {
      if (!seenCategories.has(categoryId)) {
        counts[categoryId] = (counts[categoryId] || 0) + 1;
        seenCategories.add(categoryId);
      }
      if (subcategoryId) {
        const key = `${categoryId}/${subcategoryId}`;
        subCounts[key] = (subCounts[key] || 0) + 1;
      }
    }
  }

  // Solo categorías/subcategorías con al menos un producto público (activo o
  // pausado) — nunca un menú con opciones vacías.
  const categories = CATEGORIES
    .filter(c => counts[c.id] > 0)
    .map(c => ({
      id: c.id,
      name: c.name,
      count: counts[c.id],
      subcategories: (c.subcategories || [])
        .filter(s => subCounts[`${c.id}/${s.id}`] > 0)
        .map(s => ({ id: s.id, name: s.name, count: subCounts[`${c.id}/${s.id}`] })),
    }));

  const out = {
    schema_version: 2,
    generated_at: new Date().toISOString(),
    taxonomy_version: summary.taxonomy_version,
    rules_version: summary.rules_version,
    categories,
    items,
  };

  mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  const json = JSON.stringify(out);
  writeFileSync(OUT_PATH, json);
  console.log(`[export-active-categories] ${Object.keys(items).length} MLU públicos (activos+pausados) en ${categories.length} categorías -> ${OUT_PATH}`);
  console.log(`[export-active-categories] tamaño: ${(json.length / 1024).toFixed(1)} KB`);
}

main();
