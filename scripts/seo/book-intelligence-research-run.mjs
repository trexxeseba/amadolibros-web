#!/usr/bin/env node

// FICHAS-ENRICHMENT-1000-ISBN-1
// Investiga 1.000 EDICIONES activas y vendibles, agrupadas por ISBN-13.
// No escribe en Produccion ni inventa contenido: genera un manifiesto por
// campo, listo para revision e integracion en el gateway de #247.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { CATALOG_URL } from '../../functions/_shared/catalog.js';
import { listBookEnrichments } from '../../functions/_shared/book-enrichment-registry.js';
import {
  classifyBookIntelligenceEvidence,
  summarizeBookIntelligenceEvidence,
} from '../../functions/_shared/book-intelligence-evidence.js';
import { isGenericAuthor, isShowcaseEligible, normalizeValidIsbn } from '../../functions/_shared/showcase-ranking.js';
import { fetchBneEvidence } from './book-intelligence-bne.mjs';
import {
  chunkOpenLibraryPlan,
  emptySourceCache,
  fetchGoogleBooksEvidence,
  fetchOpenLibraryBatchEvidence,
  mergeSourceCache,
  planBookSourceResearch,
} from './book-intelligence-sources.mjs';

const DEFAULT_LIMIT = 1000;
const DEFAULT_OUTPUT_DIR = 'artifacts/book-intelligence/isbn-1000';
const DEFAULT_CACHE_PATH = 'artifacts/book-intelligence/isbn-1000/source-cache.json';
const DEFAULT_OPEN_LIBRARY_CONTACT = 'https://www.amadolibros.com';
const EDITION_FIELDS = Object.freeze([
  'author',
  'publisher', 'pages', 'language', 'format', 'edition', 'publication_year',
]);

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function descriptionLength(item) {
  return clean(item?.description).length;
}

function candidateScore(item, listingCount) {
  const stock = Math.max(0, Number(item?.available_quantity) || 0);
  const description = descriptionLength(item);
  let score = Math.min(stock, 100) * 10 + Math.min(listingCount, 10) * 25;
  if (description < 80) score += 1200;
  else if (description < 280) score += 700;
  else if (description < 700) score += 300;
  if (isGenericAuthor(item?.author)) score += 250;
  if (!clean(item?.publisher)) score += 160;
  if (!(Number(item?.pages) > 0)) score += 120;
  return score;
}

function compareRepresentatives(a, b) {
  return Number(b?.available_quantity || 0) - Number(a?.available_quantity || 0) ||
    descriptionLength(b) - descriptionLength(a) ||
    clean(a?.id).localeCompare(clean(b?.id));
}

/**
 * Seleccion reproducible: 1.000 ISBN distintos, activos, con stock y contrato
 * de libro. Se priorizan fichas pobres y ediciones con mas stock o duplicados.
 * Las ediciones ya verificadas por #247 no gastan cupo.
 */
export function selectResearchCohort({
  catalogItems = [],
  existingEnrichments = [],
  limit = DEFAULT_LIMIT,
} = {}) {
  const requestedLimit = nonNegativeInteger(limit, DEFAULT_LIMIT);
  const alreadyEnriched = new Set(
    (Array.isArray(existingEnrichments) ? existingEnrichments : [])
      .map(record => normalizeValidIsbn(record?.isbn))
      .filter(Boolean),
  );
  const byIsbn = new Map();

  for (const item of Array.isArray(catalogItems) ? catalogItems : []) {
    if (!isShowcaseEligible(item)) continue;
    const isbn = normalizeValidIsbn(item?.isbn);
    if (!isbn || alreadyEnriched.has(isbn)) continue;
    if (!byIsbn.has(isbn)) byIsbn.set(isbn, []);
    byIsbn.get(isbn).push(item);
  }

  const candidates = [...byIsbn.entries()].map(([isbn, listings]) => {
    const representative = [...listings].sort(compareRepresentatives)[0];
    const totalStock = listings.reduce(
      (sum, item) => sum + Math.max(0, Number(item?.available_quantity) || 0),
      0,
    );
    return {
      ...representative,
      isbn,
      listing_ids: listings.map(item => clean(item?.id).toUpperCase()).sort(),
      listing_count: listings.length,
      total_stock: totalStock,
      priority_score: candidateScore(representative, listings.length),
      research: {
        cohort_source: 'active_sellable_unique_isbn',
        description_length: descriptionLength(representative),
      },
    };
  }).sort((a, b) =>
    b.priority_score - a.priority_score ||
    b.total_stock - a.total_stock ||
    a.isbn.localeCompare(b.isbn),
  );

  if (requestedLimit > 0 && candidates.length < requestedLimit) {
    throw new Error(`ISBN-1000 resolvio ${candidates.length}/${requestedLimit} ediciones activas y vendibles.`);
  }

  return {
    selected: requestedLimit > 0 ? candidates.slice(0, requestedLimit) : candidates,
    eligible_unique_isbns: candidates.length,
    excluded_already_enriched: alreadyEnriched.size,
  };
}

