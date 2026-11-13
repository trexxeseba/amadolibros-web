/**
 * worker-sync/poda-trigger.js
 *
 * Disparo puntual de la poda de anuncios (poda-anuncios.yml) desde Cloudflare. El cron de
 * GitHub se atrasa horas; el Worker pide un workflow_dispatch a las 11:30 de Montevideo
 * (accion=correr) y a las 21:30 (accion=auditar). Mismo GITHUB_TOKEN que el disparo de
 * Precio Ganador. No llama a Mercado Libre ni toca Mercado Ads.
 *
 *  - Si ya hay una corrida en curso o en cola, no dispara.
 *  - Reintenta una vez y, si no pudo, deja la falla en el log del Worker: el latido de
 *    GitHub (poda-anuncios-vigia.yml) avisa por mail si no hubo corrida hoy.
 */
export const CRON_PODA_CORRER = '30 14 * * *';
export const CRON_PODA_AUDITAR = '30 0 * * *';
export const CRONS_PODA = [CRON_PODA_CORRER, CRON_PODA_AUDITAR];
export const accionDelHorario = cron => cron === CRON_PODA_AUDITAR ? 'auditar' : 'correr';
const REPO_DEFAULT = 'trexxeseba/amadolibros-web';
const WORKFLOW = 'poda-anuncios.yml';

export async function dispararPoda(env, { cron = CRON_PODA_CORRER, fetcher = (...a) => fetch(...a), sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const repo = String(env?.GITHUB_REPO || REPO_DEFAULT);
  const token = typeof env?.GITHUB_TOKEN === 'string' ? env.GITHUB_TOKEN.trim() : '';
  if (!token) return { state: 'sin_token' };
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'amadolibros-sync', 'X-GitHub-Api-Version': '2022-11-28' };
  const api = `https://api.github.com/repos/${repo}`;
  try {
    for (const status of ['in_progress', 'queued']) {
      const res = await fetcher(`${api}/actions/workflows/${WORKFLOW}/runs?status=${status}&per_page=1`, { headers, signal: AbortSignal.timeout(20000) });
      if (res.ok && Number((await res.json())?.total_count) > 0) return { state: 'ya_hay_una', status };
    }
  } catch { /* si no se pudo consultar, se dispara igual: el grupo de concurrencia evita solapes */ }
  let ultimo = null;
  for (let intento = 1; intento <= 2; intento++) {
    try {
      const res = await fetcher(`${api}/actions/workflows/${WORKFLOW}/dispatches`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000),
        body: JSON.stringify({ ref: 'main', inputs: { accion: accionDelHorario(cron) } }),
      });
      if (res.status === 204) return { state: 'disparado', accion: accionDelHorario(cron), intento };
      ultimo = `github_http_${res.status}`;
    } catch { ultimo = 'github_transporte'; }
    if (intento === 1) await sleep(30_000);
  }
  return { state: 'fallo_disparo', detalle: ultimo };
}
