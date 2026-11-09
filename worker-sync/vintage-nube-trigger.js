/**
 * worker-sync/vintage-nube-trigger.js
 *
 * Disparo puntual del publicador de Amado Vintage en la nube (vintage-nube.yml) desde
 * Cloudflare. El cron de GitHub Actions es de mejor esfuerzo: el 05/11/2026 no lanzó
 * ninguna de las corridas programadas. A los 37 de cada hora el Worker pide un
 * workflow_dispatch con accion=auto (hace lo mismo que la programada: publica si
 * campaign.json lo permite y si no, sólo cuida el token de Vintage).
 *
 *  - Si hay una corrida en curso o en cola, no dispara: no se apilan.
 *  - Usa el mismo GITHUB_TOKEN que el disparo de Precio Ganador (sólo este repo,
 *    Actions lectura/escritura). No crea publicaciones ni llama a Mercado Libre.
 */
export const CRON_VINTAGE_NUBE = '37 * * * *';
// Vigía de infracciones de propiedad intelectual (vintage-vigia.yml): cada 10 minutos, sólo lectura
// de Mercado Libre; si hay una denuncia nueva pausa y frena. No toca el publicador.
export const CRON_VINTAGE_VIGIA = '*/10 * * * *';
const WORKFLOW_VIGIA = 'vintage-vigia.yml';
const REPO_DEFAULT = 'trexxeseba/amadolibros-web';
const WORKFLOW = 'vintage-nube.yml';

export async function dispararVintageNube(env, { fetcher = (...a) => fetch(...a), workflow = WORKFLOW, inputs = { accion: 'auto' } } = {}) {
  const repo = String(env?.GITHUB_REPO || REPO_DEFAULT);
  const token = typeof env?.GITHUB_TOKEN === 'string' ? env.GITHUB_TOKEN.trim() : '';
  if (!token) return { state: 'sin_token' };
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'amadolibros-sync', 'X-GitHub-Api-Version': '2022-11-28' };
  const api = `https://api.github.com/repos/${repo}`;
  try {
    for (const status of ['in_progress', 'queued']) {
      const res = await fetcher(`${api}/actions/workflows/${workflow}/runs?status=${status}&per_page=1`, { headers, signal: AbortSignal.timeout(20000) });
      if (res.ok && Number((await res.json())?.total_count) > 0) return { state: 'ya_hay_una', status };
    }
  } catch { /* si no se pudo consultar, se dispara igual: el grupo de concurrencia evita solapes */ }
  try {
    const res = await fetcher(`${api}/actions/workflows/${workflow}/dispatches`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000),
      body: JSON.stringify({ ref: 'main', inputs }),
    });
    return res.status === 204 ? { state: 'disparado' } : { state: 'fallo_disparo', detalle: `github_http_${res.status}` };
  } catch { return { state: 'fallo_disparo', detalle: 'github_transporte' }; }
}

export const dispararVintageVigia = env => dispararVintageNube(env, { workflow: WORKFLOW_VIGIA, inputs: {} });
