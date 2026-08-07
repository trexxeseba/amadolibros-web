/**
 * Heartbeat opcional para el sync de catálogo.
 *
 * La Ping URL vive únicamente en SYNC_HEALTHCHECK_URL. Este módulo no la
 * registra, no lee el cuerpo de respuesta y nunca convierte un sync exitoso
 * en fallido por un problema del proveedor de monitoreo.
 */

const ALLOWED_HOSTS = new Set(['hc-ping.com']);
const HEALTHCHECK_TIMEOUT_MS = 5000;
const VALID_KINDS = new Set(['start', 'success', 'fail']);

function healthcheckTarget(rawUrl, kind) {
  if (!VALID_KINDS.has(kind)) return null;

  let base;
  try {
    base = new URL(String(rawUrl));
  } catch {
    return null;
  }

  if (
    base.protocol !== 'https:' ||
    !ALLOWED_HOSTS.has(base.hostname) ||
    (base.port && base.port !== '443') ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    return null;
  }

  const path = base.pathname.replace(/\/+$/, '');
  if (!path || path === '/') return null;
  base.pathname = kind === 'success' ? path : `${path}/${kind}`;
  return base.toString();
}
export async function notifyHealthcheck(env, kind, {
  fetchFn = globalThis.fetch,
  setTimeoutFn = globalThis.setTimeout,
  clearTimeoutFn = globalThis.clearTimeout,
  timeoutMs = HEALTHCHECK_TIMEOUT_MS,
} = {}) {
  const rawUrl = env?.SYNC_HEALTHCHECK_URL;
  if (!rawUrl) return { sent: false, reason: 'not-configured' };

  const target = healthcheckTarget(rawUrl, kind);
  if (!target) {
    console.warn('[Healthcheck] Configuración inválida; señal omitida.');
    return { sent: false, reason: 'invalid-config' };
  }

  const controller = new AbortController();
  const effectiveTimeoutMs = Math.min(
    HEALTHCHECK_TIMEOUT_MS,
    Math.max(1, Number(timeoutMs) || HEALTHCHECK_TIMEOUT_MS),
  );
  const timeoutId = setTimeoutFn(() => controller.abort(), effectiveTimeoutMs);

  try {
    const response = await fetchFn(target, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response?.ok) {
      console.warn(`[Healthcheck] El proveedor respondió HTTP ${response?.status ?? 'desconocido'}.`);
      return { sent: false, reason: 'http-error' };
    }
    return { sent: true };
  } catch (error) {
    const reason = error?.name === 'AbortError' ? 'timeout' : 'network-error';
    console.warn(`[Healthcheck] Señal no enviada (${reason}).`);
    return { sent: false, reason };
  } finally {
    clearTimeoutFn(timeoutId);
  }
}
