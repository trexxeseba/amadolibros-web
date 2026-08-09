import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  normalizeIsbnToGtin,
  normalizePublisherForDescription,
} from '../../functions/feed.xml.js';

const CATALOG_URL = process.env.CATALOG_URL || 'https://pub-b2b408811ae24e3da04cda79c6ff084d.r2.dev/catalog.json';
const OUTPUT_DIR = process.env.SEO_OUTPUT_DIR || 'artifacts/seo';
const OUTPUT_DATE = process.env.SEO_OUTPUT_DATE || new Date().toISOString().slice(0, 10);

function nonEmpty(value) {
  return value != null && String(value).trim() !== '';
}

function positiveNumber(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

function validDimension(value) {
  if (!nonEmpty(value)) return false;
  const s = String(value).trim();
  return s !== '-1' && !s.startsWith('-1 ');
}

function imageCount(item) {
  const values = [];
  if (Array.isArray(item?.pictures)) values.push(...item.pictures);
  if (item?.thumbnail) values.push(item.thumbnail);
  return new Set(values.filter(nonEmpty)).size;
}

function pct(count, total) {
  return total ? Number(((count / total) * 100).toFixed(2)) : 0;
}

function metric(items, predicate) {
  const count = items.filter(predicate).length;
  return { count, missing: items.length - count, percent: pct(count, items.length) };
}

const response = await fetch(CATALOG_URL, {
  headers: { 'user-agent': 'AmadoLibros-Catalog-Quality-Audit/1.0' },
});
if (!response.ok) throw new Error(`catalog.json respondió HTTP ${response.status}`);
const catalog = await response.json();
if (!catalog || !Array.isArray(catalog.items)) throw new Error('catalog.json inválido: falta items[]');

const all = catalog.items;
const active = all.filter(item => item?.status === 'active' && Number(item.available_quantity) > 0);

const coverage = {
  title: metric(active, item => nonEmpty(item.title)),
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
    const d = item?.dimensions || {};
    return ['width', 'height', 'length', 'weight'].some(key => validDimension(d[key]));
  }),
  dimensions_linear_complete: metric(active, item => {
    const d = item?.dimensions || {};
    return ['width', 'height', 'length'].every(key => validDimension(d[key]));
  }),
  weight: metric(active, item => validDimension(item?.dimensions?.weight)),
};

const imageDistribution = active.reduce((acc, item) => {
  const n = imageCount(item);
  const bucket = n === 0 ? '0' : n === 1 ? '1' : n <= 3 ? '2-3' : '4+';
  acc[bucket] = (acc[bucket] || 0) + 1;
  return acc;
}, {});

const invalidIsbnWithValue = active.filter(item => {
  const result = normalizeIsbnToGtin(item.isbn);
  return result.hadValue && !result.valid;
}).length;

const priority = [
  ['author', 'SEO/CX: autor mejora búsqueda, comprensión y long-tail'],
  ['isbn_valid', 'SEO/Merchant: identificador bibliográfico confiable'],
  ['publisher_real', 'SEO/CX: editorial real en ficha y schema'],
  ['pages', 'CX: reduce incertidumbre de compra'],
  ['dimensions_linear_complete', 'CX/logística: tamaño físico completo'],
  ['weight', 'logística/CX: peso real'],
  ['image_multiple', 'UX/CX: más evidencia visual del producto'],
]
  .map(([key, reason]) => ({ key, ...coverage[key], reason }))
  .sort((a, b) => b.missing - a.missing);

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  source: CATALOG_URL,
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
  priorityByMissingCoverage: priority,
};

await mkdir(OUTPUT_DIR, { recursive: true });
const outputPath = path.join(OUTPUT_DIR, `catalog-quality-audit-${OUTPUT_DATE}.json`);
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);

console.log(JSON.stringify({ inventory: report.inventory, coverage: report.coverage, isbn: report.isbn, images: report.images }, null, 2));
console.log('PRIORITY=' + JSON.stringify(priority));
console.log(`Escrito: ${outputPath}`);
