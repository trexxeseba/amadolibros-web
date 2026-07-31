/**
 * functions/api/cf-r2-1.js
 *
 * CF-R2-1 — compara el acceso al índice activo gzip por tres métodos:
 * r2dev (actual), binding R2 directo, y dominio propio sobre el bucket.
 *
 * Solo GET, solo Preview (mismo patrón que perf-verify.js), sin Turnstile ni
 * secreto: es de solo lectura, nunca escribe en caches.default y nunca
 * escribe en D1 ni en R2 — ver functions/_shared/r2-access.js para la
 * justificación de por qué no necesita el mismo mecanismo de sesión que
 * PERF-VERIFY-1. No expone nada que no esté ya público en el bucket R2.
 */
import { PAUSED_MANIFEST_URL } from '../_shared/catalog.js';
import { ensurePerf, serverTimingValue } from '../_shared/perf.js';
import { readObjectViaVariant, VARIANTS, customDomainBase } from '../_shared/r2-access.js';

const PAGES_PREVIEW_HOSTNAME_RE = /^[^.]+\.amadolibros-web\.pages\.dev$/;

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

async function loadCurrentManifest() {
  const nonceUrl = `${PAUSED_MANIFEST_URL}?cf_r2_1=${crypto.randomUUID()}`;
  const response = await fetch(nonceUrl, {
    headers: { 'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache' },
    cf: { cacheTtl: 0, cacheEverything: false },
  });
  if (!response.ok) throw new Error(`manifest_${response.status}`);
  return response.json();
}

function activeGzipKeyFrom(manifest) {
  const descriptor = manifest?.current;
  const key = descriptor?.active_index_gzip_key;
  if (!descriptor || typeof key !== 'string' || !key.endsWith('/active-index.json.gz')) {
    return null;
  }
  return { key, version: descriptor.version };
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const isPreview = context.env?.APP_ENV === 'preview' &&
    PAGES_PREVIEW_HOSTNAME_RE.test(url.hostname);
  if (!isPreview) return new Response('Not found', { status: 404 });

  if (context.request.method !== 'GET') {
    return json({ error: 'Método no permitido.' }, 405, { Allow: 'GET' });
  }

  const variant = url.searchParams.get('variant');
  if (variant === 'variants') {
    return json({
      variants: VARIANTS,
      binding_configured: typeof context.env?.CATALOG_BUCKET?.get === 'function',
      custom_domain_configured: customDomainBase(context) !== null,
    });
  }
  if (!VARIANTS.includes(variant)) {
    return json({ error: 'variant inválida.', valid: VARIANTS }, 400);
  }

  ensurePerf(context);

  let manifest;
  try {
    manifest = await loadCurrentManifest();
  } catch (error) {
    return json({ error: 'No se pudo leer el manifest actual.', code: error?.message }, 503);
  }

  const active = activeGzipKeyFrom(manifest);
  if (!active) {
    return json({ error: 'Manifest sin clave gzip activa válida.' }, 503);
  }

  const result = await readObjectViaVariant(context, variant, active.key, 'active_index_gzip_read');
  const serverTiming = serverTimingValue(context);

  if (!result.ok) {
    return json({
      ok: false,
      variant,
      key: active.key,
      manifest_version: active.version,
      error: result.code,
      detail: result.detail || null,
    }, 502, { 'Server-Timing': serverTiming });
  }

  return json({
    ok: true,
    variant,
    key: active.key,
    manifest_version: active.version,
    bytes: result.bytes.byteLength,
    upstream_cf_ray: result.upstream_cf_ray || null,
  }, 200, { 'Server-Timing': serverTiming });
}
