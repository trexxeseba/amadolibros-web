// FICHAS-VIDRIERA-2 — motor de evidencia para enriquecimiento semántico masivo.
//
// Esta capa NO genera texto y NO toca el renderer. Su trabajo es decidir qué
// evidencia puede alimentar una generación editorial automática y con qué
// nivel de confianza. Separa explícitamente dos conceptos que antes estaban
// mezclados: disponibilidad comercial (active/paused) y calidad editorial.

import { normalizeValidIsbn } from './showcase-ranking.js';

export const BOOK_EVIDENCE_SOURCE_POLICY = Object.freeze({
  publisher: Object.freeze({ trust: 5, independentFamily: 'publisher', official: true }),
  author_site: Object.freeze({ trust: 5, independentFamily: 'author', official: true }),
  national_library: Object.freeze({ trust: 5, independentFamily: 'library', official: true }),
  google_books: Object.freeze({ trust: 4, independentFamily: 'google_books', official: false }),
  open_library: Object.freeze({ trust: 4, independentFamily: 'open_library', official: false }),
  library_catalog: Object.freeze({ trust: 4, independentFamily: 'library_catalog', official: false }),
  meli: Object.freeze({ trust: 3, independentFamily: 'meli', official: false }),
  distributor: Object.freeze({ trust: 3, independentFamily: 'distributor', official: false }),
  web_reference: Object.freeze({ trust: 2, independentFamily: 'web_reference', official: false }),
});

