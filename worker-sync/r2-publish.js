/**
 * worker-sync/r2-publish.js
 *
 * Escribe catalog.json y meta.json en el bucket R2 amadolibros-catalog.
 *
 * R2 put es atómico: el objeto antiguo sigue siendo visible para todos los
 * lectores hasta que el put completa. No se necesita staging intermedio.
 *
 * catalog.json — leído por:
 *   - index.html (SPA, fetch directo)
 *   - functions/catalogo.js
 *   - functions/libro/[[path]].js
 *   - functions/sitemap.xml.js
 *   - functions/feed.xml.js
 *   - functions/api/[[route]].js /api/catalog (deprecado, funcional)
 *
 * meta.json — leído para monitoreo externo (no es parte del flujo SSR).
 *   Útil para verificar cuándo fue el último sync sin descargar el catálogo.
 */

export async function publishToR2(env, catalog, syncMeta) {
  const catalogBody = JSON.stringify(catalog);
  const metaBody    = JSON.stringify(syncMeta);

  // Escribir catalog.json
  await env.CATALOG_R2.put('catalog.json', catalogBody, {
    httpMetadata: {
      contentType:  'application/json',
      cacheControl: 'public, max-age=3600',
    },
  });

  // Escribir meta.json (pequeño, no bloquea)
  await env.CATALOG_R2.put('meta.json', metaBody, {
    httpMetadata: {
      contentType:  'application/json',
      cacheControl: 'public, max-age=300',
    },
  });

  const bytes = new TextEncoder().encode(catalogBody).length;
  console.log(
    `[R2] catalog.json escrito: ${catalog.total} items, ` +
    `${(bytes / 1024 / 1024).toFixed(2)} MB, updated_at: ${catalog.updated_at}`
  );
}
