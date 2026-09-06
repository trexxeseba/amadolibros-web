import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

// QW1 — evidencia de catálogo, no inferencia. Para cada MLU del cohorte real
// de `missing_price` cruza status, precio, moneda y stock contra el catálogo
// que consume CADA entorno:
//
//   - catalog.json (activo) es COMPARTIDO por Producción y Preview.
//   - el manifest de pausados NO: Producción usa `catalog/manifest.json` y
//     Preview usa `stock1-preview/manifest.json` (functions/_shared/catalog.js).
//   - el índice de pausados no transporta `price` ni `currency`: sus filas son
//     [id, title, author, isbn, image] y se expanden con available_quantity 0.
//
// Todo es GET de solo lectura sobre URLs públicas. No infiere "no tiene
// precio" desde "no hay Offer": informa el dato real de cada fuente, o
// `desconocido` cuando la fuente no lo transporta.

const R2_BASE = 'https://pub-b2b408811ae24e3da04cda79c6ff084d.r2.dev';
const CATALOG_URL = `${R2_BASE}/catalog.json`;
const MANIFESTS = {
  produccion: `${R2_BASE}/catalog/manifest.json`,
  preview: `${R2_BASE}/stock1-preview/manifest.json`,
};
const FETCH_TIMEOUT_MS = 60_000;

function asText(value) {
  return String(value ?? '').trim();
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

function indexRowsToMap(index, expectedFields) {
  const map = new Map();
  if (!index || !Array.isArray(index.items) || !Array.isArray(index.fields)) return map;
  const position = Object.fromEntries(index.fields.map((field, i) => [field, i]));
  for (const row of index.items) {
    if (!Array.isArray(row)) continue;
    const id = asText(row[position.id]).toUpperCase();
    if (!id) continue;
    const entry = {};
    for (const field of expectedFields) {
      entry[field] = position[field] == null ? undefined : row[position[field]];
    }
    map.set(id, entry);
  }
  return map;
}

async function loadEnvironment(name, manifestUrl) {
  const manifest = await getJson(manifestUrl);
  const descriptor = manifest?.current || null;
  const result = {
    environment: name,
    manifestUrl,
    manifestVersion: asText(descriptor?.version) || null,
    activeIndexKey: asText(descriptor?.active_index_key) || null,
    pausedIndexKey: asText(descriptor?.index_key) || null,
    active: new Map(),
    paused: new Map(),
  };
  const activeKey = descriptor?.active_index_gzip_key || descriptor?.active_index_key;
  if (activeKey) {
    const index = await getMaybeGzipJson(`${R2_BASE}/${activeKey}`);
    result.active = indexRowsToMap(index, ['id', 'price', 'available_quantity', 'title']);
  }
  const pausedKey = descriptor?.index_gzip_key || descriptor?.index_key;
  if (pausedKey) {
    const index = await getMaybeGzipJson(`${R2_BASE}/${pausedKey}`);
    result.paused = indexRowsToMap(index, ['id', 'title', 'isbn']);
  }
  return result;
}

// El estado que resuelve functions/libro/[[path]].js: primero catalog.json
// (compartido), y sólo si no está ahí, el índice de pausados del entorno.
export function resolveItemForEnvironment(id, { catalogItem, pausedIndex }) {
  if (catalogItem) {
    return {
      source: 'catalog.json',
      status: asText(catalogItem.status) || null,
      price: catalogItem.price ?? null,
      currency: asText(catalogItem.currency || catalogItem.currency_id) || null,
      available_quantity: catalogItem.available_quantity ?? null,
      httpExpected: 200,
    };
  }
  if (pausedIndex?.has(id)) {
    return {
      source: 'paused-index',
      status: 'paused',
      // El índice de pausados NO transporta precio ni moneda: no es que el
      // producto no tenga precio, es que esta fuente no lo publica.
      price: 'no-transportado-por-la-fuente',
      currency: 'no-transportado-por-la-fuente',
      available_quantity: 0,
      httpExpected: 200,
    };
  }
  return {
    source: null,
    status: null,
    price: null,
    currency: null,
    available_quantity: null,
    httpExpected: 404,
  };
}

export function classifyCohortRow(row) {
  const { produccion, preview } = row.environments;
  if (produccion.httpExpected !== 200 || preview.httpExpected !== 200) {
    return 'no_comparable_404';
  }
  if (produccion.source === 'paused-index' || produccion.status === 'paused') {
    return 'pausado_sin_precio_en_la_fuente';
  }
  if (produccion.source === 'catalog.json' && Number(produccion.price) > 0) {
    return 'activo_con_precio_real';
  }
  return 'causa_pendiente_de_verificar';
}

export async function main() {
  const inputPath = asText(process.env.QW1_EVIDENCE_INPUT) || 'artifacts/merchant/merchant-readonly-report.json';
  const outputDir = asText(process.env.QW1_EVIDENCE_OUTPUT_DIR) || 'artifacts/merchant';
  const report = JSON.parse(await readFile(inputPath, 'utf8'));
  const cohort = (report.productBreakdown?.missingPrice || []).map(row => ({
    offerId: asText(row.offerId).toUpperCase(),
    link: row.link,
  }));

  const fetchedAt = new Date().toISOString();
  const catalog = await getJson(CATALOG_URL);
  const catalogById = new Map(
    (Array.isArray(catalog?.items) ? catalog.items : [])
      .map(item => [asText(item.id).toUpperCase(), item]),
  );

  const environments = {};
  for (const [name, url] of Object.entries(MANIFESTS)) {
    environments[name] = await loadEnvironment(name, url);
  }

  const rows = cohort.map(entry => {
    const perEnvironment = {};
    for (const [name, env] of Object.entries(environments)) {
      perEnvironment[name] = resolveItemForEnvironment(entry.offerId, {
        catalogItem: catalogById.get(entry.offerId) || null,
        pausedIndex: env.paused,
      });
    }
    const row = { offerId: entry.offerId, link: entry.link, environments: perEnvironment };
    row.classification = classifyCohortRow(row);
    return row;
  });

  const counts = rows.reduce((acc, row) => {
    acc[row.classification] = (acc[row.classification] || 0) + 1;
    return acc;
  }, {});

  const summary = {
    schemaVersion: 1,
    fetchedAt,
    sources: {
      catalog: { url: CATALOG_URL, updated_at: catalog?.updated_at || null, items: catalogById.size },
      produccion: {
        manifestUrl: environments.produccion.manifestUrl,
        version: environments.produccion.manifestVersion,
        activeIndexItems: environments.produccion.active.size,
        pausedIndexItems: environments.produccion.paused.size,
      },
      preview: {
        manifestUrl: environments.preview.manifestUrl,
        version: environments.preview.manifestVersion,
        activeIndexItems: environments.preview.active.size,
        pausedIndexItems: environments.preview.paused.size,
      },
    },
    cohortSize: rows.length,
    counts,
    rows,
  };

  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, 'qw1-cohort-catalog-evidence.json'), `${JSON.stringify(summary, null, 2)}\n`);

  console.log('=== QW1 EVIDENCIA DE CATÁLOGO (sin inferencias) ===');
  console.log(JSON.stringify({
    fetchedAt: summary.fetchedAt,
    sources: summary.sources,
    cohortSize: summary.cohortSize,
    counts,
  }, null, 2));

  console.log('=== QW1 muestra por clasificación (hasta 3 por clase) ===');
  const sample = {};
  for (const row of rows) {
    sample[row.classification] = sample[row.classification] || [];
    if (sample[row.classification].length < 3) sample[row.classification].push(row);
  }
  console.log(JSON.stringify(sample, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
