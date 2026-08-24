#!/usr/bin/env node
// FICHAS-ENRICHMENT-BIBLIAS-1 — gate HTTP real del Preview.
//
// Verifica todas las ediciones del registro, no una muestra. Si una futura
// entrada queda fuera del render SSR, del showcase o de Merchant, el Preview
// falla antes de que el PR pueda llegar a Producción.

import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { CATALOG_URL } from '../../functions/_shared/catalog.js';
import { listBookEnrichments } from '../../functions/_shared/book-enrichment-registry.js';
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
  return /(?:>|&quot;|["'])\s*(?:desconocido|unknown|sin autor|n\/a)\s*(?:<|&quot;|["'])/i.test(String(value || ''));
}

export function verifyBookEnrichmentHtml(html, record, productId) {
  const text = clean(html);
  const failures = [];
  if (!text.includes(record.editorial.heading)) failures.push('falta el encabezado editorial');
  if (!text.includes(record.facts.publisher)) failures.push('falta la editorial verificada');
  if (!text.includes(record.isbn)) failures.push('falta el ISBN exacto');
  if (!text.includes(record.editorial.decision_heading)) failures.push('falta ayuda de decisión');
  if (!html.includes(`MLU${String(productId).replace(/\D/g, '')}`)) failures.push('falta el ID comercial');
  if (containsGenericAuthor(html)) failures.push('aparece autoría genérica');
  if (/casadellibro\.com/i.test(html)) failures.push('se expone una referencia comercial externa');
  return failures;
}

export function verifyBookEnrichmentFeed(feedXml, record, productId) {
  const block = itemBlock(feedXml, productId);
  if (!block) return ['falta la oferta en Merchant'];
  const text = clean(block);
  const failures = [];
  if (!text.includes(record.isbn)) failures.push('Merchant perdió el ISBN');
  if (!block.includes('<g:price>')) failures.push('Merchant perdió el precio');
  if (!block.includes('<g:availability>')) failures.push('Merchant perdió disponibilidad');
  if (!block.includes('<g:link>')) failures.push('Merchant perdió el enlace');
  if (!block.includes('<g:image_link>')) failures.push('Merchant perdió la imagen');
  const descriptionSignal = clean(record.editorial.merchant_description).split(' ').slice(0, 7).join(' ');
  if (!text.includes(descriptionSignal)) failures.push('Merchant no recibió la descripción enriquecida');
  if (containsGenericAuthor(block)) failures.push('Merchant expone autoría genérica');
  return failures;
}

async function fetchText(url) {
  const response = await fetch(url, { redirect: 'follow', headers: { accept: 'text/html,application/xml' } });
  const text = await response.text();
  if (!response.ok) throw new Error(`${url} respondió HTTP ${response.status}`);
  return { text, finalUrl: response.url, status: response.status };
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

  for (const record of listBookEnrichments()) {
    const candidates = items
      .filter(item => item?.status === 'active' && normalizeValidIsbn(item?.isbn) === record.isbn)
      .sort((a, b) => (Number(b.available_quantity) || 0) - (Number(a.available_quantity) || 0));
    const item = candidates[0];
    if (!item) {
      reports.push({ isbn: record.isbn, status: 'failed', failures: ['no hay publicación activa para la edición'] });
      continue;
    }
    const page = await fetchText(`${BASE_URL}/libro/${item.id}`);
    const failures = [
      ...verifyBookEnrichmentHtml(page.text, record, item.id),
      ...verifyBookEnrichmentFeed(feedResponse.text, record, item.id),
    ];
    reports.push({
      isbn: record.isbn,
      product_id: item.id,
      url: page.finalUrl,
      http_status: page.status,
      status: failures.length ? 'failed' : 'verified',
      failures,
    });
  }

  const failed = reports.filter(report => report.status !== 'verified');
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(`${OUTPUT_DIR}/book-enrichment-live-check.json`, `${JSON.stringify({
    base_url: BASE_URL,
    checked_at: new Date().toISOString(),
    verified: reports.length - failed.length,
    failed: failed.length,
    reports,
  }, null, 2)}\n`);

  for (const report of reports) {
    console.log(`  ${report.isbn} · ${report.product_id || 'sin MLU'} · ${report.status}`);
    for (const failure of report.failures) console.error(`    - ${failure}`);
  }
  if (failed.length) throw new Error(`${failed.length} edición(es) fallaron la verificación HTTP.`);
  console.log(`OK: ${reports.length} ediciones enriquecidas verificadas en ficha y Merchant.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`book-enrichment-live-check falló: ${error.message}`);
    process.exitCode = 1;
  });
}
