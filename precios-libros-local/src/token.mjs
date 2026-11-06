// Token de Mercado Libre para el motor local. Nunca se renueva desde acá y nunca se
// imprime. Dos fuentes, en este orden:
//   1. ML_ACCESS_TOKEN (pegado a mano para la simulación; dura lo que diga ML).
//   2. El Worker: GET {PRICING_TOKEN_URL} con Authorization: Bearer PRICING_TOKEN_SECRET.
//      El Worker (meli-auth.js) es el único que renueva; acá sólo se lee.
// Se usa el expires_in de la respuesta; sin expires_in el token sirve para esta
// corrida y se vuelve a pedir ante un 401.
const MARGEN_MS = 5 * 60 * 1000;
const err = code => Object.assign(new Error(code), { code, fatal: true });

export function fuenteToken({ env = process.env, fetcher = (...a) => globalThis.fetch(...a), now = Date.now } = {}) {
  const manual = env.ML_ACCESS_TOKEN?.trim();
  const url = env.PRICING_TOKEN_URL?.trim() || 'https://amadolibros-sync.undiaes.workers.dev/pricing/token';
  const secreto = env.PRICING_TOKEN_SECRET?.trim();
  let cache = null, rechazados = 0;
  async function delWorker() {
    if (!secreto) throw err('sin_token: falta ML_ACCESS_TOKEN o PRICING_TOKEN_SECRET');
    const res = await fetcher(url, { headers: { Authorization: 'Bearer ' + secreto, Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(20000) }).catch(() => null);
    if (!res) throw err('worker_transporte');
    const b = await res.json().catch(() => null);
    if (!res.ok || typeof b?.access_token !== 'string') throw err(`worker_http_${res.status}${b?.error ? '_' + b.error : ''}`);
    const ei = Number(b.expires_in);
    return { token: b.access_token, vence: Number.isFinite(ei) && ei > 0 ? now() + ei * 1000 : null, userId: b.user_id ?? null };
  }
  return {
    origen: manual ? 'manual' : 'worker',
    async getToken() {
      if (manual) return manual;
      if (cache && (cache.vence === null || cache.vence - now() > MARGEN_MS)) return cache.token;
      cache = await delWorker();
      return cache.token;
    },
    // Un 401 de ML: descartar. Con token manual o tras dos rechazos seguidos, se corta la corrida.
    invalidate() {
      rechazados++;
      if (manual || rechazados > 1) throw err('token_rechazado_por_ml');
      cache = null;
    },
  };
}
