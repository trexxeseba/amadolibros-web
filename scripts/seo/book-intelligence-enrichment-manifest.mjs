// FICHAS-VIDRIERA-2 / ENRICHMENT-MANIFEST-1
//
// Convierte una clasificación de evidencia en un contrato pequeño y auditable
// para fases posteriores. NO genera prosa y NO toca el renderer público.
//
// Principios:
// - GREEN => auto_publish a nivel de obra; YELLOW => review; RED => hold.
// - Los temas salen únicamente del snapshot oficial/curado que se entrega a
//   este builder; Google Books puede corroborar confianza pero no aporta copy.
// - Los hechos de edición sólo entran si el motor canónico los marcó como
//   auto-publicables y se conserva provenance por campo.
// - Nunca se incluyen description/summary/author_context externos.

import {
  BOOK_EVIDENCE_SOURCE_POLICY,
  normalizeEvidenceText,
} from '../../functions/_shared/book-intelligence-evidence.js';
import { normalizeValidIsbn } from '../../functions/_shared/showcase-ranking.js';

export const ENRICHMENT_DECISIONS = Object.freeze({
  green: 'auto_publish',
  yellow: 'review',
  red: 'hold',
});

const MAX_TOPICS = 8;
const MAX_TOPIC_LENGTH = 80;
const MAX_AUDIENCE_LENGTH = 180;

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function comparable(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return String(value);
  return normalizeEvidenceText(value);
}

function dedupeStable(values, { max = Infinity, maxLength = Infinity } = {}) {
  const output = [];
  const seen = new Set();
  for (const raw of values || []) {
    const value = clean(raw);
    if (!value || value.length > maxLength) continue;
    const key = normalizeEvidenceText(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(value);
    if (output.length >= max) break;
  }
  return output;
}

function sourceProvider(record) {
  return clean(record?.source_provider) || clean(record?.source) || 'unknown';
}

function relationshipFor(record, targetIsbn) {
  const recordIsbn = normalizeValidIsbn(record?.isbn);
  if (targetIsbn && recordIsbn === targetIsbn) return 'exact_edition';
  return 'same_work';
}

function compactSource(record, targetIsbn) {
  const source = clean(record?.source);
  const policy = BOOK_EVIDENCE_SOURCE_POLICY[source] || null;
  const url = clean(record?.source_url);
  return {
    source,
    provider: sourceProvider(record),
    relationship: relationshipFor(record, targetIsbn),
    isbn: normalizeValidIsbn(record?.isbn),
    url: /^https:\/\//i.test(url) ? url : null,
    verified_at: clean(record?.verified_at) || null,
    trust: policy?.trust ?? null,
    official: Boolean(policy?.official),
  };
}

function sourceSortKey(source) {
  return [source.source, source.provider, source.relationship, source.isbn || '', source.url || ''].join('|');
}

function compactSources(records, targetIsbn) {
  const seen = new Set();
  const output = [];
  for (const record of records || []) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
    const source = compactSource(record, targetIsbn);
    if (!source.source) continue;
    const key = sourceSortKey(source);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(source);
  }
  return output.sort((a, b) => sourceSortKey(a).localeCompare(sourceSortKey(b)));
}

function officialTopicSeeds(officialRecords, classification) {
  if (!classification?.generation_policy?.can_generate_five_topics) return [];
  const topics = [];
  for (const record of officialRecords || []) {
    for (const topic of Array.isArray(record?.topics) ? record.topics : []) topics.push(topic);
  }
  return dedupeStable(topics, { max: MAX_TOPICS, maxLength: MAX_TOPIC_LENGTH });
}

function officialAudienceSeed(officialRecords, classification) {
  if (!classification?.generation_policy?.can_generate_audience) return null;
  const candidates = dedupeStable(
    (officialRecords || []).map(record => record?.audience),
    { max: 1, maxLength: MAX_AUDIENCE_LENGTH },
  );
  return candidates[0] || null;
}

