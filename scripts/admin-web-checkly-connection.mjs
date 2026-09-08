// Diagnóstico de sólo lectura de la cuenta mostrada por Seba. No crea monitores.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export const AMADO_CHECKLY_ACCOUNT = '8ff2dfcb-7cf5-4962-9eab-c6dde8763c0d';
export async function checkChecklyConnection({ env = process.env, fetchFn = fetch } = {}) {
  if (!env.CHECKLY_API_KEY) return { status: 'needs_key', authenticated: false, writes: 0 };
  const response = await fetchFn('https://api.checklyhq.com/v1/checks', { method: 'GET', redirect: 'manual',
    signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${env.CHECKLY_API_KEY}`,
      'X-Checkly-Account': AMADO_CHECKLY_ACCOUNT, Accept: 'application/json' } });
  if (!response.ok) throw new Error(`CHECKLY_HTTP_${response.status}`);
  const checks = await response.json();
  if (!Array.isArray(checks)) throw new Error('CHECKLY_RESPONSE_INVALID');
  // No imprimir nombres, scripts, destinos, datos de cuenta ni secretos del proveedor.
  return { status: 'read_access_verified', authenticated: true, writes: 0 };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await checkChecklyConnection())); }
  catch (error) { console.error(/^CHECKLY_[A-Z0-9_]+$/.test(error.message) ? error.message : 'CHECKLY_CONNECTION_FAILED'); process.exitCode = 1; }
}