const EDITION_FIELDS = Object.freeze([
  'publisher',
  'pages',
  'language',
  'format',
  'edition',
  'publication_year',
]);

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function normalizeEvidenceText(value) {
  return clean(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function sourcePolicy(source) {
  return BOOK_EVIDENCE_SOURCE_POLICY[source] || null;
}

function compatibleIdentityText(left, right) {
  const a = normalizeEvidenceText(left);
  const b = normalizeEvidenceText(right);
  if (!a || !b) return true;
  if (a === b) return true;
  if (a.length >= 8 && b.includes(a)) return true;
  if (b.length >= 8 && a.includes(b)) return true;
  return false;
}

function normalizedComparable(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return String(value);
  return normalizeEvidenceText(value);
}

function contentLength(record) {
  return Math.max(
    clean(record.description).length,
    clean(record.summary).length,
    clean(record.author_context).length,
  );
}

function hasSubstantiveWorkContent(record) {
  const topics = Array.isArray(record.topics)
    ? record.topics.map(clean).filter(Boolean)
    : [];
  const audience = clean(record.audience);
  return clean(record.description).length >= 120 ||
    clean(record.summary).length >= 80 ||
    clean(record.author_context).length >= 80 ||
    topics.length >= 3 ||
    audience.length >= 40;
}

function normalizeRecord(record, index) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const policy = sourcePolicy(record.source);
  if (!policy) return null;

  return {
    ...record,
    _index: index,
    _policy: policy,
    isbn: normalizeValidIsbn(record.isbn),
    title: clean(record.title),
    author: clean(record.author),
    description: clean(record.description),
    summary: clean(record.summary),
    audience: clean(record.audience),
    author_context: clean(record.author_context),
    topics: Array.isArray(record.topics)
      ? record.topics.map(clean).filter(Boolean).slice(0, 12)
      : [],
  };
}

function consensusForField(records, field) {
  const candidates = records
    .map(record => record[field])
    .filter(value => value !== null && value !== undefined && clean(value));
  if (candidates.length === 0) {
    return { value: null, sourceCount: 0, conflict: false };
  }

  const groups = new Map();
  for (const value of candidates) {
    const key = normalizedComparable(value);
    if (!key) continue;
    const current = groups.get(key) || { value, count: 0 };
    current.count++;
    groups.set(key, current);
  }
  const ranked = [...groups.values()].sort((a, b) => b.count - a.count);
  if (ranked.length === 0) return { value: null, sourceCount: 0, conflict: false };

  return {
    value: ranked[0].value,
    sourceCount: candidates.length,
    conflict: ranked.length > 1,
  };
}

/**
 * Clasifica evidencia externa para una edición concreta.
 *
 * Reglas principales:
 * - los datos de EDICIÓN requieren ISBN exacto;
 * - el contenido de OBRA puede usar ISBN exacto o título+autor compatibles;
 * - dos familias de fuentes independientes permiten publicación automática;
 * - una sola fuente suficiente permite generar, pero no auto-publicar;
 * - una contradicción de identidad sobre el mismo ISBN bloquea el lote.
 */
export function classifyBookIntelligenceEvidence(item, evidenceRecords = []) {
  const itemIsbn = normalizeValidIsbn(item?.isbn);
  const itemTitle = clean(item?.title);
  const itemAuthor = clean(item?.author);
  const records = evidenceRecords
    .map(normalizeRecord)
    .filter(Boolean);

  const exactIsbnRecords = itemIsbn
    ? records.filter(record => record.isbn === itemIsbn)
    : [];

  const identityConflicts = [];
  for (const record of exactIsbnRecords) {
    if (record.title && !compatibleIdentityText(itemTitle, record.title)) {
      identityConflicts.push({ source: record.source, field: 'title', value: record.title });
    }
    if (itemAuthor && record.author && !compatibleIdentityText(itemAuthor, record.author)) {
      identityConflicts.push({ source: record.source, field: 'author', value: record.author });
    }
  }

  const workRecords = records.filter(record => {
    if (!hasSubstantiveWorkContent(record)) return false;
    if (itemIsbn && record.isbn === itemIsbn) return true;
    return compatibleIdentityText(itemTitle, record.title) &&
      compatibleIdentityText(itemAuthor, record.author) &&
      Boolean(normalizeEvidenceText(record.title));
  });

  const independentWorkFamilies = new Set(
    workRecords.map(record => record._policy.independentFamily),
  );
  const strongWorkFamilies = new Set(
    workRecords
      .filter(record => record._policy.trust >= 4)
      .map(record => record._policy.independentFamily),
  );

  const editionFacts = {};
  const editionFactConflicts = [];
  for (const field of EDITION_FIELDS) {
    const consensus = consensusForField(exactIsbnRecords, field);
    editionFacts[field] = consensus;
    if (consensus.conflict) editionFactConflicts.push(field);
  }

  let tier = 'red';
  let reason = 'insufficient_evidence';
  if (identityConflicts.length > 0) {
    tier = 'red';
    reason = 'identity_conflict';
  } else if (itemIsbn && independentWorkFamilies.size >= 2 && strongWorkFamilies.size >= 1) {
    tier = 'green';
    reason = 'multi_source_exact_identity';
  } else if (workRecords.length >= 1 && strongWorkFamilies.size >= 1) {
    tier = 'yellow';
    reason = itemIsbn ? 'single_strong_source' : 'work_identity_only';
  }

  const trustedExactEditionSources = exactIsbnRecords.filter(record => record._policy.trust >= 4);
  const editionFieldsAutoPublishable = Object.fromEntries(
    EDITION_FIELDS.map(field => {
      const fact = editionFacts[field];
      return [field, Boolean(
        fact.value &&
        !fact.conflict &&
        trustedExactEditionSources.some(record => normalizedComparable(record[field]) === normalizedComparable(fact.value))
      )];
    }),
  );

  return {
    schema_version: 1,
    product_id: clean(item?.id).toUpperCase() || null,
    isbn: itemIsbn,
    availability: item?.status === 'active' && Number(item?.available_quantity) > 0
      ? 'active'
      : 'by_request',
    tier,
    reason,
    work_source_count: workRecords.length,
    independent_work_source_count: independentWorkFamilies.size,
    strong_work_source_count: strongWorkFamilies.size,
    exact_isbn_source_count: exactIsbnRecords.length,
    identity_conflicts: identityConflicts,
    edition_fact_conflicts: editionFactConflicts,
    edition_facts: editionFacts,
    edition_fields_auto_publishable: editionFieldsAutoPublishable,
    generation_policy: {
      can_generate_work_content: tier === 'green' || tier === 'yellow',
      can_auto_publish_work_content: tier === 'green',
      can_generate_five_topics: tier === 'green' || (
        tier === 'yellow' && workRecords.some(record => record.topics.length >= 5)
      ),
      can_generate_audience: tier === 'green' || workRecords.some(record => clean(record.audience).length >= 40),
      can_generate_author_context: tier === 'green' || workRecords.some(record => clean(record.author_context).length >= 80),
    },
    diagnostics: {
      max_content_chars: workRecords.reduce((max, record) => Math.max(max, contentLength(record)), 0),
      work_sources: workRecords.map(record => record.source),
      exact_isbn_sources: exactIsbnRecords.map(record => record.source),
    },
  };
}

export function summarizeBookIntelligenceEvidence(results = []) {
  const summary = {
    total: results.length,
    green: 0,
    yellow: 0,
    red: 0,
    active: 0,
    by_request: 0,
    auto_publish_work_content: 0,
    generate_five_topics: 0,
    identity_conflicts: 0,
    edition_fact_conflicts: 0,
  };

  for (const result of results) {
    if (result?.tier in summary) summary[result.tier]++;
    if (result?.availability in summary) summary[result.availability]++;
    if (result?.generation_policy?.can_auto_publish_work_content) summary.auto_publish_work_content++;
    if (result?.generation_policy?.can_generate_five_topics) summary.generate_five_topics++;
    summary.identity_conflicts += Array.isArray(result?.identity_conflicts) ? result.identity_conflicts.length : 0;
    summary.edition_fact_conflicts += Array.isArray(result?.edition_fact_conflicts) ? result.edition_fact_conflicts.length : 0;
  }

  return summary;
}
