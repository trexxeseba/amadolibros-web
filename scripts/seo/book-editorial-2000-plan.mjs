#!/usr/bin/env node

// B11 / EDITORIAL-REAL-2000-1
// Selecciona 2.000 ediciones activas para enriquecimiento editorial real.
//
// Contrato absoluto pedido por Seba:
// - el contenido se comparte por ISBN, pero cada publicación conserva su
//   título comercial exacto, aunque otro MLU del mismo ISBN tenga otro título;
// - la salida editorial no puede contener title, seo_title, H1, slug, canonical
//   ni ningún dato comercial;
// - el runtime toma el <title> de item.title para la publicación concreta;
// - precio, stock, imágenes, condición y URL comercial quedan fuera del lote.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { CATALOG_URL } from '../../functions/_shared/catalog.js';
import { listBookEnrichments } from '../../functions/_shared/book-enrichment-registry.js';
import {
  isGenericAuthor,
  isShowcaseEligible,
  normalizeValidIsbn,
} from '../../functions/_shared/showcase-ranking.js';

export const DEFAULT_EDITORIAL_BATCH_LIMIT = 2000;
export const DEFAULT_EDITORIAL_OUTPUT_DIR = 'artifacts/book-editorial/isbn-2000';
export const TITLE_POLICY_VERSION = 2;

