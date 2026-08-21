import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { normalizeIsbnToGtin } from '../../functions/feed.xml.js';

export const REPORT_SCHEMA_VERSION = 1;

const GENERIC_AUTHORS = new Set([
  'anonimo',
  'anonymous',
  'no aplica',
  'sin autor',
  'varios autores',
  'various authors',
  'vv aa',
]);

export function normalizeComparableText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isGenericAuthor(value) {
  return GENERIC_AUTHORS.has(normalizeComparableText(value));
}

function normalizeCondition(value) {
  const condition = String(value || '').trim().toLowerCase();
  return condition === 'new' || condition === 'used' ? condition : 'unknown';
}

function validCandidateItem(item) {
  return Boolean(
    item &&
    /^MLU\d+$/.test(String(item.id || '')) &&
    String(item.title || '').trim() &&
    item.status === 'active' &&
    Number(item.available_quantity) > 0
  );
}

export function pickCanonicalRepresentative(group) {
  if (!Array.isArray(group) || group.length === 0) return null;
  return [...group].sort((a, b) => {
    const qtyA = Number(a.available_quantity) || 0;
    const qtyB = Number(b.available_quantity) || 0;
    if (qtyB !== qtyA) return qtyB - qtyA;

    const rawPriceA = Number(a.price);
    const rawPriceB = Number(b.price);
    const priceA = Number.isFinite(rawPriceA) && rawPriceA > 0 ? rawPriceA : Number.POSITIVE_INFINITY;
    const priceB = Number.isFinite(rawPriceB) && rawPriceB > 0 ? rawPriceB : Number.POSITIVE_INFINITY;
    if (priceA !== priceB) return priceA - priceB;

    const idA = String(a.id || '');
    const idB = String(b.id || '');
    return idA < idB ? -1 : idA > idB ? 1 : 0;
  })[0];
}

function analyzeGroup(gtin, condition, group) {
  const normalizedTitles = group.map(item => normalizeComparableText(item.title));
  const normalizedAuthors = group.map(item => normalizeComparableText(item.author));
  const titleValues = [...new Set(normalizedTitles.filter(Boolean))].sort();
  const authorValues = [...new Set(normalizedAuthors.filter(Boolean))].sort();

  const allTitlesPresent = normalizedTitles.every(Boolean);
  const allAuthorsPresent = normalizedAuthors.every(Boolean);
  const reasons = [];

  if (!allTitlesPresent) reasons.push('title_missing');
  else if (titleValues.length !== 1) reasons.push('title_conflict');

  if (!allAuthorsPresent) reasons.push('author_missing');
  else if (authorValues.length !== 1) reasons.push('author_conflict');
  else if (isGenericAuthor(authorValues[0])) reasons.push('author_generic');

  if (condition === 'unknown') reasons.push('condition_unknown');

  const hasIdentityConflict = reasons.includes('title_conflict') || reasons.includes('author_conflict');
  const confidence = reasons.length === 0
    ? 'high'
    : hasIdentityConflict
      ? 'reject'
      : 'review';

  const representative = pickCanonicalRepresentative(group);
  const sortedIds = group.map(item => item.id).sort();
  const sourceIds = representative
    ? sortedIds.filter(id => id !== representative.id)
    : [];

  return {
    gtin,
    condition,
    confidence,
    recommended_action: confidence === 'high'
      ? 'canonical_candidate'
      : confidence === 'review'
        ? 'manual_review'
        : 'do_not_consolidate',
    reasons,
    representative_id: representative?.id || null,
    source_ids: confidence === 'high' ? sourceIds : [],
    member_ids: sortedIds,
    normalized_title: titleValues.length === 1 ? titleValues[0] : null,
    normalized_author: authorValues.length === 1 && allAuthorsPresent ? authorValues[0] : null,
  };
}

export function analyzeEditionClusters(items) {
  const input = Array.isArray(items) ? items : [];
  const groups = new Map();
  let activeInStockItems = 0;
  let validIsbnItems = 0;

  for (const item of input) {
    if (!validCandidateItem(item)) continue;
    activeInStockItems += 1;

    const isbn = normalizeIsbnToGtin(item.isbn);
    if (!isbn.valid || !isbn.gtin) continue;
    validIsbnItems += 1;

    const condition = normalizeCondition(item.condition);
    const key = `${isbn.gtin}|${condition}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  const confidenceOrder = { high: 0, review: 1, reject: 2 };
  const clusters = [];
  for (const [key, group] of groups.entries()) {
    if (group.length < 2) continue;
    const separator = key.lastIndexOf('|');
    const gtin = key.slice(0, separator);
    const condition = key.slice(separator + 1);
    clusters.push(analyzeGroup(gtin, condition, group));
  }

  clusters.sort((a, b) =>
    (confidenceOrder[a.confidence] - confidenceOrder[b.confidence]) ||
    a.gtin.localeCompare(b.gtin) ||
    a.condition.localeCompare(b.condition)
  );

  const high = clusters.filter(cluster => cluster.confidence === 'high');
  const review = clusters.filter(cluster => cluster.confidence === 'review');
  const reject = clusters.filter(cluster => cluster.confidence === 'reject');

  return {
    schema_version: REPORT_SCHEMA_VERSION,
    stats: {
      input_items: input.length,
      active_in_stock_items: activeInStockItems,
      valid_isbn_items: validIsbnItems,
      duplicate_groups: clusters.length,
      high_confidence_groups: high.length,
      review_groups: review.length,
      rejected_groups: reject.length,
      canonical_candidate_sources: high.reduce((sum, cluster) => sum + cluster.source_ids.length, 0),
    },
    clusters,
  };
}

export function stableReportJson(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

async function runCli() {
  const [, , inputPath, outputPath] = process.argv;
  if (!inputPath) {
    throw new Error('Uso: node scripts/seo/edition-consolidation-candidates.mjs <catalog.json> [report.json]');
  }

  const raw = await fs.readFile(inputPath);
  const parsed = JSON.parse(raw.toString('utf8'));
  const items = Array.isArray(parsed) ? parsed : parsed?.items;
  if (!Array.isArray(items)) {
    throw new Error('El input debe ser un array o un objeto con items[].');
  }

  const report = analyzeEditionClusters(items);
  report.source = {
    file: inputPath,
    sha256: crypto.createHash('sha256').update(raw).digest('hex'),
    updated_at: typeof parsed?.updated_at === 'string' ? parsed.updated_at : null,
  };

  const output = stableReportJson(report);
  if (outputPath) await fs.writeFile(outputPath, output, 'utf8');
  else process.stdout.write(output);
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  runCli().catch(error => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
