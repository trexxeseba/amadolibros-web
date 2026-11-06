// Cliente de la API de Mercado Libre: GET con reintentos limitados ante 429 y 5xx,
// concurrencia limitada. PUT aparte (escritura.mjs decide cuándo). Nunca loguea el token.
import { ML_ORIGIN } from '../config.mjs';

export class MlError extends Error {
  constructor(code, status = 0, path = '', detalle = null) { super(code); this.code = code; this.status = status; this.path = path; this.detalle = detalle; }
}

export function crearCliente(fuente, { fetcher = (...a) => globalThis.fetch(...a), concurrencia = 4, intentos = 4, sleep = ms => new Promise(r => setTimeout(r, ms)), timeoutMs = 25000 } = {}) {
  const stats = { llamadas: 0, reintentos: 0, porStatus: {}, puts: 0 };
  let activos = 0, pausaHasta = 0; const cola = [];
  const tomar = () => new Promise(r => { if (activos < concurrencia) { activos++; r(); } else cola.push(r); });
  const soltar = () => { activos--; const n = cola.shift(); if (n) { activos++; n(); } };

  async function pedir(path, { method = 'GET', body, reintentar = true } = {}) {
    await tomar();
    try {
      let tuvo401 = false;
      for (let intento = 1; ; intento++) {
        const espera = pausaHasta - Date.now(); if (espera > 0) await sleep(espera);
        const token = await fuente.getToken();
        let res;
        try {
          res = await fetcher(ML_ORIGIN + path, {
            method, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
            headers: { Authorization: 'Bearer ' + token, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}),
          });
        } catch (e) {
          stats.llamadas++;
          // Una escritura que no respondió NO se reintenta acá: quien escribe consulta el estado primero.
          if (method !== 'GET') throw new MlError(e?.name === 'TimeoutError' ? 'timeout' : 'transporte', 0, path);
          if (!reintentar || intento >= intentos) throw new MlError('transporte', 0, path);
          stats.reintentos++; await sleep(1000 * 2 ** intento); continue;
        }
        stats.llamadas++; stats.porStatus[res.status] = (stats.porStatus[res.status] ?? 0) + 1;
        if (method !== 'GET') stats.puts++;
        if (res.ok) { try { return await res.json(); } catch { return null; } }
        if (res.status === 401 && !tuvo401) { tuvo401 = true; fuente.invalidate(); continue; }
        if (res.status === 401) throw Object.assign(new MlError('http_401', 401, path), { fatal: true });
        if ((res.status === 429 || res.status >= 500) && reintentar && intento < intentos) {
          const ra = Number(res.headers.get('retry-after')) || 0;
          const ms = Math.min(60_000, ra ? ra * 1000 : 1000 * 2 ** intento);
          if (res.status === 429) pausaHasta = Math.max(pausaHasta, Date.now() + ms);
          stats.reintentos++; await sleep(ms); continue;
        }
        let detalle = null;
        try { const j = await res.json(); detalle = { message: j?.message ?? null, error: j?.error ?? null, cause: Array.isArray(j?.cause) ? j.cause.map(c => c?.code ?? c?.message ?? null).slice(0, 5) : null }; } catch {}
        throw new MlError(`http_${res.status}`, res.status, path, detalle);
      }
    } finally { soltar(); }
  }
  return {
    get: p => pedir(p),
    // reintentar=false: la escritura tiene su propio protocolo (escritura.mjs).
    put: (p, body) => pedir(p, { method: 'PUT', body, reintentar: false }),
    stats,
  };
}
