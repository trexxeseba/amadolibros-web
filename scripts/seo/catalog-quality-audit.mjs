import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  normalizeIsbnToGtin,
  normalizePublisherForDescription,
} from '../../functions/feed.xml.js';

const DEFAULT_CATALOG_URL = 'https://pub-b2b408811ae24e3da04cda79c6ff084d.r2.dev/catalog.json';

function nonEmpty(value) {
  return value != null && String(value).trim() !== '';
}

function positiveNumber(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

function validDimension(value) {
  if (!nonEmpty(value)) return false;
  const normalized = String(value).trim();
  return normalized !== '-1' && !normalized.startsWith('-1 ');
}

function imageCount(item) {
  const pictures = Array.isArray(item?.pictures)
    ? [...new Set(item.pictures.filter(nonEmpty))]
    : [];
  if (pictures.length > 0) return pictures.length;
  return nonEmpty(item?.thumbnail) ? 1 : 0;
}

function pct(count, total) {
  return total ? Number(((count / total) * 100).toFixed(2)) : 0;
}

function metric(items, predicate) {
  const count = items.filter(predicate).length;
  return { count, missing: items.length - count, percent: pct(count, items.length) };
}

// Secuencias típicas de UTF-8 interpretado como Windows-1252/Latin-1 y el
// carácter de reemplazo. No corrige a ciegas: identifica publicaciones para
// corregir en la fuente y evita transformar títulos válidos automáticamente.
const MOJIBAKE_RE = /(?:Ã.|Â.|â€|â€™|â€œ|â€|â€“|â€”|ðŸ|ï¿½|�)/u;

export function looksLikeMojibake(value) {
  return nonEmpty(value) && MOJIBAKE_RE.test(String(value));
}

export function auditCatalog(catalog, { source = null, generatedAt = new Date().toISOString() } = {}) {
  if (!catalog || !Array.isArray(catalog.items)) {
    throw new Error('catalog.json inválido: falta items[]');
  }

  const all = catalog.items;
  const active = all.filter(item => item?.status === 'active' && Number(item.available_quantity) > 0);
  const coverage = {
    title: metric(active, item => nonEmpty(item.title)),
    title_encoding_clean: metric(active, item => nonEmpty(item.title) && !looksLikeMojibake(item.title)),
    author: metric(active, item => nonEmpty(item.author)),
    isbn_any: metric(active, item => nonEmpty(item.isbn)),
    isbn_valid: metric(active, item => normalizeIsbnToGtin(item.isbn).valid),
    publisher_real: metric(active, item => Boolean(normalizePublisherForDescription(item.publisher))),
    pages: metric(active, item => positiveNumber(item.pages)),
    condition: metric(active, item => ['new', 'used', 'not_specified'].includes(String(item.condition || '').toLowerCase())),
    price: metric(active, item => positiveNumber(item.price)),
    permalink: metric(active, item => nonEmpty(item.permalink)),
    image_any: metric(active, item => imageCount(item) >= 1),
    image_multiple: metric(active, item => imageCount(item) >= 2),
    dimensions_any: metric(active, item => {
      const dimensions = item?.dimensions || {};
      return ['width', 'height', 'length', 'weight'].some(key => validDimension(dimensions[key]));
    }),
    dimensions_linear_complete: metric(active, item => {
      const dimensions = item?.dimensions || {};
      return ['width', 'height', 'length'].every(key => validDimension(dimensions[key]));
    }),
    weight: metric(active, item => validDimension(item?.dimensions?.weight)),
  };

  const imageDistribution = active.reduce((acc, item) => {
    const count = imageCount(item);
    const bucket = count === 0 ? '0' : count === 1 ? '1' : count <= 3 ? '2-3' : '4+';
    acc[bucket] = (acc[bucket] || 0) + 1;
    return acc;
  }, {});
  const invalidIsbnWithValue = active.filter(item => {
    const result = normalizeIsbnToGtin(item.isbn);
    return result.hadValue && !result.valid;
  }).length;
  const mojibakeTitles = active
    .filter(item => looksLikeMojibake(item.title))
    .map(item => ({ id: item.id, title: item.title }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));

  const priority = [
    ['title_encoding_clean', 'SEO/CX: títulos legibles en snippets, búsqueda y ficha'],
    ['author', 'SEO/CX: autor mejora búsqueda, comprensión y long-tail'],
    ['isbn_valid', 'SEO/Merchant: identificador bibliográfico confiable'],
    ['publisher_real', 'SEO/CX: editorial real en ficha y schema'],
    ['pages', 'CX: reduce incertidumbre de compra'],
    ['dimensions_linear_complete', 'CX/logística: tamaño físico completo'],
    ['weight', 'Logística/CX: peso real'],
    ['image_multiple', 'UX/CX: más evidencia visual del producto'],
  ]
    .map(([key, reason]) => ({ key, ...coverage[key], reason }))
    .sort((a, b) => b.missing - a.missing);

  return {
    schemaVersion: 2,
    generatedAt,
    source,
    inventory: {
      catalogItems: all.length,
      activeWithStock: active.length,
      catalogUpdatedAt: catalog.updated_at || null,
    },
    coverage,
    isbn: {
      invalidWithValue: invalidIsbnWithValue,
      invalidWithValuePercent: pct(invalidIsbnWithValue, active.length),
    },
    images: {
      distribution: imageDistribution,
      distributionPercent: Object.fromEntries(
        Object.entries(imageDistribution).map(([key, value]) => [key, pct(value, active.length)]),
      ),
    },
    issues: {
      mojibakeTitles,
      mojibakeTitleCount: mojibakeTitles.length,
      mojibakeTitlePercent: pct(mojibakeTitles.length, active.length),
    },
    priorityByMissingCoverage: priority,
  };
}

async function main() {
  const catalogUrl = process.env.CATALOG_URL || DEFAULT_CATALOG_URL;
  const outputDir = process.env.SEO_OUTPUT_DIR || 'artifacts/seo';
  const outputDate = process.env.SEO_OUTPUT_DATE || new Date().toISOString().slice(0, 10);
  const response = await fetch(catalogUrl, {
    headers: { 'user-agent': 'AmadoLibros-Catalog-Quality-Audit/2.0' },
  });
  if (!response.ok) throw new Error(`catalog.json respondió HTTP ${response.status}`);
  const report = auditCatalog(await response.json(), { source: catalogUrl });

  await mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `catalog-quality-audit-${outputDate}.json`);
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(JSON.stringify({
    inventory: report.inventory,
    coverage: report.coverage,
    isbn: report.isbn,
    images: report.images,
    issues: report.issues,
  }, null, 2));
  console.log('PRIORITY=' + JSON.stringify(report.priorityByMissingCoverage));
  console.log(`Escrito: ${outputPath}`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
