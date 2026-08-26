#!/usr/bin/env node
// 1.1 — Recorre todos los sitemaps y hace una petición a cada entrada.
// Reporta toda URL que no devuelva 200, con su código y su destino final.
//
// Ahrefs declaró 9 URLs con 3XX en el sitemap pero no logró exportar la lista.
// Este script la produce de forma reproducible, que es lo que el brief prefiere.
import { BASE_URL, absoluteUrls, mapWithLimit, request, summarizeUrlChecks, writeReport } from './_lib.mjs';

async function collectSitemaps(rootUrl) {
  const seen = new Set();
  const queue = [rootUrl];
  const sitemaps = [];
  const entries = [];

  while (queue.length) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);

    const response = await request(url);
    if (!response.ok || response.status !== 200) {
      sitemaps.push({ url, status: response.status, error: response.error || null, entries: 0 });
      continue;
    }
    const locs = absoluteUrls(response.body);
    // Un índice de sitemaps apunta a otros .xml; un sitemap de páginas, a URLs.
    const nested = locs.filter(loc => /\.xml(\?|$)/i.test(loc));
    const pages = locs.filter(loc => !/\.xml(\?|$)/i.test(loc));
    for (const child of nested) queue.push(child);
    for (const page of pages) entries.push({ sitemap: url, url: page });
    sitemaps.push({ url, status: 200, entries: pages.length, nested: nested.length });
  }
  return { sitemaps, entries };
}

async function main() {
  const root = `${BASE_URL}/sitemap.xml`;
  console.log(`Recorriendo sitemaps desde ${root}`);
  const { sitemaps, entries } = await collectSitemaps(root);
  console.log(`  sitemaps: ${sitemaps.length} · entradas: ${entries.length}`);

  // Se deduplica por URL: una misma ficha puede figurar en más de un sitemap.
  const unique = [...new Map(entries.map(entry => [entry.url, entry])).values()];
  console.log(`  entradas únicas: ${unique.length}`);

  const checked = await mapWithLimit(unique, async entry => {
    // HEAD primero: es lo que pide el brief y evita descargar el cuerpo.
    // Si el origen no lo soporta, se cae a GET para no reportar un falso 405.
    let response = await request(entry.url, { method: 'HEAD', redirect: 'manual' });
    if (response.status === 405 || response.status === 501) {
      response = await request(entry.url, { method: 'GET', redirect: 'manual' });
    }
    let redirectTarget = null;
    if (response.location) {
      try { redirectTarget = new URL(response.location, entry.url).toString(); } catch { /* Location inválido: queda null */ }
    }
    return {
      url: entry.url,
      sitemap: entry.sitemap,
      status: response.status,
      finalUrl: response.finalUrl,
      redirected: response.redirected,
      redirectTarget,
      error: response.error || null,
    };
  });

  const summary = summarizeUrlChecks(checked);
  const noOk = summary.notOk;
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    totals: {
      sitemaps: sitemaps.length,
      entries: entries.length,
      uniqueEntries: unique.length,
      ...summary.totals,
    },
    sitemaps,
    notOk: noOk,
  };

  console.log(JSON.stringify(report.totals, null, 2));
  await writeReport('1.1-sitemap-status.json', report);
}

main().catch(error => {
  console.error(`sitemap-status falló: ${error.message}`);
  process.exitCode = 1;
});
