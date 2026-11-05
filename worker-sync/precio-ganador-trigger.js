/**
 * worker-sync/precio-ganador-trigger.js
 *
 * Disparo puntual de Precio Ganador desde Cloudflare. El cron de GitHub Actions es
 * de mejor esfuerzo y se atrasa horas (el 05/11/2026 la corrida de las 00:00 UTC
 * arrancó a las 04:29). A las 12:00, 18:00 y 00:00 UTC (09:00, 15:00 y 21:00 de
 * Montevideo) el Worker pide un workflow_dispatch de precio-ganador.yml.
 * Libros corre en los tres horarios; Vintage dos veces, a las 09:00 y a las 21:00 (Seba, 05/11/2026:
 * con tres corridas iba y venía, una bajaba unas 1.500 y la siguiente las volvía a subir).
 *
 *  - Si en las últimas 2 horas ya hubo una corrida exitosa o en curso, no dispara
 *    (así el cron de GitHub, que queda de respaldo, no duplica).
 *  - Reintenta una vez si el disparo falla. Si no pudo, manda un mail de alerta
 *    por Resend (mismo proveedor que el resto del Worker).
 *  - GITHUB_TOKEN: token fino de GitHub, sólo este repo, permiso Actions
 *    lectura/escritura. Se carga con `wrangler secret put GITHUB_TOKEN`; nunca
 *    va en el código ni en wrangler.toml.
 */
export const CRONS_PRECIO_GANADOR = ['0 12 * * *', '0 18 * * *', '0 0 * * *'];
// Qué cuentas corren en cada horario: Vintage dos veces por día, 09:00 y 21:00 de Montevideo.
export const CRONS_VINTAGE = ['0 12 * * *', '0 0 * * *'];
export const cuentaDelHorario = cron => CRONS_VINTAGE.includes(cron) ? 'ambas' : 'libros';
const REPO_DEFAULT = 'trexxeseba/amadolibros-web';
const WORKFLOW = 'precio-ganador.yml';
const VENTANA_MS = 2 * 3600 * 1000;

export async function dispararPrecioGanador(env, { cron = '0 0 * * *', fetcher = (...a) => fetch(...a), now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const repo = String(env?.GITHUB_REPO || REPO_DEFAULT);
  const token = typeof env?.GITHUB_TOKEN === 'string' ? env.GITHUB_TOKEN.trim() : '';
  if (!token) return alertar(env, fetcher, { state: 'sin_token', detalle: 'Falta el secreto GITHUB_TOKEN del Worker (wrangler secret put GITHUB_TOKEN).' });
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'amadolibros-sync', 'X-GitHub-Api-Version': '2022-11-28' };
  const api = `https://api.github.com/repos/${repo}`;

  // ¿Ya corrió en esta franja?
  try {
    const res = await fetcher(`${api}/actions/workflows/${WORKFLOW}/runs?branch=main&per_page=10`, { headers, signal: AbortSignal.timeout(20000) });
    if (res.ok) {
      const runs = (await res.json())?.workflow_runs ?? [];
      const reciente = runs.find(r => (r.event === 'schedule' || r.event === 'workflow_dispatch') && now() - Date.parse(r.created_at) < VENTANA_MS && (r.status !== 'completed' || r.conclusion === 'success'));
      if (reciente) return { state: 'ya_corrio', run: reciente.html_url ?? null };
    }
  } catch { /* si no se pudo consultar, se dispara igual: el grupo de concurrencia del workflow evita solapes */ }

  let ultimo = null;
  for (let intento = 1; intento <= 2; intento++) {
    try {
      const res = await fetcher(`${api}/actions/workflows/${WORKFLOW}/dispatches`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000),
        body: JSON.stringify({ ref: 'main', inputs: { accion: 'correr', cuenta: cuentaDelHorario(cron) } }),
      });
      if (res.status === 204) return { state: 'disparado', intento };
      ultimo = `github_http_${res.status}`;
    } catch { ultimo = 'github_transporte'; }
    if (intento === 1) await sleep(30_000);
  }
  return alertar(env, fetcher, { state: 'fallo_disparo', detalle: ultimo });
}

async function alertar(env, fetcher, resultado) {
  const apiKey = typeof env?.RESEND_API_KEY === 'string' ? env.RESEND_API_KEY.trim() : '';
  const to = String(env?.PRECIO_GANADOR_EMAIL_TO ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (!apiKey || !to.length) return { ...resultado, alerta: 'sin_credenciales' };
  try {
    const res = await fetcher('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000),
      body: JSON.stringify({ from: env?.REPORT_EMAIL_FROM || 'Amado Libros <web@notificaciones.amadolibros.com>', to, subject: `ALARMA Precio Ganador: el Worker no pudo lanzar la corrida (${resultado.state})`,
        text: `El Worker de Cloudflare no pudo pedirle a GitHub que corra Precio Ganador.\nMotivo: ${resultado.detalle ?? resultado.state}.\nSi el cron de GitHub tampoco corre, lanzala a mano en Actions > Precio Ganador.` }),
    });
    return { ...resultado, alerta: res.ok ? 'enviada' : `resend_http_${res.status}` };
  } catch { return { ...resultado, alerta: 'resend_transporte' }; }
}
