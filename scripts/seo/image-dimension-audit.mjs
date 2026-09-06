import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { readImageDimensions } from '../../worker-sync/cover-mirror.js';

// QW2 (Merchant, Gran Apuesta en curso): medición de SOLO LECTURA sobre las
// imágenes ya identificadas como image_too_small. No modifica Merchant, no
// escribe en R2, no activa Cloudflare Images (pago). Toma la lista de
// productos ya calculada por merchant-readonly-audit.mjs (offer_id + link +
// imageLink) y mide el ancho/alto REAL de la imagen que se está sirviendo
// hoy — la misma que ve Google — clasificando por lado corto: <500, 500-999,
// >=1000. No inventa ni corrige nada.

const CONCURRENCY = 8;
const FETCH_TIMEOUT_MS = 15_000;

function asText(value) {
  return String(value ?? '').trim();
}

function bucketFor(shortSide) {
  if (shortSide == null) return 'sin_medir';
  if (shortSide < 500) return '<500';
  if (shortSide < 1000) return '500-999';
  return '>=1000';
}

function positionFromUrl(url) {
  const match = /\/book-cover\/[^/]+\/cover(?:-(\d+))?\.jpg$/i.exec(asText(url));
  if (!match) return null;
  return match[1] ? Number(match[1]) - 1 : 0;
}

async function measureOne(row) {
  const { offerId, imageLink } = row;
  if (!imageLink) return { offerId, imageLink: null, shortSide: null, width: null, height: null, bucket: 'sin_medir', error: 'sin imageLink' };
  try {
    const response = await fetch(imageLink, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; AmadoLibrosImageAudit/1.0; solo lectura)' },
    });
    if (!response.ok) {
      return { offerId, imageLink, shortSide: null, width: null, height: null, bucket: 'sin_medir', error: `HTTP ${response.status}` };
    }
    const buffer = new Uint8Array(await response.arrayBuffer());
    const dimensions = readImageDimensions(buffer);
    if (!dimensions) {
      return { offerId, imageLink, shortSide: null, width: null, height: null, bucket: 'sin_medir', error: 'no se pudo parsear la imagen' };
    }
    const shortSide = Math.min(dimensions.width, dimensions.height);
    return {
      offerId,
      imageLink,
      width: dimensions.width,
      height: dimensions.height,
      shortSide,
      bucket: bucketFor(shortSide),
      position: positionFromUrl(imageLink),
      external: !/\/book-cover\//i.test(imageLink),
      error: null,
    };
  } catch (error) {
    return { offerId, imageLink, shortSide: null, width: null, height: null, bucket: 'sin_medir', error: asText(error?.message) || 'fetch failed' };
  }
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function main() {
  const inputPath = asText(process.env.IMAGE_AUDIT_INPUT) || 'artifacts/merchant/merchant-readonly-report.json';
  const outputDir = asText(process.env.IMAGE_AUDIT_OUTPUT_DIR) || 'artifacts/image-audit';
  const raw = await readFile(inputPath, 'utf8');
  const report = JSON.parse(raw);
  const rows = (report.productBreakdown?.imageTooSmall || []).map(row => ({
    offerId: row.offerId,
    imageLink: row.imageLink,
    dataSource: row.dataSource,
  }));

  const results = await mapWithConcurrency(rows, CONCURRENCY, measureOne);

  const byBucket = {};
  const byPosition = {};
  for (const row of results) {
    byBucket[row.bucket] = (byBucket[row.bucket] || 0) + 1;
    const posKey = row.position == null ? 'externa' : `posicion_${row.position}`;
    byPosition[posKey] = byPosition[posKey] || {};
    byPosition[posKey][row.bucket] = (byPosition[posKey][row.bucket] || 0) + 1;
  }

  const summary = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    totalMeasured: results.length,
    byBucket,
    byPosition,
    results,
  };

  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, 'image-dimension-audit.json'), `${JSON.stringify(summary, null, 2)}\n`);

  console.log('=== QW2 IMAGE DIMENSION AUDIT (solo lectura) ===');
  console.log(JSON.stringify({ totalMeasured: summary.totalMeasured, byBucket, byPosition }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
