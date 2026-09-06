import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { renderPage } from '../../functions/libro/[[path]].js';

// QW1 — informe del Offer que produce ESTE checkout del renderizador sobre
// datos reales de catálogo. Se ejecuta dos veces con el MISMO snapshot (una
// vez en `main`, otra en la rama del PR #313) y se comparan las salidas: eso
// demuestra qué casos reales cambia el fix, sin depender de que Preview tenga
// desplegado el producto. Solo lectura: no toca red salvo el snapshot, que se
// pasa por archivo.

function asText(value) {
  return String(value ?? '').trim();
}

function extractProductSchema(html) {
  for (const match of String(html).matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    let parsed;
    try { parsed = JSON.parse(match[1]); } catch { continue; }
    const types = Array.isArray(parsed?.['@type']) ? parsed['@type'] : [parsed?.['@type']];
    if (types.includes('Product')) return parsed;
  }
  return null;
}

export function describeRender(item) {
  const slug = asText(item.slug) || 'ficha';
  const html = renderPage(item, slug, false, '', '', []);
  const schema = extractProductSchema(html);
  const offer = schema?.offers || null;
  return {
    id: asText(item.id).toUpperCase(),
    status: asText(item.status) || null,
    price: item.price ?? null,
    currency: asText(item.currency || item.currency_id) || null,
    available_quantity: item.available_quantity ?? null,
    offer: offer
      ? {
          price: asText(offer.price) || null,
          priceCurrency: asText(offer.priceCurrency) || null,
          availability: asText(offer.availability).replace('https://schema.org/', '') || null,
          url: asText(offer.url) || null,
        }
      : null,
    // Coherencia entre lo que ve una persona y lo que ve Google.
    visiblePriceBox: /class="price-box"/.test(html),
    cartButton: /Agregar al carrito/i.test(html),
    canonicalInHtml: (html.match(/<link rel="canonical" href="([^"]+)">/) || [])[1] || null,
  };
}

export async function main() {
  const snapshotPath = asText(process.env.QW1_SNAPSHOT) || 'artifacts/qw1/catalog-snapshot.json';
  const outputPath = asText(process.env.QW1_RENDER_OUTPUT) || 'artifacts/qw1/render-report.json';
  const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
  const items = Array.isArray(snapshot.items) ? snapshot.items : [];

  const results = items.map(describeRender);
  const withOffer = results.filter(row => row.offer).length;

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    snapshot: {
      catalogUpdatedAt: snapshot.catalogUpdatedAt || null,
      fetchedAt: snapshot.fetchedAt || null,
      source: snapshot.source || null,
      items: items.length,
    },
    gitSha: asText(process.env.QW1_RENDER_SHA) || null,
    label: asText(process.env.QW1_RENDER_LABEL) || null,
    totals: { items: results.length, withOffer, withoutOffer: results.length - withOffer },
    results,
  }, null, 2)}\n`);

  console.log(JSON.stringify({
    label: process.env.QW1_RENDER_LABEL || null,
    sha: process.env.QW1_RENDER_SHA || null,
    items: results.length,
    withOffer,
    withoutOffer: results.length - withOffer,
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
