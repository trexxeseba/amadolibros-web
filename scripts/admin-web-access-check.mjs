// Consulta configuración disponible sin exponer emails, políticas, IDs ni tokens.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function checkAdminAccessConfiguration({ env = process.env, fetchFn = fetch } = {}) {
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!/^[a-f0-9]{32}$/.test(account || '') || !token) throw new Error('CONFIG_MISSING');
  const checks = [
    ['access_organization', 'access/organizations'],
    ['access_applications', 'access/apps?per_page=50'],
    ['analytics_storage', 'storage/kv/namespaces?per_page=100'],
    ['worker_hostname', 'workers/subdomain'],
  ];
  return Promise.all(checks.map(async ([name, path]) => {
    try {
      const response = await fetchFn(`https://api.cloudflare.com/client/v4/accounts/${account}/${path}`, {
        method: 'GET', headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(15000),
      });
      const body = await response.json();
      if (!response.ok || body.success !== true) return { name, status: 'unavailable', http: response.status,
        codes: (body.errors || []).map(e => e.code).filter(Number.isSafeInteger).slice(0, 5) };
      return { name, status: 'ok', http: response.status };
    } catch { return { name, status: 'unavailable' }; }
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const checks = await checkAdminAccessConfiguration();
    console.log(JSON.stringify({ checkedAt: new Date().toISOString(), readOnly: true, checks }, null, 2));
    if (checks.some(c => c.status !== 'ok')) process.exitCode = 1;
  } catch { console.error('Configuración de conexión ausente.'); process.exitCode = 1; }
}
