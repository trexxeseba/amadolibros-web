#!/usr/bin/env node
// FICHAS-ENRICHMENT-BIBLIAS-1 — gate HTTP real del Preview.
//
// Verifica todas las ediciones enriquecidas que tengan al menos una oferta
// activa en el catálogo. Una edición sin publicación MLU activa se conserva
// en el registro y queda reportada como not_applicable: no existe una ficha
// comercial ni una oferta Merchant que tenga sentido exigir en ese momento.
// Si vuelve a aparecer una publicación activa para ese ISBN, el gate estricto
// se reactiva automáticamente.

import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { CATALOG_URL } from '../../functions/_shared/catalog.js';
import {
  applyBookEnrichment,
  listBookEnrichments,
} from '../../functions/_shared/book-enrichment-registry.js';
import { normalizeValidIsbn } from '../../functions/_shared/showcase-ranking.js';

const BASE_URL = String(process.env.BOOK_ENRICHMENT_BASE_URL || '').replace(/\/$/, '');
const OUTPUT_DIR = process.env.BOOK_ENRICHMENT_OUTPUT_DIR || 'artifacts/fichas-quality';

function decodeEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function clean(value) {
  return decodeEntities(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function itemBlock(feedXml, id) {
  return (String(feedXml || '').match(/<item>[\s\S]*?<\/item>/gi) || [])
    .find(block => block.includes(`<g:id>${id}</g:id>`)) || '';
}

function containsGenericAuthor(value) {
  const source = String(value || '');
  const generic = '(?:desconocido|unknown|sin autor|n\\/a)';
  return [
    new RegExp(`["']author["']\\s*:\\s*\\{[\\s\\S]{0,500}?["']name["']\\s*:\\s*["']\\s*${generic}\\s*["']`, 'i'),
    new RegExp(`<dt[^>]*>\\s*Autor(?:ía)?\\s*</dt>\\s*<dd[^>]*>\\s*${generic}\\s*</dd>`, 'i'),
    new RegExp(`(?:Más sobre|Ver otros libros de)\\s*${generic}(?:\\s|<|&|$)`, 'i'),
    new RegExp(`<g:description[^>]*>[\\s\\S]{0,5000}?(?:^|[.,;:!?\\s])de\\s+${generic}(?:[.,;:!?\\s]|$)[\\s\\S]{0,5000}?</g:description>`, 'i'),
  ].some(pattern => pattern.test(source));
}

function merchantFactSignals(record, original) {
  if (record?.decision !== 'auto_publish_facts') return [];
  const enriched = applyBookEnrichment(original);
  const signals = [];
  const before = original?.bibliographic && typeof original.bibliographic === 'object'
    ? original.bibliographic
    : {};
  const after = enriched?.bibliographic && typeof enriched.bibliographic === 'object'
    ? enriched.bibliographic
    : {};
  if (!(Number(original?.pages) > 0) && Number(enriched?.pages) > 0) {
    signals.push(`${Number(enriched.pages)} páginas`);
  }
  if (!clean(before.format) && clean(after.format)) signals.push(clean(after.format));
  if (!clean(before.language) && clean(after.language)) signals.push(`idioma ${clean(after.language)}`);

  // Autor y editorial sólo forman parte del fallback de Merchant cuando el
  // catálogo no trae una descripción real. No se exige un dato que el propio
  // generador, por contrato, no publica en esa oferta.
  const title = clean(original?.title);
  const hasRealDescription = Boolean(
    clean(original?.description) && clean(original.description) !== title
  );
  if (!hasRealDescription) {
    if (clean(original?.author) !== clean(enriched?.author) && clean(enriched?.author)) {
      signals.push(`de ${clean(enriched.author)}`);
    }
    if (!clean(original?.publisher) && clean(enriched?.publisher)) {
      signals.push(`publicado por ${clean(enriched.publisher)}`);
    }
  }
  return [...new Set(signals)];
}

function changedFactSignals(record, original) {
  if (record?.decision !== 'auto_publish_facts') return [];
  const enriched = applyBookEnrichment(original);
  const signals = [];
  const scalar = (field, value) => {
    if (clean(original?.[field]) !== clean(enriched?.[field]) && clean(value)) signals.push(clean(value));
  };
  scalar('author', enriched.author);
  scalar('publisher', enriched.publisher);
  scalar('pages', enriched.pages);
  const before = original?.bibliographic && typeof original.bibliographic === 'object'
    ? original.bibliographic
    : {};
  const after = enriched?.bibliographic && typeof enriched.bibliographic === 'object'
    ? enriched.bibliographic
    : {};
  for (const field of ['language', 'format', 'edition', 'publication_year']) {
    if (clean(before[field]) !== clean(after[field]) && clean(after[field])) signals.push(clean(after[field]));
  }
  const beforeSubjects = Array.isArray(before.subjects) ? before.subjects.map(clean).filter(Boolean) : [];
  const afterSubjects = Array.isArray(after.subjects) ? after.subjects.map(clean).filter(Boolean) : [];
  if (beforeSubjects.join('\u0000') !== afterSubjects.join('\u0000')) signals.push(...afterSubjects);
  return [...new Set(signals)];
}

export function classifyBookEnrichmentCoverage(items, record) {
  const candidates = (Array.isArray(items) ? items : [])
    .filter(item => item?.status === 'active' && normalizeValidIsbn(item?.isbn) === record?.isbn)
    .sort((a, b) => (Number(b.available_quantity) || 0) - (Number(a.available_quantity) || 0));

  if (!candidates.length) {
    return {
      status: 'not_applicable',
      reason: 'no_active_publication',
      candidates: [],
    };
  }

  return {
    status: 'pending',
    reason: null,
    candidates,
  };
}

export function verifyBookEnrichmentHtml(html, record, productId, originalItem = null) {
  const text = clean(html);
  const failures = [];
  if (record?.decision === 'auto_publish') {
    if (!text.includes(record.editorial.heading)) failures.push('falta el encabezado editorial');
    if (record.facts.publisher && !text.includes(record.facts.publisher)) failures.push('falta la editorial verificada');
    if (!text.includes(record.editorial.decision_heading)) failures.push('falta ayuda de decisión');
  } else {
    // Si el catálogo ya trae un valor real (no vacío) para un campo, el
    // merge lo conserva a propósito y no hay ningún hecho nuevo que exigir
    // para ese campo — no es una falla, es la regla de "nunca reemplazar
    // un dato ya confirmado" funcionando como corresponde. Sólo se exige
    // que cada hecho que sí se aplicó (porque el campo estaba vacío)
    // aparezca realmente en la página.
    for (const signal of changedFactSignals(record, originalItem)) {
      if (!text.includes(signal)) failures.push(`falta el hecho verificado: ${signal}`);
    }
  }
  if (!text.includes(record.isbn)) failures.push('falta el ISBN exacto');
  if (!html.includes(`MLU${String(productId).replace(/\D/g, '')}`)) failures.push('falta el ID comercial');
  if (containsGenericAuthor(html)) failures.push('aparece autoría genérica');
  if (/casadellibro\.com/i.test(html)) failures.push('se expone una referencia comercial externa');
  return failures;
}

export function verifyBookEnrichmentFeed(feedXml, record, item) {
  const productId = item?.id;
  const block = itemBlock(feedXml, productId);
  if (!block) return ['falta la oferta en Merchant'];
  const text = clean(block);
  const failures = [];
  if (!text.includes(record.isbn)) failures.push('Merchant perdió el ISBN');
  if (!block.includes('<g:price>')) failures.push('Merchant perdió el precio');
  if (!block.includes('<g:availability>')) failures.push('Merchant perdió disponibilidad');
  if (!block.includes('<g:link>')) failures.push('Merchant perdió el enlace');
  if (!block.includes('<g:image_link>')) failures.push('Merchant perdió la imagen');
  if (record?.decision === 'auto_publish') {
    const descriptionSignal = clean(record?.editorial?.merchant_description)
      .split(' ')
      .slice(0, 12)
      .join(' ');
    if (descriptionSignal && !text.includes(descriptionSignal)) {
      failures.push('Merchant no recibió la descripción editorial esperada');
    }
  } else {
    for (const signal of merchantFactSignals(record, item)) {
      if (!text.includes(signal)) failures.push(`Merchant no recibió el hecho verificado: ${signal}`);
    }
  }
  if (containsGenericAuthor(block)) failures.push('Merchant expone autoría genérica');
  return failures;
}

async function mapWithConcurrency(values, concurrency, worker) {
  const output = new Array(values.length);
  let next = 0;
  async function consume() {
    while (next < values.length) {
      const index = next++;
      output[index] = await worker(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length || 1) }, consume));
  return output;
}

async function fetchText(url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        headers: { accept: 'text/html,application/xml' },
        signal: AbortSignal.timeout(30_000),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`${url} respondió HTTP ${response.status}`);
      return { text, finalUrl: response.url, status: response.status };
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 500));
    }
  }
  throw lastError;
}