async function readJson(source) {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`${source} respondio HTTP ${response.status}`);
    return response.json();
  }
  return JSON.parse(await readFile(source, 'utf8'));
}

async function loadCache(filePath) {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8'));
    return parsed?.entries && typeof parsed.entries === 'object' ? parsed : emptySourceCache();
  } catch (error) {
    if (error?.code === 'ENOENT') return emptySourceCache();
    throw error;
  }
}

async function saveCache(filePath, cache) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(cache, null, 2)}\n`);
}

function recordsFor(cache, isbn) {
  const entry = cache?.entries?.[isbn] || {};
  return [
    ...(Array.isArray(entry.google_books?.records) ? entry.google_books.records : []),
    ...(Array.isArray(entry.open_library?.records) ? entry.open_library.records : []),
    ...(Array.isArray(entry.bne?.records) ? entry.bne.records : []),
  ];
}

function sourceState(cache, isbn, source) {
  const entry = cache?.entries?.[isbn]?.[source] || null;
  return {
    fetched_at: entry?.fetched_at || null,
    error: entry?.error || null,
    record_count: Array.isArray(entry?.records) ? entry.records.length : 0,
  };
}

function existingFact(item, field) {
  const bibliography = item?.bibliographic && typeof item.bibliographic === 'object'
    ? item.bibliographic
    : {};
  if (field === 'author') return isGenericAuthor(item?.author) ? null : clean(item?.author);
  if (field === 'publisher') return clean(item?.publisher) || null;
  if (field === 'pages') return Number(item?.pages) > 0 ? Number(item.pages) : null;
  return clean(bibliography[field]) || null;
}

function verifiedFacts(classification, item = null) {
  return Object.fromEntries(EDITION_FIELDS.flatMap(field => {
    const publishable = classification?.edition_fields_auto_publishable?.[field];
    const value = classification?.edition_facts?.[field]?.value;
    // La proyección masiva completa ausencias. No sobreescribe un dato
    // existente que difiera: ese caso necesita revisión humana por edición.
    const current = item ? existingFact(item, field) : null;
    return publishable && !current && value !== null && value !== undefined && clean(value)
      ? [[field, value]]
      : [];
  }));
}

export function publicationClass(classification, facts = verifiedFacts(classification)) {
  if ((classification?.identity_conflicts?.length || 0) > 0 ||
      (classification?.edition_fact_conflicts?.length || 0) > 0) return 'REVIEW';
  if (Object.keys(facts).length > 0 && classification?.generation_policy?.can_auto_publish_work_content) return 'GREEN_FULL';
  if (Object.keys(facts).length > 0) return 'GREEN_FACTS';
  return 'NO_EVIDENCE';
}

export function buildResearchResult(item, classification, cache) {
  const facts = verifiedFacts(classification, item);
  return {
    id: clean(item?.id).toUpperCase(),
    isbn: clean(item?.isbn),
    title: clean(item?.title),
    author: isGenericAuthor(item?.author) ? null : clean(item?.author),
    listing_ids: Array.isArray(item?.listing_ids) ? item.listing_ids : [clean(item?.id).toUpperCase()],
    listing_count: Number(item?.listing_count) || 1,
    total_stock: Number(item?.total_stock) || Number(item?.available_quantity) || 0,
    priority_score: Number(item?.priority_score) || 0,
    description_length: Number(item?.research?.description_length) || descriptionLength(item),
    tier: classification.tier,
    reason: classification.reason,
    publication_class: publicationClass(classification, facts),
    verified_facts: facts,
    exact_isbn_source_count: classification.exact_isbn_source_count,
    independent_work_source_count: classification.independent_work_source_count,
    identity_conflicts: classification.identity_conflicts,
    edition_fact_conflicts: classification.edition_fact_conflicts,
    sources: {
      google_books: sourceState(cache, item.isbn, 'google_books'),
      open_library: sourceState(cache, item.isbn, 'open_library'),
      bne: sourceState(cache, item.isbn, 'bne'),
    },
  };
}

function sourceSummary(results, source) {
  return {
    fetched: results.filter(result => result.sources[source].fetched_at).length,
    matched: results.filter(result => result.sources[source].record_count > 0).length,
    no_match: results.filter(result => result.sources[source].fetched_at && !result.sources[source].error && result.sources[source].record_count === 0).length,
    errors: results.filter(result => result.sources[source].error).length,
  };
}

function classSummary(results) {
  const summary = Object.fromEntries(['GREEN_FULL', 'GREEN_FACTS', 'REVIEW', 'NO_EVIDENCE']
    .map(status => [status, results.filter(result => result.publication_class === status).length]));
  summary.updated_count = summary.GREEN_FULL + summary.GREEN_FACTS;
  summary.remaining_to_1000 = Math.max(0, 1000 - summary.updated_count);
  summary.target_reached = summary.updated_count >= 1000;
  return summary;
}

export function buildVerifiedFactsManifest(report) {
  const publishable = report.results
    .filter(result => ['GREEN_FULL', 'GREEN_FACTS'].includes(result.publication_class))
    .filter(result => Object.keys(result.verified_facts || {}).length > 0)
    .slice(0, report.cohort.requested);
  return {
    schema_version: 1,
    generated_at: report.generated_at,
    cohort: {
      requested: report.cohort.requested,
      researched: report.cohort.selected,
      selected_updates: publishable.length,
      unique_isbn: true,
      scope: 'active_sellable_editions',
    },
    metrics: report.publication,
    entries: publishable.map(result => ({
      isbn: result.isbn,
      representative_id: result.id,
      listing_ids: result.listing_ids,
      title: result.title,
      author: result.author,
      decision: result.publication_class,
      facts: result.verified_facts,
      evidence: {
        exact_isbn_source_count: result.exact_isbn_source_count,
        google_books_records: result.sources.google_books.record_count,
        open_library_records: result.sources.open_library.record_count,
        bne_records: result.sources.bne.record_count,
      },
      conflicts: {
        identity: result.identity_conflicts,
        edition_fields: result.edition_fact_conflicts,
      },
    })),
  };
}

export function researchMarkdown(report) {
  const p = report.publication;
  return `${[
    '# FICHAS-ENRICHMENT-1000-ISBN-1',
    '',
    `- Generado: ${report.generated_at}`,
    `- Meta: ${report.cohort.requested} ISBN con mejoras verificadas.`,
    `- Investigados: ${report.cohort.selected} ISBN unicos, activos y vendibles.`,
    `- Elegibles antes del corte: ${report.cohort.eligible_unique_isbns}.`,
    `- Google Books: ${report.sources.google_books.matched}/${report.cohort.selected} matches exactos; ${report.sources.google_books.errors} errores.`,
    `- Open Library: ${report.sources.open_library.matched}/${report.cohort.selected} matches exactos; ${report.sources.open_library.errors} errores.`,
    `- BNE: ${report.sources.bne.matched}/${report.cohort.selected} matches exactos; ${report.sources.bne.errors} errores.`,
    `- GREEN_FULL: ${p.GREEN_FULL}.`,
    `- GREEN_FACTS: ${p.GREEN_FACTS}.`,
    `- REVIEW: ${p.REVIEW}.`,
    `- NO_EVIDENCE: ${p.NO_EVIDENCE}.`,
    `- Actualizados con evidencia: ${p.updated_count}/1000.`,
    `- Restantes para la meta: ${p.remaining_to_1000}.`,
    '',
    '## Contrato',
    '',
    '- La unidad es la edicion por ISBN-13, no la publicacion MLU.',
    '- Se publican hechos campo por campo; nunca se copia una sinopsis externa.',
    '- Precio, stock, condicion, imagenes, slug y canonical no se modifican.',
    '- Esta corrida genera un artefacto revisable; no despliega Produccion.',
  ].join('\n')}\n`;
}

export async function mapWithConcurrency(values, concurrency, worker) {
  const items = Array.isArray(values) ? values : [];
  const output = new Array(items.length);
  let next = 0;
  async function consume() {
    while (next < items.length) {
      const index = next++;
      output[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length || 1) }, consume));
  return output;
}

function cliOptions(argv) {
  const options = {
    limit: positiveInteger(process.env.BOOK_INTELLIGENCE_LIMIT, DEFAULT_LIMIT),
    candidateLimit: nonNegativeInteger(process.env.BOOK_INTELLIGENCE_CANDIDATE_LIMIT, 0),
    outputDir: process.env.BOOK_INTELLIGENCE_OUTPUT_DIR || DEFAULT_OUTPUT_DIR,
    cachePath: process.env.BOOK_INTELLIGENCE_CACHE_PATH || DEFAULT_CACHE_PATH,
    catalogSource: process.env.BOOK_INTELLIGENCE_CATALOG_SOURCE || CATALOG_URL,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--limit') options.limit = positiveInteger(argv[++index], DEFAULT_LIMIT);
    else if (flag === '--candidate-limit') options.candidateLimit = nonNegativeInteger(argv[++index], 0);
    else if (flag === '--output-dir') options.outputDir = argv[++index];
    else if (flag === '--cache') options.cachePath = argv[++index];
    else if (flag === '--catalog') options.catalogSource = argv[++index];
    else throw new Error(`Argumento desconocido: ${flag}`);
  }
  return options;
}

export async function runResearch({
  limit = DEFAULT_LIMIT,
  candidateLimit = nonNegativeInteger(process.env.BOOK_INTELLIGENCE_CANDIDATE_LIMIT, 0),
  outputDir = DEFAULT_OUTPUT_DIR,
  cachePath = DEFAULT_CACHE_PATH,
  catalogSource = CATALOG_URL,
  googleBooksAccessToken = process.env.GOOGLE_BOOKS_ACCESS_TOKEN,
  googleBooksApiKey = process.env.GOOGLE_BOOKS_API_KEY,
  openLibraryContact = process.env.OPEN_LIBRARY_CONTACT || DEFAULT_OPEN_LIBRARY_CONTACT,
  googleConcurrency = positiveInteger(process.env.GOOGLE_BOOKS_CONCURRENCY, 1),
  googleBudget = positiveInteger(process.env.GOOGLE_BOOKS_BUDGET, 1000),
  googleDelayMs = nonNegativeInteger(process.env.GOOGLE_BOOKS_DELAY_MS, 1100),
  googleRetryAttempts = positiveInteger(process.env.GOOGLE_BOOKS_RETRY_ATTEMPTS, 2),
  openLibraryConcurrency = positiveInteger(process.env.OPEN_LIBRARY_CONCURRENCY, 2),
  openLibraryBudget = positiveInteger(process.env.OPEN_LIBRARY_BUDGET, 4000),
  bneBudget = positiveInteger(process.env.BNE_BUDGET, 4000),
  bneConcurrency = positiveInteger(process.env.BNE_CONCURRENCY, 2),
  bneDelayMs = nonNegativeInteger(process.env.BNE_DELAY_MS, 500),
} = {}) {
  if (!clean(googleBooksAccessToken) && !clean(googleBooksApiKey)) {
    throw new Error('ISBN-1000 requiere GOOGLE_BOOKS_ACCESS_TOKEN o GOOGLE_BOOKS_API_KEY.');
  }

  const catalog = await readJson(catalogSource);
  const cohort = selectResearchCohort({
    catalogItems: catalog?.items,
    existingEnrichments: listBookEnrichments(),
    // Cero significa “todos los elegibles”. La meta sigue siendo `limit`:
    // investigamos más candidatos hasta obtener 1.000 actualizaciones reales.
    limit: candidateLimit,
  });
  const selected = cohort.selected;

  let cache = await loadCache(cachePath);
  const plan = planBookSourceResearch(selected, cache, {
    googleBooksBudget: Math.min(selected.length, googleBudget),
    openLibraryBudget: Math.min(selected.length, openLibraryBudget),
    bneBudget: Math.min(selected.length, bneBudget),
  });

  let googleConsecutiveRateLimits = 0;
  let googleCircuitOpen = false;

  // Las fuentes corren en paralelo entre sí, manteniendo sus límites internos.
  // Así la BNE no espera a Google y el lote completo cabe en una sola Action.
  const [googleAttempts, openLibraryAttempts, bneAttempts] = await Promise.all([
    mapWithConcurrency(plan.google_books, googleConcurrency, async entry => {
      if (googleCircuitOpen) {
        return { isbn: entry.isbn, ok: false, skipped: true, error: 'Google Books circuit open after repeated HTTP 429' };
      }
      try {
        const records = await fetchGoogleBooksEvidence(entry.isbn, {
          accessToken: googleBooksAccessToken,
          apiKey: googleBooksApiKey,
          retryAttempts: googleRetryAttempts,
        });
        googleConsecutiveRateLimits = 0;
        cache = mergeSourceCache(cache, entry.isbn, 'google_books', records);
        return { isbn: entry.isbn, ok: true, records: records.length };
      } catch (error) {
        if (/HTTP 429/.test(error?.message || '')) {
          googleConsecutiveRateLimits += 1;
          if (googleConsecutiveRateLimits >= 20) googleCircuitOpen = true;
        } else {
          googleConsecutiveRateLimits = 0;
        }
        cache = mergeSourceCache(cache, entry.isbn, 'google_books', [], { error: error?.message || String(error) });
        return { isbn: entry.isbn, ok: false, error: error?.message || String(error) };
      } finally {
        if (googleDelayMs > 0) await new Promise(resolve => setTimeout(resolve, googleDelayMs));
      }
    }),
    mapWithConcurrency(chunkOpenLibraryPlan(plan), openLibraryConcurrency, async chunk => {
      const isbns = chunk.map(entry => entry.isbn);
      try {
        const records = await fetchOpenLibraryBatchEvidence(isbns, { contact: openLibraryContact });
        return isbns.map(isbn => ({ isbn, ok: true, records: records.filter(record => record.isbn === isbn) }));
      } catch (error) {
        return isbns.map(isbn => ({ isbn, ok: false, records: [], error: error?.message || String(error) }));
      }
    }).then(attempts => attempts.flat()),
    mapWithConcurrency(plan.bne, bneConcurrency, async entry => {
      try {
        const records = await fetchBneEvidence(entry.isbn);
        cache = mergeSourceCache(cache, entry.isbn, 'bne', records);
        return { isbn: entry.isbn, ok: true, records: records.length };
      } catch (error) {
        cache = mergeSourceCache(cache, entry.isbn, 'bne', [], { error: error?.message || String(error) });
        return { isbn: entry.isbn, ok: false, error: error?.message || String(error) };
      } finally {
        if (bneDelayMs > 0) await new Promise(resolve => setTimeout(resolve, bneDelayMs));
      }
    }),
  ]);
  for (const attempt of openLibraryAttempts) {
    cache = mergeSourceCache(cache, attempt.isbn, 'open_library', attempt.records, { error: attempt.error });
  }
  await saveCache(cachePath, cache);

  const classifications = selected.map(item =>
    classifyBookIntelligenceEvidence(item, recordsFor(cache, item.isbn)),
  );
  const results = selected.map((item, index) => buildResearchResult(item, classifications[index], cache));
  const generatedAt = new Date().toISOString();
  const report = {
    schema_version: 2,
    run: 'FICHAS-ENRICHMENT-1000-ISBN-1',
    generated_at: generatedAt,
    cohort: {
      requested: positiveInteger(limit, DEFAULT_LIMIT),
      selected: selected.length,
      eligible_unique_isbns: cohort.eligible_unique_isbns,
      excluded_already_enriched: cohort.excluded_already_enriched,
    },
    catalog: {
      source: catalogSource,
      updated_at: catalog?.updated_at || null,
      total_items: Array.isArray(catalog?.items) ? catalog.items.length : 0,
    },
    plan: {
      google_books_requests: plan.google_books.length,
      open_library_isbns: plan.open_library.length,
      cached_google_books: plan.cached_google_books,
      cached_open_library: plan.cached_open_library,
      bne_requests: plan.bne.length,
      cached_bne: plan.cached_bne,
    },
    execution: {
      google_books_http_successes: googleAttempts.filter(attempt => attempt.ok).length,
      google_books_errors: googleAttempts.filter(attempt => !attempt.ok).length,
      open_library_isbn_successes: openLibraryAttempts.filter(attempt => attempt.ok).length,
      open_library_errors: openLibraryAttempts.filter(attempt => !attempt.ok).length,
      bne_http_successes: bneAttempts.filter(attempt => attempt.ok).length,
      bne_errors: bneAttempts.filter(attempt => !attempt.ok).length,
    },
    sources: {
      google_books: sourceSummary(results, 'google_books'),
      open_library: sourceSummary(results, 'open_library'),
      bne: sourceSummary(results, 'bne'),
    },
    evidence: summarizeBookIntelligenceEvidence(classifications),
    publication: classSummary(results),
    results,
  };

  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, 'isbn-1000-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(outputDir, 'isbn-1000-manifest.json'), `${JSON.stringify(buildVerifiedFactsManifest(report), null, 2)}\n`);
  await writeFile(path.join(outputDir, 'report-summary.md'), researchMarkdown(report));

  return report;
}

async function main() {
  const options = cliOptions(process.argv.slice(2));
  const report = await runResearch(options);
  console.log(JSON.stringify({
    run: report.run,
    cohort: report.cohort,
    sources: report.sources,
    publication: report.publication,
  }, null, 2));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error(`[isbn-1000] ERROR: ${error?.message || error}`);
    process.exit(1);
  });
}
