// Token de Mercado Libre leído de D1 por la API de Cloudflare.
//
// Nunca se renueva desde acá. El refresh token de ML es rotativo y de un solo
// uso: si esta herramienta lo renovara por su cuenta, le rompería la conexión al
// Worker (Libros) o al panel (Vintage). La renovación automática ya existe y la
// hacen ellos, con lock en D1. Si el token está vencido o por vencer, se espera
// a que lo renueven; si no aparece a tiempo, la corrida termina con error.
import { D1_DATABASE_ID } from './config.mjs';

const MARGEN_MS = 10 * 60 * 1000;
const errorToken = code => Object.assign(new Error(code), { code, fatal: true });

export function fuenteTokenD1(cuenta, {
  accountId = process.env.CLOUDFLARE_ACCOUNT_ID,
  apiTokens = [process.env.CLOUDFLARE_ADMIN_API_TOKEN, process.env.CLOUDFLARE_API_TOKEN].filter(Boolean),
  fetcher = (...a) => globalThis.fetch(...a),
  sleep = ms => new Promise(r => setTimeout(r, ms)),
  esperaMaxMs = 8 * 60 * 1000,
  pollMs = 30_000,
} = {}) {
  if (!accountId || !apiTokens.length) throw errorToken('faltan_secretos_cloudflare');
  const { tabla, appId } = cuenta.token;
  const sql = tabla === 'ml_oauth'
    ? { sql: 'SELECT access_token, access_expires_at FROM ml_oauth WHERE app_id = ?', params: [appId] }
    : { sql: 'SELECT access_token, access_expires_at FROM ml_oauth_sellers WHERE app_id = ? AND seller_id = ?', params: [appId, cuenta.sellerId] };
  let cache = null, rechazado = null, pendiente = null;

  async function leerFila() {
    let ultimo = 'cloudflare_sin_respuesta';
    for (const apiToken of apiTokens) {
      const res = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${D1_DATABASE_ID}/query`, {
        method: 'POST', headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(sql), signal: AbortSignal.timeout(20000),
      }).catch(() => null);
      if (!res) { ultimo = 'cloudflare_transporte'; continue; }
      const body = await res.json().catch(() => null);
      if (!res.ok || body?.success === false) { ultimo = `cloudflare_http_${res.status}`; continue; }
      const fila = body?.result?.[0]?.results?.[0];
      if (!fila) return { error: `${tabla}_sin_fila` };
      return { token: fila.access_token, vence: Number(fila.access_expires_at) };
    }
    return { error: ultimo };
  }
  async function cargar() {
    const limite = Date.now() + esperaMaxMs;
    for (;;) {
      const f = await leerFila();
      if (f.error) throw errorToken(f.error);
      if (f.token && f.vence - Date.now() > MARGEN_MS && f.token !== rechazado) { cache = f; return f.token; }
      if (Date.now() >= limite) throw errorToken(f.token === rechazado ? 'token_rechazado_por_ml' : 'token_vencido_sin_renovar');
      await sleep(pollMs);
    }
  }
  return {
    async getToken() {
      if (cache && cache.vence - Date.now() > MARGEN_MS) return cache.token;
      pendiente ??= cargar().finally(() => { pendiente = null; });
      return pendiente;
    },
    invalidate() { if (cache) rechazado = cache.token; cache = null; },
  };
}
