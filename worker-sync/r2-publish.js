/**
 * worker-sync/r2-publish.js
 *
 * Escribe catalog.json y meta.json en el bucket R2 amadolibros-catalog
 * usando el patrón staging → validación → promote.
 *
 * Flujo:
 *   1. Escribir staging/catalog.json + staging/meta.json
 *   2. Leer de vuelta staging/catalog.json y validar estructura
 *   3. Solo si válido: promover a catalog.json + meta.json (archivos live)
 *   4. Si inválido: lanzar error — catalog.json live NO se toca
 *
 * Validaciones antes de promote:
 *   - JSON parseable
 *   - Tiene campos: total (number), updated_at (string), items (array)
 *   - items.length > 0
 *   - items.length === total
 *
 * R2 put es atómico: el objeto live sigue siendo visible para lectores
 * hasta que el put de promote completa. No hay ventana de inconsistencia.
 */

export async function publishToR2(env, catalog, syncMeta) {
  const catalogBody = JSON.stringify(catalog);
  const metaBody    = JSON.stringify(syncMeta);

  // ── 1. Escribir staging ────────────────────────────────────────────────────
  await env.CATALOG_R2.put('staging/catalog.json', catalogBody, {
    httpMetadata: {
      contentType:  'application/json',
      cacheControl: 'no-store',
    },
  });

  await env.CATALOG_R2.put('staging/meta.json', metaBody, {
    httpMetadata: {
      contentType:  'application/json',
      cacheControl: 'no-store',
    },
  });

  console.log('[R2] Staging escrito. Validando readback...');

  // ── 2. Leer de vuelta y validar ────────────────────────────────────────────
  const stagingObj = await env.CATALOG_R2.get('staging/catalog.json');
  if (!stagingObj) {
    throw new Error('[R2] Readback de staging/catalog.json devolvió null — R2 inconsistente. Abortando promote.');
  }

  let parsed;
  try {
    const text = await stagingObj.text();
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`[R2] staging/catalog.json no es JSON válido: ${e.message}`);
  }

  // Validar estructura
  const errs = [];

  if (typeof parsed.total !== 'number')              errs.push('total no es number');
  if (typeof parsed.updated_at !== 'string')         errs.push('updated_at no es string');
  if (!Array.isArray(parsed.items))                  errs.push('items no es array');
  if (Array.isArray(parsed.items) && parsed.items.length === 0) errs.push('items está vacío');
  if (Array.isArray(parsed.items) && typeof parsed.total === 'number' && parsed.items.length !== parsed.total) {
    errs.push(`items.length (${parsed.items.length}) !== total (${parsed.total})`);
  }

  if (errs.length > 0) {
    throw new Error(`[R2] Validación fallida — catalog.json live NO modificado. Errores: ${errs.join('; ')}`);
  }

  console.log(`[R2] Validación OK: ${parsed.total} items, updated_at: ${parsed.updated_at}`);

  // ── 3. Promote a live ──────────────────────────────────────────────────────
  await env.CATALOG_R2.put('catalog.json', catalogBody, {
    httpMetadata: {
      contentType:  'application/json',
      cacheControl: 'public, max-age=3600',
    },
  });

  await env.CATALOG_R2.put('meta.json', metaBody, {
    httpMetadata: {
      contentType:  'application/json',
      cacheControl: 'public, max-age=300',
    },
  });

  const bytes = new TextEncoder().encode(catalogBody).length;
  console.log(
    `[R2] Promote completado: ${catalog.total} items, ` +
    `${(bytes / 1024 / 1024).toFixed(2)} MB, updated_at: ${catalog.updated_at}`
  );
}
