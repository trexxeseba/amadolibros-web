import { initLedger, readLedger, runGeneration, periodOf, ledgerKey, USAGE_SOURCE, GENERATION_CAP_CEILING } from './card-generation.js';

// Worker TEMPORAL de Preview para el piloto de variantes v2. Sin ruta pública:
// todo exige un token generado por ejecución. Las operaciones permitidas se
// imponen aquí en código, no sólo por convención: cualquier otra clave, método o
// bucket lanza antes de tocar R2.
export const PREVIEW_BUCKET = 'amadolibros-images-preview';
export const SOURCE_BUCKET = 'amadolibros-images-production';
export const PILOT_MAX_NEW_ATTEMPTS = 32; // el piloto jamás puede reservar más intentos nuevos que esto (30 + 2 para el ensayo de cupo agotado)
export const PILOT_PLAN_MAX_ITEMS = 10;
export const PILOT_RUN_LIMIT_MAX = 32;
const V2_KEY = /^covers\/variants\/v2\/[a-f0-9]{64}\/v2-(?:240|360|480)-q85\.webp$/;
const LEDGER_KEY = /^covers\/generation-ledger\/v2\/\d{4}-\d{2}\/ledger\.json$/;
const SOURCE_READ_KEY = /^covers\/(?:v1\/objects\/[a-f0-9]{64}\.(?:jpg|png|webp)|variants\/v1\/[a-f0-9]{64}\/v1-\d+-q\d+\.webp)$/;

function deny(operation, key) { throw new Error(`pilot-operation-denied:${operation}`); }

// Preview: leer/escribir sólo el libro mayor y las variantes v2.
export function previewFacade(bucket) {
  const allowed = key => LEDGER_KEY.test(key) || V2_KEY.test(key);
  return {
    get: key => allowed(key) ? bucket.get(key) : deny('get', key),
    head: key => allowed(key) ? bucket.head(key) : deny('head', key),
    put: (key, value, options) => allowed(key) ? bucket.put(key, value, options) : deny('put', key),
  };
}

// Producción: SÓLO get/head de masters y de variantes v1. No hay put/delete/list.
export function sourceFacade(bucket) {
  const allowed = key => SOURCE_READ_KEY.test(key);
  return {
    get: key => allowed(key) ? bucket.get(key) : deny('get', key),
    // HEAD (nunca GET) del manifest: sólo para comprobar antes/después que producción no cambió.
    head: key => allowed(key) || key === 'covers/v1/manifest.json' ? bucket.head(key) : deny('head', key),
  };
}

const json = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
async function body(request) {
  const text = await request.text();
  if (text.length > 200_000) throw new Error('body-too-large');
  return JSON.parse(text);
}

