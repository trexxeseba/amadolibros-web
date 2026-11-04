// Cliente mínimo de la API de Mercado Libre: reintentos acotados (429 y 5xx),
// pausa común ante un 429, límite de concurrencia y contador de llamadas.
// Sólo GET: esta herramienta no escribe nada en Mercado Libre.
import { ML_ORIGIN } from './config.mjs';

export class MlError extends Error {
  constructor(code, status = 0, path = '') { super(code); this.code = code; this.status = status; this.path = path; }
}

export function createMlClient(source, { fetcher = (...a) => globalThis.fetch(...a), concurrency = 4, maxAttempts = 4, timeoutMs = 20000, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const stats = { calls: 0, retries: 0, errors: 0, byStatus: {} };
  let active = 0; const queue = [];
  let pausaHasta = 0; // un 429 frena a toda la cola, no sólo al que lo recibió
  const acquire = () => new Promise(res => { if (active < concurrency) { active++; res(); } else queue.push(res); });
  const release = () => { active--; const n = queue.shift(); if (n) { active++; n(); } };
  const esperarPausa = async () => { const ms = pausaHasta - Date.now(); if (ms > 0) await sleep(ms); };

  async function get(path) {
    await acquire();
    try {
      let refrescado = false;
      for (let attempt = 1; ; attempt++) {
        await esperarPausa();
        let token;
        try { token = await source.getToken(); }
        catch (e) { stats.tokenFatal ??= e?.code ?? 'token_error'; throw new MlError(e?.code ?? 'token_error', 0, path); } // error de token: no reintentar a ciegas
        let res;
        try {
          res = await fetcher(ML_ORIGIN + path, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
        } catch {
          stats.calls++; stats.errors++;
          if (attempt >= maxAttempts) throw new MlError('transport', 0, path);
          stats.retries++; await sleep(500 * 2 ** attempt); continue;
        }
        stats.calls++; stats.byStatus[res.status] = (stats.byStatus[res.status] ?? 0) + 1;
        if (res.ok) { try { return await res.json(); } catch { throw new MlError('bad_json', res.status, path); } }
        if (res.status === 401 && !refrescado) { refrescado = true; source.invalidate(); stats.retries++; continue; }
        if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
          const ra = Number(res.headers.get('retry-after')) || 0;
          const ms = Math.min(30_000, ra ? ra * 1000 : 800 * 2 ** attempt);
          if (res.status === 429) pausaHasta = Math.max(pausaHasta, Date.now() + ms);
          stats.retries++; await sleep(ms); continue;
        }
        stats.errors++;
        throw new MlError(`http_${res.status}`, res.status, path);
      }
    } finally { release(); }
  }
  return { get, stats, source: source.name };
}