const FORBIDDEN_OUTPUT_KEYS = new Set([
  'title',
  'seo_title',
  'title_override',
  'merchant_title',
  'document_title',
  'html_title',
  'h1',
  'slug',
  'canonical',
  'canonical_url',
  'price',
  'stock',
  'available_quantity',
  'pictures',
  'thumbnail',
  'condition',
  'permalink',
]);

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function titleFingerprint(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

export function isEditorialReal(record) {
  if (!record || record.decision !== 'auto_publish') return false;
  const paragraphs = Array.isArray(record?.editorial?.paragraphs)
    ? record.editorial.paragraphs.map(clean).filter(Boolean)
    : [];
  const highlights = Array.isArray(record?.editorial?.highlights)
    ? record.editorial.highlights.map(clean).filter(Boolean)
    : [];
  return paragraphs.length >= 2 &&
    paragraphs.join(' ').length >= 350 &&
    highlights.length >= 5 &&
    clean(record?.editorial?.decision_copy).length >= 120 &&
    clean(record?.editorial?.meta_description).length >= 70 &&
    clean(record?.editorial?.merchant_description).length >= 180;
}

function descriptionLength(item) {
  return clean(item?.description).length;
}

function representativeSort(a, b) {
  return Number(b?.available_quantity || 0) - Number(a?.available_quantity || 0) ||
    descriptionLength(a) - descriptionLength(b) ||
    clean(a?.id).localeCompare(clean(b?.id));
}

function missingBibliographicCount(item) {
  const bibliography = item?.bibliographic && typeof item.bibliographic === 'object'
    ? item.bibliographic
    : {};
  return [
    isGenericAuthor(item?.author),
    !clean(item?.publisher),
    !(Number(item?.pages) > 0),
    !clean(bibliography.language),
    !clean(bibliography.format),
    !Array.isArray(bibliography.subjects) || bibliography.subjects.length < 3,
  ].filter(Boolean).length;
}

function candidateScore(listings, existingRecord) {
  const representative = [...listings].sort(representativeSort)[0];
  const totalStock = listings.reduce(
    (sum, item) => sum + Math.max(0, Number(item?.available_quantity) || 0),
    0,
  );
  const description = descriptionLength(representative);

  let score = 0;
  // Primero corregimos las fichas que hoy figuran como enriquecidas pero sólo
  // tienen datos bibliográficos. Después entran las todavía no investigadas.
  if (existingRecord?.decision === 'auto_publish_facts') score += 5000;
  if (description < 80) score += 1600;
  else if (description < 280) score += 900;
  else if (description < 700) score += 350;
  score += missingBibliographicCount(representative) * 180;
  score += Math.min(totalStock, 100) * 8;
  score += Math.min(listings.length, 10) * 35;
  return score;
}

function titleSnapshots(listings) {
  return [...listings]
    .map(item => ({
      product_id: clean(item?.id).toUpperCase(),
      title: String(item?.title ?? ''),
      sha256: titleFingerprint(item?.title),
    }))
    .sort((a, b) => a.product_id.localeCompare(b.product_id));
}

export function selectEditorialBatch({
  catalogItems = [],
  enrichmentRecords = [],
  limit = DEFAULT_EDITORIAL_BATCH_LIMIT,
} = {}) {
  const requested = positiveInteger(limit, DEFAULT_EDITORIAL_BATCH_LIMIT);
  const enrichments = new Map(
    (Array.isArray(enrichmentRecords) ? enrichmentRecords : [])
      .map(record => [normalizeValidIsbn(record?.isbn), record])
      .filter(([isbn]) => isbn),
  );

  const byIsbn = new Map();
  for (const item of Array.isArray(catalogItems) ? catalogItems : []) {
    if (!isShowcaseEligible(item)) continue;
    const isbn = normalizeValidIsbn(item?.isbn);
    if (!isbn) continue;
    if (!byIsbn.has(isbn)) byIsbn.set(isbn, []);
    byIsbn.get(isbn).push(item);
  }

  const excluded = {
    already_editorial_real: 0,
  };
  const candidates = [];

  for (const [isbn, listings] of byIsbn) {
    const existingRecord = enrichments.get(isbn) || null;
    if (isEditorialReal(existingRecord)) {
      excluded.already_editorial_real += 1;
      continue;
    }

    const snapshots = titleSnapshots(listings);
    if (!snapshots.length || snapshots.some(snapshot => !snapshot.product_id || !snapshot.title)) continue;

    const representative = [...listings].sort(representativeSort)[0];
    const representativeSnapshot = snapshots.find(
      snapshot => snapshot.product_id === clean(representative?.id).toUpperCase(),
    ) || snapshots[0];
    const totalStock = listings.reduce(
      (sum, item) => sum + Math.max(0, Number(item?.available_quantity) || 0),
      0,
    );

    candidates.push({
      isbn,
      representative_id: clean(representative?.id).toUpperCase(),
      representative_title_snapshot: representativeSnapshot.title,
      representative_title_sha256: representativeSnapshot.sha256,
      listing_ids: snapshots.map(snapshot => snapshot.product_id),
      listing_count: snapshots.length,
      title_variant_count: new Set(snapshots.map(snapshot => snapshot.title)).size,
      total_stock: totalStock,
      priority_score: candidateScore(listings, existingRecord),
      current_level: existingRecord?.decision === 'auto_publish_facts'
        ? 'bibliographic_only'
        : existingRecord?.decision === 'auto_publish'
          ? 'editorial_curated'
          : 'not_enriched',
      title_snapshots: snapshots,
      author_snapshot: isGenericAuthor(representative?.author)
        ? null
        : clean(representative?.author),
      description_length: descriptionLength(representative),
      missing_bibliographic_fields: missingBibliographicCount(representative),
    });
  }

  candidates.sort((a, b) =>
    b.priority_score - a.priority_score ||
    b.total_stock - a.total_stock ||
    a.isbn.localeCompare(b.isbn),
  );

  if (candidates.length < requested) {
    throw new Error(`Lote editorial: sólo hay ${candidates.length}/${requested} ISBN elegibles.`);
  }

  return {
    requested,
    eligible_unique_isbns: candidates.length,
    excluded,
    selected: candidates.slice(0, requested),
  };
}

function walkObject(value, pathParts = [], findings = []) {
  if (!value || typeof value !== 'object') return findings;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walkObject(entry, [...pathParts, String(index)], findings));
    return findings;
  }
  for (const [key, child] of Object.entries(value)) {
    const nextPath = [...pathParts, key];
    if (FORBIDDEN_OUTPUT_KEYS.has(key)) findings.push(nextPath.join('.'));
    walkObject(child, nextPath, findings);
  }
  return findings;
}

