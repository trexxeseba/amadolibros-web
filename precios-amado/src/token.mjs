// De dónde sale el token de Mercado Libre. Dos fuentes, en este orden:
//
//  1. "worker" — el token de usuario que el Worker de sync mantiene en D1
//     (tabla ml_oauth, app 4741021817925208). Se LEE por la API de Cloudflare y
//     nunca se renueva desde acá: la renovación es del Worker (refresh token
//     rotativo de un solo uso, con lock en D1). Si está por vencer, se espera a
//     que el Worker lo renueve. Es el único que lee /items/bulk de terceros, que
//     es donde está el plazo de preparación de los competidores.
//  2. "app" — client_credentials de la app de mlu-monitor (sin refresh token,
//     no interfiere con nadie). Lee nuestras publicaciones, las fichas y
//     price_to_win, pero /items/bulk de terceros responde 403: sin plazos.
import { loadCredentials, ML_ORIGIN } from './config.mjs';

export const WORKER_APP_ID = '4741021817925208';
const D1_DATABASE_ID = '6dc8dc3a-2d4f-4045-b428-14323c7b0bcd'; // amadolibros-orders-production (worker-sync/wrangler.toml)
const MARGIN_MS = 5 * 60 * 1000;

export function workerTokenSource({ accountId = process.env.CLOUDFLARE_ACCOUNT_ID, apiTokens = [process.env.CLOUDFLARE_D1_API_TOKEN, process.env.CLOUDFLARE_ADMIN_API_TOKEN, process.env.CLOUDFLARE_API_TOKEN].filter(Boolean), fetcher = (...a) => globalThis.fetch(...a), sleep = ms => new Promise(r => setTimeout(r, ms)), maxWaitMs = 7 * 60 * 1000 } = {}) {
  if (!accountId || !apiTokens.length) return null;
  let cached = null;
  async function readRow() {
    let last = 'sin_token_cloudflare';
    for (const apiToken of apiTokens) {
      const res = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${D1_DATABASE_ID}/query`, {
        method: 'POST', headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql: 'SELECT access_token, access_expires_at FROM ml_oauth WHERE app_id = ?', params: [WORKER_APP_ID] }),
        signal: AbortSignal.timeout(20000),
      }).catch(() => null);
      if (!res) { last = 'cloudflare_transport'; continue; }
      const body = await res.json().catch(() => null);
      if (!res.ok || body?.success === false) { last = `cloudflare_http_${res.status}`; continue; }
      const row = body?.result?.[0]?.results?.[0];
      if (!row) return { error: 'ml_oauth_vacia' };
      return { token: row.access_token, expiresAt: Number(row.access_expires_at) };
    }
    return { error: last };
  }
  async function getToken({ force = false } = {}) {
    if (!force && cached && cached.expiresAt - Date.now() > MARGIN_MS) return cached.token;
    const deadline = Date.now() + maxWaitMs;
    for (;;) {
      const row = await readRow();
      if (row.error) throw Object.assign(new Error(row.error), { code: row.error });
      if (row.token && row.expiresAt - Date.now() > MARGIN_MS && row.token !== (force ? cached?.token : null)) { cached = row; return row.token; }
      // Vencido o por vencer: lo renueva el Worker (cron cada 5 minutos). Esperar, no refrescar.
      if (Date.now() > deadline) throw Object.assign(new Error('token_worker_vencido'), { code: 'token_worker_vencido' });
      await sleep(30_000);
    }
  }
  return { name: 'worker', getToken, invalidate: () => { cached = null; }, terceros: true };
}

export function appTokenSource({ fetcher = (...a) => globalThis.fetch(...a) } = {}) {
  let creds;
  try { creds = loadCredentials(); } catch { return null; }
  let token = null, exp = 0;
  async function getToken({ force = false } = {}) {
    if (!force && token && exp - Date.now() > 60_000) return token;
    const res = await fetcher(ML_ORIGIN + '/oauth/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: creds.app_id, client_secret: creds.client_secret }),
      signal: AbortSignal.timeout(20000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) throw Object.assign(new Error('auth_failed'), { code: 'auth_failed' });
    token = data.access_token; exp = Date.now() + (Number(data.expires_in) || 3600) * 1000;
    return token;
  }
  return { name: 'app', getToken, invalidate: () => { token = null; }, terceros: false, origen: creds.origen };
}

export function pickTokenSource(pref = process.env.PRECIOS_TOKEN_SOURCE || 'auto') {
  const w = pref !== 'app' ? workerTokenSource() : null;
  if (w) return w;
  const a = pref !== 'worker' ? appTokenSource() : null;
  if (a) return a;
  throw new Error('No hay fuente de token: faltan CLOUDFLARE_ACCOUNT_ID + token de Cloudflare (D1) o credenciales de app (ML_PRECIOS_APP_ID/ML_PRECIOS_CLIENT_SECRET o ~/.amado-precios/credentials.json)');
}
