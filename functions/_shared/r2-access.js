/**
 * functions/_shared/r2-access.js
 *
 * CF-R2-1 — lector de objetos R2 aislado por método de acceso, usado
 * exclusivamente por functions/api/cf-r2-1.js para comparar:
 *   - r2dev:        fetch() HTTP contra el bucket público *.r2.dev (actual).
 *   - binding:       binding R2 nativo del Worker (env.CATALOG_BUCKET.get()).
 *   - customdomain:  fetch() HTTP contra un dominio propio conectado al bucket.
 *
 * Decisión de diseño (documentada, no implícita): esta comparación NUNCA usa
 * caches.default. El mecanismo existente para forzar una lectura fría real
 * (functions/api/perf-verify.js) exige una sesión autorizada por Turnstile
 * humano, atada a la IP de quien la crea — no hay forma segura de que este
 * proceso la reutilice para disparar 15+ purgas automáticas sin simular o
 * saltear Turnstile, algo explícitamente prohibido. En vez de eso, cada
 * variante lee siempre directo del origen (r2.dev, binding o dominio propio),
 * nunca desde la Cache API de Cloudflare — así cada lectura es intrínsecamente
 * "fría" por construcción, sin necesitar purga ni sesión. Como nunca se
 * escribe en caches.default, esta comparación no introduce ninguna clave de
 * caché nueva y el mecanismo de purga de PERF-VERIFY-1 (manifestCacheKeys)
 * queda exactamente como estaba — no hace falta tocarlo.
 */
import { perfNow, recordPerf } from './perf.js';

export const R2_DEV_BASE = 'https://pub-b2b408811ae24e3da04cda79c6ff084d.r2.dev';

export const VARIANTS = ['r2dev', 'binding', 'customdomain'];

export function customDomainBase(ctx) {
  const raw = ctx?.env?.R2_CUSTOM_DOMAIN;
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return null;
  return value.startsWith('http://') || value.startsWith('https://')
    ? value.replace(/\/+$/u, '')
    : `https://${value.replace(/\/+$/u, '')}`;
}

/**
 * Lee un objeto de R2 por la variante indicada. Siempre origen directo,
 * nunca caches.default (ver nota de diseño arriba). Registra segmentos
 * Server-Timing `${timingName}_origin` (tiempo hasta tener la respuesta/
 * objeto) y `${timingName}_body` (tiempo de lectura completa del cuerpo).
 *
 * @returns {{ok:true, bytes:Uint8Array, method:string, upstream_cf_ray?:string}
 *          | {ok:false, code:string, detail?:string}}
 */
export async function readObjectViaVariant(ctx, variant, key, timingName) {
  if (!VARIANTS.includes(variant)) return { ok: false, code: 'unknown_variant' };
  if (typeof key !== 'string' || !key) return { ok: false, code: 'invalid_key' };

  if (variant === 'binding') {
    const bucket = ctx?.env?.CATALOG_BUCKET;
    if (!bucket || typeof bucket.get !== 'function') {
      return { ok: false, code: 'binding_missing' };
    }
    const originStartedAt = perfNow();
    let object;
    try {
      object = await bucket.get(key);
    } catch (error) {
      return { ok: false, code: 'binding_error', detail: safeErrorMessage(error) };
    }
    recordPerf(ctx, `${timingName}_origin`, originStartedAt);
    if (!object || typeof object.arrayBuffer !== 'function') {
      return { ok: false, code: 'not_found' };
    }
    const bodyStartedAt = perfNow();
    let bytes;
    try {
      bytes = new Uint8Array(await object.arrayBuffer());
    } catch (error) {
      return { ok: false, code: 'body_read_error', detail: safeErrorMessage(error) };
    }
    recordPerf(ctx, `${timingName}_body`, bodyStartedAt, { bytes: bytes.byteLength });
    return { ok: true, bytes, method: 'binding' };
  }

  let base;
  if (variant === 'r2dev') {
    base = R2_DEV_BASE;
  } else {
    base = customDomainBase(ctx);
    if (!base) return { ok: false, code: 'custom_domain_not_configured' };
  }

  const url = `${base}/${key}`;
  const originStartedAt = perfNow();
  let response;
  try {
    // Mismas opciones exactas que fetchGzipJsonCached() en _shared/catalog.js
    // — nada de `cf: { cacheTtl: 0 }` ni `Cache-Control: no-cache`. Agregar
    // esas opciones aquí sería introducir una segunda variable (desactivar
    // el cacheo de borde propio de Cloudflare para el subrequest) además del
    // método de acceso, rompiendo el aislamiento que pide CF-R2-1. r2.dev es
    // contenido público servido por la CDN de Cloudflare — comparar contra
    // ese comportamiento normal es correcto; forzarlo a bypasear su propio
    // borde no lo sería.
    response = await fetch(url, { headers: { 'Accept-Encoding': 'identity' } });
  } catch (error) {
    return { ok: false, code: 'fetch_error', detail: safeErrorMessage(error) };
  }
  recordPerf(ctx, `${timingName}_origin`, originStartedAt);
  if (!response.ok) return { ok: false, code: `http_${response.status}` };
  const bodyStartedAt = perfNow();
  let bytes;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    return { ok: false, code: 'body_read_error', detail: safeErrorMessage(error) };
  }
  recordPerf(ctx, `${timingName}_body`, bodyStartedAt, { bytes: bytes.byteLength });
  return {
    ok: true,
    bytes,
    method: variant,
    upstream_cf_ray: response.headers.get('cf-ray') || null,
  };
}

function safeErrorMessage(error) {
  return error && typeof error === 'object' && typeof error.message === 'string'
    ? error.message.slice(0, 200)
    : 'error';
}