export function validateEditorialOutputTitleLock(cohort, records) {
  const entries = Array.isArray(cohort?.entries) ? cohort.entries : [];
  const byIsbn = new Map(entries.map(entry => [entry.isbn, entry]));
  const errors = [];

  for (const record of Array.isArray(records) ? records : []) {
    const isbn = normalizeValidIsbn(record?.isbn);
    if (!byIsbn.has(isbn)) {
      errors.push(`${record?.isbn || 'sin ISBN'} no pertenece al lote bloqueado.`);
      continue;
    }
    for (const fieldPath of walkObject(record)) {
      errors.push(`${isbn} contiene campo comercial prohibido: ${fieldPath}.`);
    }
  }

  return errors;
}

export function buildEditorialBatchPlan({
  catalogItems = [],
  enrichmentRecords = [],
  limit = DEFAULT_EDITORIAL_BATCH_LIMIT,
  generatedAt = new Date().toISOString(),
} = {}) {
  const selection = selectEditorialBatch({ catalogItems, enrichmentRecords, limit });
  return {
    schema_version: 1,
    batch_id: 'editorial-real-2000-batch-01',
    generated_at: generatedAt,
    requested: selection.requested,
    selected_count: selection.selected.length,
    eligible_unique_isbns: selection.eligible_unique_isbns,
    excluded: selection.excluded,
    title_policy: {
      version: TITLE_POLICY_VERSION,
      commercial_title: 'immutable_byte_for_byte_per_listing',
      editorial_payload_title_fields: 'forbidden',
      h1: 'from_current_listing_title',
      html_title: 'from_current_listing_title',
      merchant_title: 'from_current_listing_title',
      slug: 'from_current_listing_title_immutable',
      canonical: 'from_current_listing_title_immutable',
      seo_terms_allowed_in: ['editorial_body', 'headings_below_h1', 'meta_description', 'merchant_description'],
      seo_terms_forbidden_in: ['commercial_title', 'seo_title', 'h1', 'html_title', 'merchant_title', 'slug', 'canonical'],
    },
    entries: selection.selected,
  };
}

export function assertEditorialBatchPlan(plan, expected = DEFAULT_EDITORIAL_BATCH_LIMIT) {
  if (!plan || plan.schema_version !== 1) throw new Error('Plan editorial inválido.');
  const entries = Array.isArray(plan.entries) ? plan.entries : [];
  if (entries.length !== expected || plan.selected_count !== expected) {
    throw new Error(`Lote incompleto: ${entries.length}/${expected}.`);
  }
  if (new Set(entries.map(entry => entry.isbn)).size !== expected) {
    throw new Error('El lote repite ISBN.');
  }
  for (const entry of entries) {
    if (!normalizeValidIsbn(entry.isbn)) throw new Error(`ISBN inválido: ${entry.isbn}.`);
    if (!Array.isArray(entry.title_snapshots) || entry.title_snapshots.length < 1) {
      throw new Error(`${entry.isbn} no tiene snapshots de títulos.`);
    }
    if (new Set(entry.title_snapshots.map(snapshot => snapshot.product_id)).size !== entry.title_snapshots.length) {
      throw new Error(`${entry.isbn} repite IDs en el bloqueo de títulos.`);
    }
    for (const snapshot of entry.title_snapshots) {
      if (!/^MLU\d+$/.test(snapshot.product_id) || !snapshot.title) {
        throw new Error(`${entry.isbn} tiene un snapshot de título incompleto.`);
      }
      if (titleFingerprint(snapshot.title) !== snapshot.sha256) {
        throw new Error(`${entry.isbn}/${snapshot.product_id} tiene una huella de título inválida.`);
      }
    }
    const representative = entry.title_snapshots.find(
      snapshot => snapshot.product_id === entry.representative_id,
    );
    if (!representative ||
        representative.title !== entry.representative_title_snapshot ||
        representative.sha256 !== entry.representative_title_sha256) {
      throw new Error(`${entry.isbn} no conserva el título de su representante.`);
    }
  }
  return true;
}

