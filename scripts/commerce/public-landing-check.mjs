import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Verificación de solo lectura sobre páginas PÚBLICAS del propio catálogo
// (amadolibros.com) — nunca Merchant API, nunca el flujo de compra del
// sitio. Toma los links ya calculados por merchant-readonly-audit.mjs
// (artifacts/merchant/merchant-readonly-report.json) para los bloqueos que
// se están investigando y verifica, contra la página real, lo que Merchant
// no puede decirnos: HTTP real, canonical, y el Offer (precio/moneda/
// disponibilidad) que ve un crawler en el JSON-LD de la ficha.

function asText(value) {
  return String(value ?? '').trim();
}

export function extractJsonLdOffers(html) {
  const blocks = [...String(html || '').matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const offers = [];
  for (const block of blocks) {
    let parsed;
    try { parsed = JSON.parse(block[1]); } catch { continue; }
    const nodes = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.['@graph']) ? parsed['@graph'] : [parsed];
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      const type = asText(node['@type']);
      if (!/product|book/i.test(type)) continue;
      const offer = Array.isArray(node.offers) ? node.offers[0] : node.offers;
      offers.push({
        name: asText(node.name) || null,
        price: offer ? asText(offer.price) || null : null,
        priceCurrency: offer ? asText(offer.priceCurrency) || null : null,
        availability: offer ? asText(offer.availability).replace('https://schema.org/', '') || null : null,
      });
    }
  }
  return offers[0] || null;
}

export function extractCanonical(html) {
  const match = String(html || '').match(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i);
  return match ? match[1] : null;
}

async function checkOne(row) {
  const { offerId, link, bucket } = row;
  if (!link) return { offerId, bucket, link: null, httpStatus: null, canonical: null, offer: null, error: 'sin link' };
  try {
    const response = await fetch(link, {
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
      headers: { 'User-Agent': 'AmadoLibros-Merchant-Diagnostics/1.0 (+solo lectura)' },
    });
    const html = response.status === 200 ? await response.text() : '';
    return {
      offerId,
      bucket,
      link,
      httpStatus: response.status,
      finalUrl: response.url !== link ? response.url : null,
      canonical: extractCanonical(html),
      offer: extractJsonLdOffers(html),
      error: null,
    };
  } catch (error) {
    return { offerId, bucket, link, httpStatus: null, canonical: null, offer: null, error: asText(error?.message) || 'fetch failed' };
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
  const reportPath = asText(process.env.MERCHANT_REPORT_PATH) || 'artifacts/merchant/merchant-readonly-report.json';
  const outputDir = path.dirname(reportPath);
  const raw = await readFile(reportPath, 'utf8');
  const report = JSON.parse(raw);
  const breakdown = report.productBreakdown || {};

  const rows = [];
  for (const row of breakdown.missingPrice || []) rows.push({ offerId: row.offerId, link: row.link, bucket: 'missingPrice' });
  for (const row of breakdown.imageTooSmall || []) rows.push({ offerId: row.offerId, link: row.link, bucket: 'imageTooSmall' });
  for (const row of breakdown.ebooks || []) rows.push({ offerId: row.offerId, link: row.link, bucket: 'ebooks' });
  for (const row of breakdown.landingError || []) rows.push({ offerId: row.offerId, link: row.link, bucket: 'landingError' });

  const results = await mapWithConcurrency(rows, 8, checkOne);

  await writeFile(path.join(outputDir, 'public-landing-check.json'), `${JSON.stringify(results, null, 2)}\n`);

  for (const bucket of ['missingPrice', 'imageTooSmall', 'ebooks', 'landingError']) {
    const subset = results.filter(row => row.bucket === bucket);
    console.log(`=== PUBLIC LANDING CHECK — ${bucket} (${subset.length}) ===`);
    console.log(JSON.stringify(subset, null, 2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
