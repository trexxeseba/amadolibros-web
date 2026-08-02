// scripts/categorize/fetch-catalog.js
//
// Descarga y consolida el catálogo real (activos + pausados) desde los
// mismos archivos públicos de R2 que ya usa el sitio — solo lectura, nunca
// escribe en R2/D1/KV, nunca llama a la API de Mercado Libre. Guarda un
// snapshot local reproducible en scripts/categorize/data/ (gitignored, ver
// .gitignore — son datos derivados, no código).
//
// Uso: node scripts/categorize/fetch-catalog.js

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const R2_BASE = 'https://pub-b2b408811ae24e3da04cda79c6ff084d.r2.dev';

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.json();
}

function blockFilename(block) {
  return `block-${String(block).padStart(3, '0')}.json`;
}

export async function fetchAndConsolidate() {
  mkdirSync(DATA_DIR, { recursive: true });

  console.log('[fetch-catalog] Descargando catálogo activo (catalog.json)...');
  const activeCatalog = await fetchJson(`${R2_BASE}/catalog.json`);
  console.log(`[fetch-catalog] Activos: ${activeCatalog.items.length}, snapshot: ${activeCatalog.updated_at}`);

  console.log('[fetch-catalog] Descargando manifest de pausados...');
  const manifest = await fetchJson(`${R2_BASE}/catalog/manifest.json`);
  const { block_prefix: blockPrefix, block_count: blockCount, total: pausedTotal, version } = manifest.current;
  console.log(`[fetch-catalog] Manifest pausados: version=${version}, total=${pausedTotal}, block_count=${blockCount}, generated_at=${manifest.generated_at}`);

  console.log(`[fetch-catalog] Descargando ${blockCount} bloques de detalle de pausados...`);
  const pausedItems = [];
  for (let block = 0; block < blockCount; block++) {
    const url = `${R2_BASE}/${blockPrefix}/${blockFilename(block)}`;
    const payload = await fetchJson(url);
    if (!payload || !Array.isArray(payload.items)) {
      throw new Error(`Bloque inválido: ${url}`);
    }
    for (const item of payload.items) {
      if (item?.status === 'paused') pausedItems.push(item);
    }
    if ((block + 1) % 32 === 0 || block === blockCount - 1) {
      console.log(`[fetch-catalog]   bloque ${block + 1}/${blockCount} — ${pausedItems.length} pausados acumulados`);
    }
  }

  // Consolidar por MLU — activos y pausados son conjuntos disjuntos por
  // construcción (un item de MELI está en un solo status a la vez), pero
  // igual deduplicamos por id como red de seguridad, sin eliminar ISBN
  // repetidos entre MLUs distintos (eso es esperado, no un error).
  const byMlu = new Map();
  for (const item of activeCatalog.items) {
    if (!byMlu.has(item.id)) byMlu.set(item.id, { ...item, status: 'active' });
  }
  for (const item of pausedItems) {
    if (!byMlu.has(item.id)) byMlu.set(item.id, { ...item, status: 'paused' });
  }

  const consolidated = [...byMlu.values()];

  const snapshot = {
    fetched_at: new Date().toISOString(),
    sources: {
      active_catalog_updated_at: activeCatalog.updated_at,
      active_total_raw: activeCatalog.items.length,
      paused_manifest_version: version,
      paused_manifest_generated_at: manifest.generated_at,
      paused_total_raw: pausedItems.length,
    },
    mlu_unicos: consolidated.length,
    items: consolidated,
  };

  const outPath = path.join(DATA_DIR, 'catalog-snapshot.json');
  writeFileSync(outPath, JSON.stringify(snapshot));
  console.log(`[fetch-catalog] Consolidado: ${consolidated.length} MLU únicos (activos+pausados) -> ${outPath}`);
  return snapshot;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  fetchAndConsolidate().catch(err => {
    console.error('[fetch-catalog] ERROR:', err.message);
    process.exit(1);
  });
}
