import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

// QW1 — congela un snapshot reproducible de los ítems reales que hay que
// renderizar, con su procedencia (URL, updated_at, versión de manifest y
// fecha de lectura). El mismo archivo alimenta el render de `main` y el de
// la rama del PR #313, para que la comparación no dependa de dos lecturas
// distintas del catálogo vivo.

const R2_BASE = 'https://pub-b2b408811ae24e3da04cda79c6ff084d.r2.dev';
const CATALOG_URL = `${R2_BASE}/catalog.json`;
const PRODUCTION_MANIFEST_URL = `${R2_BASE}/catalog/manifest.json`;
const FETCH_TIMEOUT_MS = 60_000;

function asText(value) {
  return String(value ?? '').trim();
}

function slugify(text) {
  return (text || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 60);
}

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${url} respondió HTTP ${response.status}`);
  return response.json();
}

async function getMaybeGzipJson(url) {
  const response = await fetch(url, {
    headers: { 'Accept-Encoding': 'identity' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${url} respondió HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const isGzip = buffer[0] === 0x1f && buffer[1] === 0x8b;
  return JSON.parse((isGzip ? gunzipSync(buffer) : buffer).toString('utf8'));
}

// Reconstruye un pausado igual que expandPausedIndex() en
// functions/_shared/catalog.js: sin price ni currency, stock 0.
function pausedItemFromRow(row, fields) {
  const position = Object.fromEntries(fields.map((field, i) => [field, i]));
  const id = asText(row[position.id]).toUpperCase();
  const title = asText(row[position.title]);
  if (!/^MLU\d+$/.test(id) || !title) return null;
  return {
    id,
    title,
    author: row[position.author] || null,
    isbn: row[position.isbn] || null,
    thumbnail: row[position.image] || null,
    slug: slugify(title),
    status: 'paused',
    available_quantity: 0,
  };
}

export async function main() {
  const cohortPath = asText(process.env.QW1_COHORT_INPUT) || 'artifacts/merchant/merchant-readonly-report.json';
  const outputPath = asText(process.env.QW1_SNAPSHOT) || 'artifacts/qw1/catalog-snapshot.json';
  const includeAllActive = asText(process.env.QW1_INCLUDE_ALL_ACTIVE) === '1';

  const fetchedAt = new Date().toISOString();
  const catalog = await getJson(CATALOG_URL);
  const catalogItems = Array.isArray(catalog?.items) ? catalog.items : [];
  const catalogById = new Map(catalogItems.map(item => [asText(item.id).toUpperCase(), item]));

  const manifest = await getJson(PRODUCTION_MANIFEST_URL);
  const descriptor = manifest?.current || null;
  const pausedKey = descriptor?.index_gzip_key || descriptor?.index_key;
  const pausedIndex = pausedKey ? await getMaybeGzipJson(`${R2_BASE}/${pausedKey}`) : null;
  const pausedById = new Map();
  if (pausedIndex && Array.isArray(pausedIndex.items) && Array.isArray(pausedIndex.fields)) {
    for (const row of pausedIndex.items) {
      const item = pausedItemFromRow(row, pausedIndex.fields);
      if (item) pausedById.set(item.id, item);
    }
  }

  const cohortIds = [];
  try {
    const report = JSON.parse(await readFile(cohortPath, 'utf8'));
    for (const row of report.productBreakdown?.missingPrice || []) {
      const id = asText(row.offerId).toUpperCase();
      if (id) cohortIds.push(id);
    }
  } catch {
    // Sin cohorte disponible el snapshot sigue siendo válido para el catálogo.
  }

  const selected = new Map();
  for (const id of cohortIds) {
    const item = catalogById.get(id) || pausedById.get(id) || null;
    if (item) selected.set(id, { ...item, _qw1Cohort: true });
  }
  if (includeAllActive) {
    for (const item of catalogItems) {
      const id = asText(item.id).toUpperCase();
      if (!selected.has(id)) selected.set(id, item);
    }
  }

  const snapshot = {
    schemaVersion: 1,
    fetchedAt,
    source: {
      catalog: CATALOG_URL,
      productionManifest: PRODUCTION_MANIFEST_URL,
      manifestVersion: asText(descriptor?.version) || null,
      pausedIndexKey: asText(pausedKey) || null,
    },
    catalogUpdatedAt: catalog?.updated_at || null,
    counts: {
      catalogItems: catalogItems.length,
      pausedIndexItems: pausedById.size,
      cohortRequested: cohortIds.length,
      cohortResolved: cohortIds.filter(id => selected.has(id)).length,
      snapshotItems: selected.size,
    },
    items: [...selected.values()],
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(JSON.stringify({ ...snapshot, items: undefined }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