async function readJson(source) {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`${source} respondió HTTP ${response.status}.`);
    return response.json();
  }
  return JSON.parse(await readFile(source, 'utf8'));
}

function summaryMarkdown(plan) {
  const levels = Object.fromEntries(
    ['bibliographic_only', 'editorial_curated', 'not_enriched']
      .map(level => [level, plan.entries.filter(entry => entry.current_level === level).length]),
  );
  const variantGroups = plan.entries.filter(entry => entry.title_variant_count > 1).length;
  const protectedListings = plan.entries.reduce((sum, entry) => sum + entry.listing_count, 0);
  return `${[
    '# B11 — lote editorial real de 2.000 ISBN',
    '',
    `- Generado: ${plan.generated_at}`,
    `- Seleccionados: ${plan.selected_count}/${plan.requested}.`,
    `- Elegibles antes del corte: ${plan.eligible_unique_isbns}.`,
    `- Publicaciones con título protegido: ${protectedListings}.`,
    `- ISBN con más de una variante de título protegida: ${variantGroups}.`,
    `- Bibliográficos a convertir: ${levels.bibliographic_only}.`,
    `- Curados a profundizar: ${levels.editorial_curated}.`,
    `- Todavía no enriquecidos: ${levels.not_enriched}.`,
    `- Excluidos por ya tener contenido editorial real: ${plan.excluded.already_editorial_real}.`,
    '',
    '## Regla de títulos',
    '',
    '- Cada MLU conserva su título byte por byte, aunque comparta ISBN con otro título comercial.',
    '- La salida editorial tiene prohibidos title, seo_title, H1, título Merchant, slug y canonical.',
    '- El runtime obtiene H1 y título HTML de la publicación actual, no del registro compartido por ISBN.',
    '- Los términos SEO sólo pueden entrar en el cuerpo, subtítulos, metadescripción y descripción Merchant.',
    '',
  ].join('\n')}\n`;
}

async function main() {
  const limit = positiveInteger(process.env.BOOK_EDITORIAL_BATCH_LIMIT, DEFAULT_EDITORIAL_BATCH_LIMIT);
  const outputDir = process.env.BOOK_EDITORIAL_OUTPUT_DIR || DEFAULT_EDITORIAL_OUTPUT_DIR;
  const catalogSource = process.env.BOOK_EDITORIAL_CATALOG || CATALOG_URL;
  const catalog = await readJson(catalogSource);
  const plan = buildEditorialBatchPlan({
    catalogItems: Array.isArray(catalog?.items) ? catalog.items : [],
    enrichmentRecords: listBookEnrichments(),
    limit,
  });
  assertEditorialBatchPlan(plan, limit);

  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDir, 'cohort.json'), `${JSON.stringify(plan, null, 2)}\n`),
    writeFile(path.join(outputDir, 'title-lock.json'), `${JSON.stringify({
      batch_id: plan.batch_id,
      generated_at: plan.generated_at,
      title_policy: plan.title_policy,
      titles: plan.entries.flatMap(entry => entry.title_snapshots.map(snapshot => ({
        isbn: entry.isbn,
        product_id: snapshot.product_id,
        title: snapshot.title,
        sha256: snapshot.sha256,
      }))),
    }, null, 2)}\n`),
    writeFile(path.join(outputDir, 'summary.md'), summaryMarkdown(plan)),
  ]);

  console.log(JSON.stringify({
    batch_id: plan.batch_id,
    selected: plan.selected_count,
    eligible: plan.eligible_unique_isbns,
    protected_listings: plan.entries.reduce((sum, entry) => sum + entry.listing_count, 0),
    title_variant_groups: plan.entries.filter(entry => entry.title_variant_count > 1).length,
    excluded: plan.excluded,
    output_dir: path.resolve(outputDir),
    titles_changed: 0,
  }, null, 2));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error(`[book-editorial-2000-plan] ERROR: ${error?.message || error}`);
    process.exit(1);
  });
}
