#!/usr/bin/env node
// 1.2 — Extrae Open Graph y tarjetas de X/Twitter de las páginas indexables y
// lista las que no tienen ninguna etiqueta social.
//
// Importa comercialmente: WhatsApp arma la vista previa del link con Open
// Graph. Una ficha sin OG se comparte sin imagen, sin título y sin precio.
//
// Este script NO implementa el fix. Agrupa por patrón para que la hipótesis de
// causa raíz se apoye en datos y no en intuición.
import { BASE_URL, absoluteUrls, mapWithLimit, request, writeReport } from './_lib.mjs';

const LIMIT = Number(process.env.AUDIT_SOCIAL_LIMIT) || 0; // 0 = sin límite

function meta(html, attr, value) {
  // Tolera orden de atributos invertido y comillas simples o dobles.
  const patterns = [
    new RegExp(`<meta[^>]+${attr}=["']${value}["'][^>]*content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*${attr}=["']${value}["']`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return match[1].trim();
  }
  return '';
}

function classify(url, html) {
  // Señales que podrían explicar la ausencia del bloque social. Se recogen
  // para todas las páginas, tengan o no OG, para poder comparar.
  const isBook = /\/libro\/MLU\d+/i.test(url);
  return {
    isBook,
    hasCanonical: /<link[^>]+rel=["']canonical["']/i.test(html),
    hasJsonLd: /application\/ld\+json/i.test(html),
    hasBookCover: /\/book-cover\/MLU\d+\//i.test(html),
    hasPrice: /"price"\s*:/i.test(html),
    noindex: /<meta[^>]+name=["']robots["'][^>]*noindex/i.test(html),
    htmlBytes: html.length,
  };
}

async function collectIndexableUrls() {
  const seen = new Set();
  const queue = [`${BASE_URL}/sitemap.xml`];
  const urls = [];
  while (queue.length) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    const response = await request(url);
    if (!response.ok || response.status !== 200) continue;
    for (const loc of absoluteUrls(response.body)) {
      if (/\.xml(\?|$)/i.test(loc)) queue.push(loc);
      else urls.push(loc);
    }
  }
  return [...new Set(urls)];
}

async function main() {
  let urls = await collectIndexableUrls();
  console.log(`Páginas declaradas en sitemaps: ${urls.length}`);
  if (LIMIT > 0 && urls.length > LIMIT) {
    // Muestreo determinista por paso fijo: reproducible entre corridas.
    const step = Math.ceil(urls.length / LIMIT);
    urls = urls.filter((_, index) => index % step === 0).slice(0, LIMIT);
    console.log(`  muestreadas: ${urls.length} (AUDIT_SOCIAL_LIMIT=${LIMIT})`);
  }

  const rows = await mapWithLimit(urls, async url => {
    const response = await request(url);
    if (!response.ok || response.status !== 200) {
      return { url, status: response.status, error: response.error || null, unreachable: true };
    }
    const html = response.body;
    const og = {
      title: meta(html, 'property', 'og:title') || meta(html, 'name', 'og:title'),
      description: meta(html, 'property', 'og:description') || meta(html, 'name', 'og:description'),
      image: meta(html, 'property', 'og:image') || meta(html, 'name', 'og:image'),
    };
    const twitterCard = meta(html, 'name', 'twitter:card') || meta(html, 'property', 'twitter:card');
    const hasAnyOg = Boolean(og.title || og.description || og.image);
    return {
      url,
      status: response.status,
      og,
      twitterCard,
      hasAnyOg,
      hasCompleteOg: Boolean(og.title && og.description && og.image),
      hasTwitterCard: Boolean(twitterCard),
      signals: classify(url, html),
    };
  });

  const reachable = rows.filter(row => !row.unreachable);
  const sinNinguna = reachable.filter(row => !row.hasAnyOg && !row.hasTwitterCard);
  const sinTwitter = reachable.filter(row => row.hasAnyOg && !row.hasTwitterCard);

  // Patrón común: se comparan las señales de las páginas sin OG contra el resto.
  const conOg = reachable.filter(row => row.hasAnyOg);
  const rate = (list, key) => (list.length
    ? Number(((list.filter(row => row.signals?.[key]).length / list.length) * 100).toFixed(1))
    : 0);
  const señales = ['isBook', 'hasCanonical', 'hasJsonLd', 'hasBookCover', 'hasPrice', 'noindex'];
  const comparacion = Object.fromEntries(señales.map(key => [key, {
    sinEtiquetas: rate(sinNinguna, key),
    conEtiquetas: rate(conOg, key),
  }]));

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    totals: {
      analizadas: rows.length,
      alcanzables: reachable.length,
      inalcanzables: rows.length - reachable.length,
      sinNingunaEtiquetaSocial: sinNinguna.length,
      conOgCompleto: reachable.filter(row => row.hasCompleteOg).length,
      sinTarjetaTwitter: reachable.filter(row => !row.hasTwitterCard).length,
      conOgPeroSinTwitter: sinTwitter.length,
    },
    // Porcentaje de cada señal en el grupo sin etiquetas contra el grupo con
    // etiquetas. Una diferencia marcada señala la causa; uno parejo la descarta.
    comparacionDeSeñales: comparacion,
    sinNingunaEtiquetaSocial: sinNinguna.map(row => ({ url: row.url, signals: row.signals })),
    sinTarjetaTwitter: reachable.filter(row => !row.hasTwitterCard).map(row => row.url),
  };

  console.log(JSON.stringify(report.totals, null, 2));
  console.log('Comparación de señales (% dentro de cada grupo):');
  console.log(JSON.stringify(comparacion, null, 2));
  await writeReport('1.2-social-tags.json', report);
}

main().catch(error => {
  console.error(`social-tags falló: ${error.message}`);
  process.exitCode = 1;
});
