/**
 * functions/api/cf-r2-1.js
 *
 * CF-R2-1 — compara el acceso al índice activo gzip por tres métodos:
 * r2dev (actual), binding R2 directo, y dominio propio sobre el bucket.
 *
 * Solo GET, solo Preview (mismo patrón que perf-verify.js), nunca escribe en
 * caches.default y nunca escribe en D1 ni en R2 — ver
 * functions/_shared/r2-access.js para la justificación de por qué no
 * necesita el mismo mecanismo de sesión Turnstile-gated que PERF-VERIFY-1.
 *
 * Protección: header `X-Perf-Verify-Secret` comparado contra el secreto
 * CF_R2_1_DIAGNOSTIC_SECRET, exclusivo de este endpoint (nunca
 * TURNSTILE_SECRET_KEY ni otro secreto existente), configurado únicamente
 * como secret de Cloudflare Pages en el entorno Preview — nunca en el
 * repositorio. Sin ese secreto configurado, o con el header ausente o
 * incorrecto, el endpoint falla cerrado antes de tocar R2.
 */
import { PAUSED_MANIFEST_URL } from '../_shared/catalog.js';
import { ensurePerf, serverTimingValue } from '../_shared/perf.js';
import { readObjectViaVariant, VARIANTS, customDomainBase } from '../_shared/r2-access.js';

const PAGES_PREVIEW_HOSTNAME_RE = /^[^.]+\.amadolibros-web\.pages\.dev$/;
const SECRET_HEADER = 'X-Perf-Verify-Secret';

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

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length === 0 || a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) {
    mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return mismatch === 0;
}

async function loadCurrentManifest() {
  const nonceUrl = `${PAUSED_MANIFEST_URL}?cf_r2_1=${crypto.randomUUID()}`;
  // Mismas opciones que fetchJsonCached() en _shared/catalog.js — sin
  // cf:{cacheTtl:0} ni Cache-Control:no-cache (ver commit f9ea995: esas
  // opciones desactivan el cacheo de borde propio de Cloudflare, distorsionan
  // la comparación). El nonce en la query ya garantiza una URL nueva en cada
  // llamada, sin necesitar desactivar nada.
  const response = await fetch(nonceUrl, { headers: { 'Accept-Encoding': 'identity' } });
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

  // Falla cerrado antes de tocar R2 o incluso el manifest: sin el secreto
  // configurado en este deployment, el endpoint se comporta como si no
  // existiera (404) — no hay forma de distinguir "falta configurar" de
  // "no existe" desde afuera. Con el secreto configurado pero el header
  // ausente o incorrecto, 401.
  const expectedSecret = typeof context.env?.CF_R2_1_DIAGNOSTIC_SECRET === 'string'
    ? context.env.CF_R2_1_DIAGNOSTIC_SECRET.trim()
    : '';
  if (!expectedSecret) return new Response('Not found', { status: 404 });

  const providedSecret = context.request.headers.get(SECRET_HEADER) || '';
  if (!timingSafeEqual(providedSecret, expectedSecret)) {
    return json({ error: 'No autorizado.' }, 401);
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
