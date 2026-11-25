// Dispara la conciliación de pagos de Mercado Pago, que corre en Pages.
//
// La conciliación vive en Pages porque ahí están las credenciales de Mercado
// Pago; este Worker sólo pone el reloj. El llamado no lleva datos: va firmado
// (HMAC con RECONCILE_SECRET, la clave no viaja) para que Pages sepa que viene
// de este Worker. Pages decide solo si corre (una vez cada pocos minutos) y
// aplica cada pago con las mismas validaciones que el aviso firmado.
import { signServiceRequest } from '../functions/_shared/service-auth.js';

const PATH = '/api/payments/reconcile';
const TIMEOUT_MS = 25000;

export async function triggerPaymentsReconcile(env, { fetchFn = globalThis.fetch } = {}) {
  const origin = typeof env?.CANONICAL_ORIGIN === 'string' ? env.CANONICAL_ORIGIN.trim() : '';
  if (env?.APP_ENV !== 'production' || !/^https:\/\/[a-z0-9.-]+$/.test(origin)) {
    return { status: 'skipped' };
  }
  const secret = typeof env?.RECONCILE_SECRET === 'string' ? env.RECONCILE_SECRET : '';
  if (secret.length < 16) return { status: 'error', http: 0, error: 'SinClave' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const signed = await signServiceRequest(secret, { method: 'POST', path: PATH });
    const response = await fetchFn(origin + PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Amado-Worker-Sync/1.0', ...signed },
      body: '{}',
      redirect: 'manual',
      signal: controller.signal,
    });
    return { status: response.ok ? 'ok' : 'error', http: response.status };
  } catch (error) {
    return { status: 'error', http: 0, error: error?.name || 'Error' };
  } finally {
    clearTimeout(timer);
  }
}