async function main() {
  if (!/^https:\/\//i.test(BASE_URL)) throw new Error('Falta BOOK_ENRICHMENT_BASE_URL HTTPS.');
  const [catalogResponse, feedResponse] = await Promise.all([
    fetch(CATALOG_URL, { headers: { accept: 'application/json' } }),
    fetchText(`${BASE_URL}/feed.xml`),
  ]);
  if (!catalogResponse.ok) throw new Error(`Catálogo respondió HTTP ${catalogResponse.status}`);
  const catalog = await catalogResponse.json();
  const items = Array.isArray(catalog?.items) ? catalog.items : [];
  const reports = [];
  const pageTasks = [];

  for (const record of listBookEnrichments()) {
    const coverage = classifyBookEnrichmentCoverage(items, record);
    const candidates = coverage.candidates;
    if (coverage.status === 'not_applicable') {
      reports.push({
        isbn: record.isbn,
        product_ids: [],
        merchant_product_id: null,
        pages: [],
        status: 'not_applicable',
        reason: coverage.reason,
        failures: [],
      });
      continue;
    }

    // Se verifica siempre la publicación de mayor stock (mismo criterio que
    // `auto_publish`): un `auto_publish_facts` puede legítimamente no
    // aportar ningún campo nuevo a esta publicación puntual si el catálogo
    // ya trae ahí un valor real para todo lo que el registro sabe — eso no
    // es una falla, `verifyBookEnrichmentHtml` sólo exige lo que sí se
    // aplicó.
    const pageItem = candidates[0];
    const report = {
      isbn: record.isbn,
      product_ids: candidates.map(item => item.id),
      merchant_product_id: null,
      pages: [],
      status: 'pending',
      reason: null,
      failures: [],
    };
    reports.push(report);
    pageTasks.push({ record, item: pageItem, report });

    // Merchant consolida ofertas duplicadas por GTIN. Se verifica el MLU que
    // efectivamente ganó en el feed, no se presupone que sea el de mayor stock.
    const merchantItem = candidates.find(item => itemBlock(feedResponse.text, item.id));
    if (!merchantItem) {
      report.failures.push('ninguna publicación de la edición aparece en Merchant');
    } else {
      report.failures.push(...verifyBookEnrichmentFeed(feedResponse.text, record, merchantItem));
    }
    report.merchant_product_id = merchantItem?.id || null;
  }

  await mapWithConcurrency(pageTasks, 10, async ({ record, item, report }) => {
    const page = await fetchText(`${BASE_URL}/libro/${item.id}`);
    const failures = verifyBookEnrichmentHtml(page.text, record, item.id, item);
    report.pages.push({
      product_id: item.id,
      url: page.finalUrl,
      http_status: page.status,
      failures,
    });
    report.failures.push(...failures.map(failure => `${item.id}: ${failure}`));
  });

  for (const report of reports) {
    if (report.status === 'not_applicable') continue;
    report.status = report.failures.length ? 'failed' : 'verified';
  }

  const failed = reports.filter(report => report.status === 'failed');
  const verified = reports.filter(report => report.status === 'verified');
  const notApplicable = reports.filter(report => report.status === 'not_applicable');

  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(`${OUTPUT_DIR}/book-enrichment-live-check.json`, `${JSON.stringify({
    base_url: BASE_URL,
    checked_at: new Date().toISOString(),
    verified: verified.length,
    not_applicable: notApplicable.length,
    failed: failed.length,
    reports,
  }, null, 2)}\n`);

  for (const report of reports) {
    console.log(`  ${report.isbn} · ${(report.product_ids || []).join(', ') || 'sin MLU activo'} · ${report.status}`);
    if (report.status === 'not_applicable') {
      console.warn('    - edición enriquecida conservada; sin oferta activa para verificar en este Preview');
    }
    // console.log en vez de console.error: en CI, stderr se pierde por
    // buffering cuando el proceso termina justo después de escribir (visto
    // en la corrida de PR #305 — las líneas de resumen por ISBN llegaban al
    // log pero el detalle de cada fallo no).
    for (const failure of report.failures) console.log(`    - ${failure}`);
  }

  if (failed.length) throw new Error(`${failed.length} edición(es) activas fallaron la verificación HTTP.`);
  console.log(
    `OK: ${verified.length} ediciones activas verificadas en ficha y Merchant; ` +
    `${notApplicable.length} sin oferta activa quedaron como no aplicables.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`book-enrichment-live-check falló: ${error.message}`);
    process.exitCode = 1;
  });
}
