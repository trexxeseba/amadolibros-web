// scripts/categorize/export-otros-libros.mjs
//
// Lista los libros que hoy caen en "otros-libros" (activos y pausados) con
// su título y autor, para revisarlos a mano y ubicarlos en un tema que ya
// existe. Solo lectura: baja el catálogo público de R2 con fetch-catalog.js
// y escribe un TSV en artifacts/categorize/. No toca R2/D1/KV.
//
// Uso: node scripts/categorize/export-otros-libros.mjs

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchAndConsolidate } from './fetch-catalog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const ACTIVE_CATEGORIES = path.join(ROOT, 'astro-front', 'public', 'data', 'active-categories.json');
const PREVIOUS_REVIEW = path.join(ROOT, 'artifacts', 'categorize', 'asistida-2026-09-24', 'clasificaciones.json');
const OUT_DIR = path.join(ROOT, 'artifacts', 'categorize', 'otros-libros');

const clean = value => String(value || '').replace(/[\t\r\n]+/g, ' ').trim();

export function otrosLibrosRows(snapshotItems, categoryItems, reviewed = new Set()) {
  const byId = new Map(snapshotItems.map(item => [item.id, item]));
  const rows = [];
  for (const [mlu, paths] of Object.entries(categoryItems)) {
    const primary = Array.isArray(paths?.[0]) ? paths[0][0] : paths?.[0];
    if (primary !== 'otros-libros') continue;
    const item = byId.get(mlu);
    if (!item) continue;
    rows.push({
      mlu,
      estado: item.status === 'paused' ? 'encargo' : 'disponible',
      revisado_antes: reviewed.has(mlu) ? 'si' : 'no',
      titulo: clean(item.title),
      autor: clean(item.author),
    });
  }
  return rows.sort((a, b) => a.mlu.localeCompare(b.mlu));
}

async function main() {
  const snapshot = await fetchAndConsolidate();
  const categories = JSON.parse(readFileSync(ACTIVE_CATEGORIES, 'utf8'));
  const reviewed = new Set(JSON.parse(readFileSync(PREVIOUS_REVIEW, 'utf8')).map(entry => entry.mlu));
  const rows = otrosLibrosRows(snapshot.items, categories.items, reviewed);
  mkdirSync(OUT_DIR, { recursive: true });
  const header = 'mlu\testado\trevisado_antes\ttitulo\tautor';
  const lines = rows.map(r => [r.mlu, r.estado, r.revisado_antes, r.titulo, r.autor].join('\t'));
  writeFileSync(path.join(OUT_DIR, 'pendientes.tsv'), `${[header, ...lines].join('\n')}\n`);
  const summary = {
    generado: new Date().toISOString(),
    total: rows.length,
    sin_revisar: rows.filter(r => r.revisado_antes === 'no').length,
    disponibles: rows.filter(r => r.estado === 'disponible').length,
    encargo: rows.filter(r => r.estado === 'encargo').length,
  };
  writeFileSync(path.join(OUT_DIR, 'resumen.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error('[export-otros-libros] ERROR:', error.message);
    process.exit(1);
  });
}
