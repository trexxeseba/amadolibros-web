// Dispara la conciliación de pagos de Mercado Pago, que corre en Pages.
//
// La conciliación vive en Pages porque ahí están las credenciales de Mercado
// Pago; este Worker sólo pone el reloj. El llamado no lleva credenciales ni
// datos: Pages decide solo si corre (se limita a una vez cada pocos minutos)
// y aplica cada pago con las mismas validaciones que el aviso firmado.

const PATH = '/api/payments/reconcile';
const TIMEOUT_MS = 25000;

export async function triggerPaymentsReconcile(env, { fetchFn = globalThis.fetch } = {}) {
  const origin = typeof env?.CANONICAL_ORIGIN === 'string' ? env.CANONICAL_ORIGIN.trim() : '';
  if (env?.APP_ENV !== 'production' || !/^https:\/\/[a-z0-9.-]+$/.test(origin)) {
    return { status: 'skipped' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchFn(origin + PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Amado-Worker-Sync/1.0' },
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
