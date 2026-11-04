// Cliente de la API de Mercado Libre: reintentos con espera ante 429 y 5xx,
// pausa común ante un 429, concurrencia limitada. Las escrituras (PUT) pasan
// por el mismo cliente pero sólo se llaman fuera de DRY_RUN.
import { ML_ORIGIN } from './config.mjs';

export class MlError extends Error {
  constructor(code, status = 0, path = '', detalle = null) { super(code); this.code = code; this.status = status; this.path = path; this.detalle = detalle; }
}

export function crearCliente(fuente, { fetcher = (...a) => globalThis.fetch(...a), concurrencia = 4, intentos = 5, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const stats = { llamadas: 0, reintentos: 0, porStatus: {} };
  let activos = 0, pausaHasta = 0; const cola = [];
  const tomar = () => new Promise(r => { if (activos < concurrencia) { activos++; r(); } else cola.push(r); });
  const soltar = () => { activos--; const n = cola.shift(); if (n) { activos++; n(); } };

  async function pedir(path, { method = 'GET', body } = {}) {
    await tomar();
    try {
      let reintento401 = false;
      for (let intento = 1; ; intento++) {
        const espera = pausaHasta - Date.now(); if (espera > 0) await sleep(espera);
        const token = await fuente.getToken();
        let res;
        try {
          res = await fetcher(ML_ORIGIN + path, {
            method, redirect: 'manual', signal: AbortSignal.timeout(25000),
            headers: { Authorization: 'Bearer ' + token, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}),
          });
        } catch {
          stats.llamadas++;
          if (intento >= intentos) throw new MlError('transporte', 0, path);
          stats.reintentos++; await sleep(600 * 2 ** intento); continue;
        }
        stats.llamadas++; stats.porStatus[res.status] = (stats.porStatus[res.status] ?? 0) + 1;
        if (res.ok) { try { return await res.json(); } catch { return null; } }
        if (res.status === 401 && !reintento401) { reintento401 = true; fuente.invalidate(); continue; }
        if ((res.status === 429 || res.status >= 500) && intento < intentos) {
          const ra = Number(res.headers.get('retry-after')) || 0;
          const ms = Math.min(60_000, ra ? ra * 1000 : 1000 * 2 ** intento);
          if (res.status === 429) pausaHasta = Math.max(pausaHasta, Date.now() + ms);
          stats.reintentos++; await sleep(ms); continue;
        }
        // El cuerpo de error de ML no trae datos sensibles: sirve para diagnosticar (sin token).
        let detalle = null;
        try { const j = await res.json(); detalle = { message: j?.message ?? null, error: j?.error ?? null, cause: Array.isArray(j?.cause) ? j.cause.map(c => c?.code ?? c?.message ?? null).slice(0, 5) : null }; } catch {}
        throw new MlError(`http_${res.status}`, res.status, path, detalle);
      }
    } finally { soltar(); }
  }
  return { get: p => pedir(p), put: (p, body) => pedir(p, { method: 'PUT', body }), stats };
}