function editionProvenance(field, value, allRecords, targetIsbn) {
  const valueKey = comparable(value);
  if (!valueKey || !targetIsbn) return [];
  return compactSources(
    (allRecords || []).filter(record => {
      const policy = BOOK_EVIDENCE_SOURCE_POLICY[record?.source];
      return policy?.trust >= 4 &&
        normalizeValidIsbn(record?.isbn) === targetIsbn &&
        comparable(record?.[field]) === valueKey;
    }),
    targetIsbn,
  );
}

function allowedEditionFacts(classification, allRecords, targetIsbn) {
  const output = {};
  const allowed = classification?.edition_fields_auto_publishable || {};
  const facts = classification?.edition_facts || {};
  for (const field of Object.keys(allowed).sort()) {
    if (!allowed[field]) continue;
    const value = facts?.[field]?.value;
    if (value === null || value === undefined || clean(value) === '') continue;
    const provenance = editionProvenance(field, value, allRecords, targetIsbn);
    if (provenance.length === 0) continue;
    output[field] = { value, provenance };
  }
  return output;
}

function compactConflict(conflict) {
  if (!conflict || typeof conflict !== 'object') return null;
  return {
    source: clean(conflict.source) || null,
    field: clean(conflict.field) || null,
    value: clean(conflict.value) || null,
  };
}

export function buildBookIntelligenceManifestEntry({
  item,
  classification,
  officialRecords = [],
  allRecords = officialRecords,
} = {}) {
  if (!item || typeof item !== 'object') throw new TypeError('item debe ser un objeto.');
  if (!classification || typeof classification !== 'object') throw new TypeError('classification debe ser un objeto.');

  const productId = clean(item.id).toUpperCase();
  const isbn = normalizeValidIsbn(item.isbn);
  const tier = ['green', 'yellow', 'red'].includes(classification.tier)
    ? classification.tier
    : 'red';
  const decision = ENRICHMENT_DECISIONS[tier];
  const topics = decision === 'hold'
    ? []
    : officialTopicSeeds(officialRecords, classification);
  const audience = decision === 'hold'
    ? null
    : officialAudienceSeed(officialRecords, classification);
  const edition = decision === 'hold'
    ? {}
    : allowedEditionFacts(classification, allRecords, isbn);
  const sources = compactSources(allRecords, isbn);

  const identityConflicts = (classification.identity_conflicts || [])
    .map(compactConflict)
    .filter(Boolean);
  const blockedEditionFields = [...new Set(classification.edition_fact_conflicts || [])].sort();

  return {
    schema_version: 1,
    product_id: productId || null,
    isbn,
    availability: classification.availability || null,
    tier,
    decision,
    work: {
      can_generate: Boolean(classification?.generation_policy?.can_generate_work_content),
      auto_publish: decision === 'auto_publish' && Boolean(classification?.generation_policy?.can_auto_publish_work_content),
      review_required: decision === 'review',
      topic_seeds: topics,
      audience_seed: audience,
    },
    edition: {
      auto_publishable_fields: edition,
      blocked_fields: blockedEditionFields,
    },
    provenance: sources,
    review: {
      required: decision === 'review' || identityConflicts.length > 0 || blockedEditionFields.length > 0,
      identity_conflicts: identityConflicts,
      edition_fact_conflicts: blockedEditionFields,
    },
  };
}

export function buildBookIntelligenceManifest(entries = [], {
  generatedAt = new Date().toISOString(),
  catalogVersion = null,
} = {}) {
  const rows = [...entries]
    .filter(entry => entry && typeof entry === 'object')
    .sort((a, b) => String(a.product_id || '').localeCompare(String(b.product_id || '')));

  const counts = { total: rows.length, auto_publish: 0, review: 0, hold: 0 };
  for (const row of rows) {
    if (Object.hasOwn(counts, row.decision)) counts[row.decision]++;
  }

  return {
    schema_version: 1,
    generated_at: generatedAt,
    catalog_version: clean(catalogVersion) || null,
    counts,
    entries: rows,
  };
}
