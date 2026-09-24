// scripts/categorize/apply-assisted-classifications.mjs
//
// Incorpora clasificaciones asistidas (leídas título por título para la cola
// larga que las reglas dejan en "otros-libros") a:
//   1. scripts/categorize/assisted-classifications.json — la fuente que
//      run.js respeta en cada corrida futura (pierde sólo contra una
//      corrección manual);
//   2. astro-front/public/data/active-categories.json — el mapa que usa la
//      web, para que el cambio se vea sin esperar a una corrida completa.
//
// Sólo entran las de confianza "alta" con una categoría real. Nunca pisa una
// categoría que ya tenga el MLU: sólo reemplaza "otros-libros" o la ausencia
// de clasificación. No toca R2/D1/KV ni llama a ninguna API.
//
// Uso: node scripts/categorize/apply-assisted-classifications.mjs <out-1.json> [<out-2.json> ...]

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isValidCategoryId, isValidSubcategoryId } from './taxonomy.js';
import { countCategoryPaths, summarizeCategories } from './export-active-categories.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSISTED_PATH = path.join(__dirname, 'assisted-classifications.json');
const ACTIVE_CATEGORIES_PATH = path.join(__dirname, '..', '..', 'astro-front', 'public', 'data', 'active-categories.json');
const REPLACEABLE = new Set(['otros-libros']);

export function acceptedEntries(rawEntries, { date, source }) {
  const accepted = [];
  const rejected = { baja_o_media: 0, sin_categoria_real: 0, invalida: 0 };
  for (const entry of rawEntries) {
    const mlu = String(entry?.mlu || '').toUpperCase();
    const categoryId = entry?.cat;
    const subcategoryId = entry?.sub || null;
    if (entry?.conf !== 'alta') { rejected.baja_o_media += 1; continue; }
    if (!categoryId || categoryId === 'otros-libros') { rejected.sin_categoria_real += 1; continue; }
    if (!/^MLU\d+$/.test(mlu) || !isValidCategoryId(categoryId) || !isValidSubcategoryId(categoryId, subcategoryId)) {
      rejected.invalida += 1;
      continue;
    }
    accepted.push({
      mlu,
      type: categoryId === 'otros-productos' ? 'other' : 'book',
      primaryCategoryId: categoryId,
      subcategoryId,
      secondaryCategoryIds: [],
      secondaryCategoryPaths: [],
      tags: [],
      note: `Clasificación asistida ${date} por título (${source}); confianza alta.`,
    });
  }
  return { accepted, rejected };
}

export function mergeAssisted(existing, incoming) {
  const byMlu = new Map(existing.map(entry => [entry.mlu, entry]));
  for (const entry of incoming) byMlu.set(entry.mlu, entry);
  return [...byMlu.values()].sort((a, b) => a.mlu.localeCompare(b.mlu));
}

export function patchActiveCategories(payload, entries) {
  const items = { ...(payload.items || {}) };
  let patched = 0;
  for (const entry of entries) {
    const current = items[entry.mlu];
    const currentPrimary = Array.isArray(current) && Array.isArray(current[0]) ? current[0][0] : null;
    if (currentPrimary && !REPLACEABLE.has(currentPrimary)) continue;
    items[entry.mlu] = [entry.subcategoryId
      ? [entry.primaryCategoryId, entry.subcategoryId]
      : [entry.primaryCategoryId]];
    patched += 1;
  }
  const { counts, subCounts } = countCategoryPaths(items);
  return {
    payload: {
      ...payload,
      generated_at: new Date().toISOString(),
      categories: summarizeCategories(counts, subCounts),
      items,
    },
    patched,
  };
}

function main(files) {
  if (!files.length) throw new Error('Pasar al menos un archivo de clasificaciones asistidas.');
  const date = new Date().toISOString().slice(0, 10);
  const raw = files.flatMap(file => JSON.parse(readFileSync(file, 'utf8')));
  const { accepted, rejected } = acceptedEntries(raw, { date, source: 'Claude' });

  const existing = existsSync(ASSISTED_PATH) ? JSON.parse(readFileSync(ASSISTED_PATH, 'utf8')) : [];
  writeFileSync(ASSISTED_PATH, `${JSON.stringify(mergeAssisted(existing, accepted), null, 2)}\n`);

  const active = JSON.parse(readFileSync(ACTIVE_CATEGORIES_PATH, 'utf8'));
  const { payload, patched } = patchActiveCategories(active, accepted);
  writeFileSync(ACTIVE_CATEGORIES_PATH, JSON.stringify(payload));

  console.log(JSON.stringify({ leidas: raw.length, aceptadas: accepted.length, rechazadas: rejected, aplicadas_en_la_web: patched }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