export default {
  async fetch(request, env) {
    if (!env.PILOT_TOKEN || request.headers.get('authorization') !== `Bearer ${env.PILOT_TOKEN}`) return new Response('Forbidden', { status: 403 });
    if (env.PILOT_MODE !== 'preview-card-generation' || env.PREVIEW_BUCKET_NAME !== PREVIEW_BUCKET ||
        env.SOURCE_BUCKET_NAME !== SOURCE_BUCKET || !env.COVER_R2 || !env.PRODUCTION_COVERS_READONLY || typeof env.IMAGES?.input !== 'function')
      return json({ error: 'misconfigured' }, 503);
    const url = new URL(request.url);
    const preview = previewFacade(env.COVER_R2), source = sourceFacade(env.PRODUCTION_COVERS_READONLY);
    try {
      if (url.pathname === '/ready' && request.method === 'GET') return json({ head: env.PILOT_BUILD_SHA || null });
      if (url.pathname === '/status' && request.method === 'GET') {
        const { ledger } = await readLedger(preview, periodOf(Date.now()));
        return json({ ledger });
      }
      if (url.pathname === '/init' && request.method === 'POST') {
        const { maxNewAttempts, usage } = await body(request);
        if (!Number.isSafeInteger(maxNewAttempts) || maxNewAttempts < 1 || maxNewAttempts > PILOT_MAX_NEW_ATTEMPTS) return json({ error: 'pilot-cap-exceeded' }, 400);
        if (usage?.source !== USAGE_SOURCE) return json({ error: 'usage-unavailable' }, 400);
        // El techo absoluto de la cuenta es siempre el de código (30.000); el piloto sólo añade el tope relativo.
        const ledger = await initLedger(preview, { now: Date.now(), capAttempts: GENERATION_CAP_CEILING, maxNewAttempts, usage });
        return json({ initialized: true, period: ledger.period, cap_attempts: ledger.cap_attempts, max_new_attempts: ledger.max_new_attempts, prior_consumed: ledger.prior_consumed });
      }
      if (url.pathname === '/run' && request.method === 'POST') {
        const { plan, approval, usage, limit } = await body(request);
        if (!Array.isArray(plan?.items) || plan.items.length > PILOT_PLAN_MAX_ITEMS) return json({ error: 'pilot-plan-too-large' }, 400);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > PILOT_RUN_LIMIT_MAX) return json({ error: 'pilot-limit-exceeded' }, 400);
        const result = await runGeneration({ bucket: preview, sourceBucket: source, images: env.IMAGES, plan, approval, usage,
          limit, holder: crypto.randomUUID() });
        return json(result);
      }
      // Descarga de un v2 ya generado, sólo para la comparación de calidad.
      const object = /^\/object\/([a-f0-9]{64})\/(v2-(?:240|360|480)-q85)$/.exec(url.pathname);
      if (object && request.method === 'GET') {
        const key = `covers/variants/v2/${object[1]}/${object[2]}.webp`;
        const found = await preview.get(key);
        if (!found?.body) return json({ error: 'not-found' }, 404);
        return new Response(found.body, { headers: { 'content-type': 'image/webp', 'cache-control': 'no-store',
          'x-variant-metadata': JSON.stringify(found.customMetadata || {}) } });
      }
      if (url.pathname === '/production-etag' && request.method === 'GET') {
        const head = await source.head('covers/v1/manifest.json');
        return json({ etag: head?.etag ?? null, size: head?.size ?? null });
      }
      // Sólo lectura de producción para la propuesta y la comparación: ¿qué recetas v1 existen
      // para este master? (HEAD de tres claves; sin listar el bucket).
      const probe = /^\/probe-v1\/([a-f0-9]{64})$/.exec(url.pathname);
      if (probe && request.method === 'GET') {
        const present = [];
        for (const width of [240, 360, 480]) {
          const id = `v1-${width}-q85`;
          const head = await source.head(`covers/variants/v1/${probe[1]}/${id}.webp`);
          if (head?.size > 0 && head.customMetadata?.master_sha256 === probe[1] && head.customMetadata.recipe === id) present.push(id);
        }
        return json({ hash: probe[1], present });
      }
      // El master original, para que la comparación con Sharp parta de los mismos bytes.
      const master = /^\/master\/([a-f0-9]{64}\.(?:jpg|png|webp))$/.exec(url.pathname);
      if (master && request.method === 'GET') {
        const found = await source.get(`covers/v1/objects/${master[1]}`);
        if (!found?.body || found.size > 8 * 1024 * 1024) return json({ error: 'not-found' }, 404);
        return new Response(found.body, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' } });
      }
      return json({ error: 'not-found' }, 404);
    } catch (error) {
      const code = /^(pilot-operation-denied:\w+|ledger-exists|ledger-missing|invalid-cap|invalid-max-new-attempts|usage-unavailable|invalid-prior-consumed|body-too-large)$/.test(error?.message)
        ? error.message : 'pilot-error';
      return json({ error: code }, code === 'pilot-error' ? 500 : 400);
    }
  },
};
export { ledgerKey };
