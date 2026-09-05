#!/usr/bin/env node
// 1.6 — Dos verificaciones puntuales del brief:
//   a) /tienda/page/43/ — el brief marca un hallazgo a verificar: la keyword de
//      marca rankeaba en posición 8 con esta URL legacy, que la política de
//      cleanup (PR #76/#77) debería servir como 410. Puede ser dato cacheado
//      de Ahrefs anterior al deploy, o una URL fuera del patrón cubierto.
//   b) Ahrefs reportó 2 páginas servidas por HTTP en vez de HTTPS. Este script
//      no las adivina: prueba la home y, si el sitio expone algún listado de
//      URLs propio, lo usa para detectar cuáles responden en claro por HTTP
//      directo (sin que el 301 a HTTPS actúe primero).
import { BASE_URL, absoluteUrls, mapWithLimit, request, writeReport } from './_lib.mjs';

async function checkLegacyTiendaPage43() {
  const target = `${BASE_URL}/tienda/page/43/`;
  const response = await request(target, { method: 'HEAD' });
  return {
    url: target,
    status: response.status,
    finalUrl: response.finalUrl,
    redirected: response.redirected,
    error: response.error || null,
    esperado410: response.status === 410,
    nota: response.status === 410
      ? 'La política de cleanup está viva: sirve 410 como se espera.'
      : `No sirve 410 hoy (status real ${response.status}). Puede ser dato cacheado de Ahrefs anterior al deploy o una URL fuera del patrón — no se puede distinguir sin ver la config del cleanup.`,
  };
}

async function checkHttpVariants() {
  // No hay forma de listar "las 2 URLs HTTP" sin el export de Ahrefs, que el
  // brief marca como no logrado. Lo que sí se puede hacer sin inventar nada:
  // tomar todas las URLs de los sitemaps y, para cada host, probar la variante
  // http:// directa, viendo si el servidor de origen redirige de entrada o si
  // hay una superficie que responde en claro antes del 301.
  const rootSitemap = `${BASE_URL}/sitemap.xml`;
  const seen = new Set();
  const queue = [rootSitemap];
  const httpOrigins = new Set();
  while (queue.length) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    const response = await request(url);
    if (!response.ok || response.status !== 200) continue;
    for (const loc of absoluteUrls(response.body)) {
      if (/\.xml(\?|$)/i.test(loc)) { queue.push(loc); continue; }
      try { httpOrigins.add(new URL(loc).origin.replace('https://', 'http://')); } catch { /* ignore */ }
    }
  }
  const origins = [...httpOrigins];
  const results = await mapWithLimit(origins, async origin => {
    const response = await request(`${origin}/`, { method: 'HEAD' });
    return {
      origin,
      status: response.status,
      finalUrl: response.finalUrl,
      sirveEnClaro: response.status === 200 && response.finalUrl.startsWith('http://'),
    };
  }, 5);
  return {
    metodo: 'HEAD a la variante http:// de cada origen presente en los sitemaps (no hay export de Ahrefs con las 2 URLs exactas)',
    resultados: results,
    limitacion: 'Esto detecta el origen, no las 2 páginas específicas del reporte de Ahrefs. Sin el export original no se pueden identificar con certeza.',
  };
}

async function main() {
  console.log('1.6a — /tienda/page/43/');
  const tienda = await checkLegacyTiendaPage43();
  console.log(`  status=${tienda.status} finalUrl=${tienda.finalUrl}`);

  console.log('1.6b — variantes HTTP de los orígenes en sitemap');
  const http = await checkHttpVariants();
  for (const r of http.resultados) console.log(`  ${r.origin} -> status=${r.status} finalUrl=${r.finalUrl}`);

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    tiendaPage43: tienda,
    httpVariants: http,
  };
  await writeReport('1.6-legacy-and-protocol.json', report);
}

main().catch(error => {
  console.error(`legacy-and-protocol falló: ${error.message}`);
  process.exitCode = 1;
});
