// Cliente de la API de Mercado Libre para los agentes diarios.
//
//  - Solo lectura por defecto: cualquier método que no sea GET se rechaza antes
//    de salir a la red, salvo que el cliente se cree con soloLectura: false.
//  - 429 y 5xx: espera exponencial con jitter y tope de reintentos. Un 429 pausa
//    a todas las llamadas en vuelo (pausa común). Las escrituras solo se
//    reintentan ante 429 (la API no las procesó); un 5xx en un POST/PUT/DELETE no
//    se repite a ciegas: el que llama tiene que releer el estado real.
//  - 401 con el token vigente: se invalida la fuente y se reintenta una vez.
//  - sonda(): igual que get() pero nunca tira por el código HTTP; devuelve
//    { status, ok, json } para confirmar endpoints sin romper la corrida.
import { ML_ORIGIN } from './config.mjs';

export class MlError extends Error {
  constructor(code, status = 0, path = '', detalle = null) { super(code); this.code = code; this.status = status; this.path = path; this.detalle = detalle; }
}

const sinQuery = p => String(p).split('?')[0];
const detalleDe = json => json && typeof json === 'object'
  ? { message: json.message ?? null, error: json.error ?? null, cause: Array.isArray(json.cause) ? json.cause.map(c => c?.code ?? c?.message ?? null).slice(0, 5) : null }
  : null;

export function crearCliente(fuente, {
  fetcher = (...a) => globalThis.fetch(...a), concurrencia = 4, intentos = 5, timeoutMs = 25000,
  sleep = ms => new Promise(r => setTimeout(r, ms)), random = Math.random, soloLectura = true,
} = {}) {
  const stats = { llamadas: 0, reintentos: 0, escrituras: 0, porStatus: {} };
  let activos = 0, pausaHasta = 0; const cola = [];
  const tomar = () => new Promise(r => { if (activos < concurrencia) { activos++; r(); } else cola.push(r); });
  const soltar = () => { activos--; const n = cola.shift(); if (n) { activos++; n(); } };
  const backoff = (intento, retryAfter) => Math.min(60_000, retryAfter ? retryAfter * 1000 : 1000 * 2 ** intento) + Math.floor(random() * 500);

  async function pedir(path, { method = 'GET', body, headers = {}, crudo = false } = {}) {
    if (method !== 'GET' && soloLectura) throw new MlError('solo_lectura', 0, sinQuery(path));
    await tomar();
    try {
      let reintento401 = false;
      for (let intento = 1; ; intento++) {
        const espera = pausaHasta - Date.now(); if (espera > 0) await sleep(espera);
        const token = await fuente.getToken();
        let res;
        try {
          res = await fetcher(ML_ORIGIN + path, {
            method, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
            headers: { Authorization: 'Bearer ' + token, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
            ...(body ? { body: JSON.stringify(body) } : {}),
          });
        } catch {
          stats.llamadas++;
          // Una escritura que no se sabe si llegó no se repite: el que llama relee.
          if (intento >= intentos || method !== 'GET') throw new MlError('transporte', 0, sinQuery(path));
          stats.reintentos++; await sleep(backoff(intento)); continue;
        }
        stats.llamadas++; if (method !== 'GET') stats.escrituras++;
        stats.porStatus[res.status] = (stats.porStatus[res.status] ?? 0) + 1;
        let json = null; try { json = await res.json(); } catch { json = null; }
        if (res.status === 401 && !reintento401) { reintento401 = true; fuente.invalidate(); continue; }
        const reintentable = res.status === 429 || (res.status >= 500 && method === 'GET');
        if (reintentable && intento < intentos) {
          const ms = backoff(intento, Number(res.headers?.get?.('retry-after')) || 0);
          stats.reintentos++;
          // 429: la pausa es común a todas las llamadas en vuelo; la espera la hace el
          // arranque del próximo intento. 5xx: espera solo esta llamada.
          if (res.status === 429) pausaHasta = Math.max(pausaHasta, Date.now() + ms); else await sleep(ms);
          continue;
        }
        if (crudo) return { status: res.status, ok: res.ok, json };
        if (res.ok) return json;
        throw new MlError(`http_${res.status}`, res.status, sinQuery(path), detalleDe(json));
      }
    } finally { soltar(); }
  }
  return {
    get: (p, o = {}) => pedir(p, { ...o, method: 'GET' }),
    sonda: (p, o = {}) => pedir(p, { ...o, method: 'GET', crudo: true }),
    post: (p, body, o = {}) => pedir(p, { ...o, method: 'POST', body }),
    put: (p, body, o = {}) => pedir(p, { ...o, method: 'PUT', body }),
    delete: (p, o = {}) => pedir(p, { ...o, method: 'DELETE' }),
    stats,
  };
}
