// Diagnóstico de sólo lectura. Nunca imprime informes, pedidos o credenciales.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exportAdminGa4 } from './admin-web-ga4-export.mjs';
import { webPeriod, readWebOrders, readWebEmails, readWebCatalog, readWebSync } from '../functions/_shared/admin-web-data.js';

const DATABASES = {
  preview: '6fa387af-f29e-46dc-97e5-30298568b4a6',
  production: '6dc8dc3a-2d4f-4045-b428-14323c7b0bcd',
};

export function connectionD1({ accountId, token, environment, fetchFn = fetch }) {
  if (!/^[a-f0-9]{32}$/.test(accountId || '') || !token || !Object.hasOwn(DATABASES, environment)) {
    throw new Error('D1_CONFIG_MISSING');
  }
  return { prepare(sql) {
    // Sólo las consultas SELECT del lector existente; nunca SQL de un usuario.
    if (!/^SELECT\b/i.test(sql.trim()) || /;|--|\/\*|\b(?:INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|ATTACH|PRAGMA)\b/i.test(sql)) {
      throw new Error('D1_READ_ONLY');
    }
    return { bind(...params) {
      const run = async () => {
        const response = await fetchFn(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${DATABASES[environment]}/query`, {
          method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ sql, params }), redirect: 'error', signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw new Error('D1_UNAVAILABLE');
        const body = await response.json();
        const result = body.result?.[0];
        if (body.success !== true || body.result?.length !== 1 || result?.success !== true ||
            !Array.isArray(result.results) || result.meta?.changed_db === true || result.meta?.rows_written > 0) {
          throw new Error('D1_RESPONSE_INVALID');
        }
        return { success: true, results: result.results };
      };
      return { all: run, first: async () => (await run()).results[0] || null };
    } };
  } };
}

const safeCheck = async (name, check) => {
  try { return { name, status: await check() }; }
  catch { return { name, status: 'unavailable' }; }
};

export async function checkAdminConnections({ source, env = process.env, now = new Date(), fetchFn = fetch }) {
  const checks = [];
  if (source === 'ga4') {
    for (const days of [7, 30]) checks.push(safeCheck(`ga4_${days}d`, async () => {
      await exportAdminGa4({ token: env.GA4_ACCESS_TOKEN, days, now, fetchFn, enrich: true });
      return 'ok';
    }));
  } else if (source === 'cloudflare') {
    for (const environment of ['preview', 'production']) checks.push(safeCheck(`orders_${environment}`, async () => {
      const ORDERS_DB = connectionD1({ accountId: env.CLOUDFLARE_ACCOUNT_ID, token: env.CLOUDFLARE_API_TOKEN, environment, fetchFn });
      const period = webPeriod(7, now);
      const [orders, emails] = await Promise.all([readWebOrders({ ORDERS_DB }, period), readWebEmails({ ORDERS_DB }, period)]);
      return orders.status === 'ok' && emails.status === 'ok' ? 'ok' : 'unavailable';
    }));
  } else if (source === 'catalog') {
    checks.push(safeCheck('catalog', async () => (await readWebCatalog('', 0, fetchFn)).status));
    checks.push(safeCheck('catalog_updated_at', async () => (await readWebSync(fetchFn, now)).status));
  } else {
    throw new Error('SOURCE_INVALID: elegir ga4, cloudflare o catalog');
  }
  return { checkedAt: now.toISOString(), readOnly: true, checks: await Promise.all(checks) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await checkAdminConnections({ source: process.argv[2] });
    // Este repo es público: sólo se publica estado de conectividad, jamás métricas.
    console.log(JSON.stringify(result, null, 2));
    if (result.checks.some(c => !['ok', 'stale'].includes(c.status))) process.exitCode = 1;
  } catch { console.error('Diagnóstico no ejecutado: configuración inválida.'); process.exitCode = 1; }
}
