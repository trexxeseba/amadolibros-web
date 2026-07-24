// Resolver de configuración centralizado — usado por todos los handlers de pagos/pedidos.
//
// El ambiente (APP_ENV) es siempre explícito, nunca inferido de Host, token,
// live_mode o rama Git. Cualquier valor ausente o inválido hace fallar el
// resolver por completo (fail-closed) — no hay valores por defecto silenciosos
// ni fallback cruzado entre Preview y Production.

const VALID_APP_ENVS = new Set(['preview', 'production']);

// Hostnames *.amadolibros-web.pages.dev de Cloudflare Pages son dinámicos
// (un hash nuevo por deploy) y no se pueden enumerar en una lista exacta.
// Se valida por comparación exacta de labels del hostname — no por
// substring/endsWith sobre el string completo — para que no exista una
// forma de construir un hostname externo que la pase.
const PAGES_PROJECT_LABELS = ['amadolibros-web', 'pages', 'dev'];

function isPagesPreviewHostname(hostname) {
  const labels = hostname.split('.');
  // Exactamente 4 labels: <deployment-o-alias>.amadolibros-web.pages.dev
  if (labels.length !== 4) return false;
  const tail = labels.slice(1);
  return tail[0] === PAGES_PROJECT_LABELS[0] &&
         tail[1] === PAGES_PROJECT_LABELS[1] &&
         tail[2] === PAGES_PROJECT_LABELS[2];
}

function parseAllowedHosts(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const hosts = raw.split(',').map(h => h.trim()).filter(Boolean);
  if (hosts.length === 0) return null;
  return hosts;
}

function parseCanonicalOrigin(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let u;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  if (u.pathname !== '/' && u.pathname !== '') return null;
  if (u.search || u.hash) return null;
  if (u.username || u.password) return null;
  return u.origin;
}

function parseCollectorId(raw) {
  if (typeof raw !== 'string' || !/^[1-9][0-9]*$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) return null;
  return n;
}

/**
 * Resuelve y valida toda la configuración de ambiente a partir de `env`
 * (los bindings/vars/secrets de Cloudflare Pages Functions).
 *
 * Devuelve `{ ok: false, code }` si cualquier pieza requerida falta o es
 * inválida — el llamador debe responder fail-closed (503), nunca continuar
 * con un valor supuesto.
 */
export function resolveConfig(env) {
  const appEnv = env?.APP_ENV;
  if (!VALID_APP_ENVS.has(appEnv)) {
    return { ok: false, code: 'APP_ENV_INVALID' };
  }

  const mpCollectorId = parseCollectorId(env?.MP_COLLECTOR_ID);
  if (mpCollectorId === null) {
    return { ok: false, code: 'MP_COLLECTOR_ID_INVALID' };
  }

  const canonicalOrigin = parseCanonicalOrigin(env?.CANONICAL_ORIGIN);
  if (!canonicalOrigin) {
    return { ok: false, code: 'CANONICAL_ORIGIN_INVALID' };
  }

  const isProduction = appEnv === 'production';

  // Hostnames aceptados para RECIBIR solicitudes (distinto del origen
  // canónico usado para GENERAR URLs — nunca se derivan uno del otro).
  let isAllowedRequestHost;
  if (isProduction) {
    const allowedHosts = parseAllowedHosts(env?.ALLOWED_HOSTS);
    if (!allowedHosts) return { ok: false, code: 'ALLOWED_HOSTS_INVALID' };
    const allowedSet = new Set(allowedHosts);
    isAllowedRequestHost = (hostname) => allowedSet.has(hostname);
  } else {
    // Preview: estructural, no depende de una lista project-wide (los
    // deployments de Preview cambian de hostname en cada build).
    isAllowedRequestHost = isPagesPreviewHostname;
  }

  // Hostname esperado por Turnstile (validación server-side del claim
  // `hostname` que devuelve siteverify) — mismo criterio que arriba.
  const isExpectedTurnstileHostname = isAllowedRequestHost;

  const checkoutEnabled = env?.CHECKOUT_ENABLED === 'true';

  return {
    ok: true,
    appEnv,
    isProduction,
    mpCollectorId,
    canonicalOrigin,
    isAllowedRequestHost,
    isExpectedTurnstileHostname,
    checkoutEnabled,
    // Preview opera contra Mercado Pago TEST (live_mode:false esperado);
    // Production opera contra Mercado Pago LIVE (live_mode:true esperado).
    // No es una combinación configurable — se deriva 1:1 de appEnv.
    expectedLiveMode: isProduction,
  };
}

export function checkoutDisabledResponse() {
  return new Response(
    JSON.stringify({ error: 'Checkout no disponible en este momento.', code: 'checkout_temporarily_unavailable' }),
    { status: 503, headers: { 'Content-Type': 'application/json;charset=UTF-8', 'Cache-Control': 'no-store' } }
  );
}
