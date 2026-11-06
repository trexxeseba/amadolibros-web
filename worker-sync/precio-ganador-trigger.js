/**
 * worker-sync/precio-ganador-trigger.js
 *
 * Disparo puntual de Precio Ganador desde Cloudflare. El cron de GitHub Actions es
 * de mejor esfuerzo y se atrasa horas (el 05/11/2026 la corrida de las 00:00 UTC
 * arrancó a las 04:29). Cada 2 horas de 09:00 a 21:00 de Montevideo (12:00 a 00:00
 * UTC) el Worker pide un workflow_dispatch de precio-ganador.yml para las dos
 * cuentas (Seba, 06/11/2026: "cada 2 horas ambos").
 *
 *  - No dispara sólo si ya hay una corrida de ESTA franja: creada en los últimos
 *    10 minutos (el cron de GitHub, si llegó puntual). Una corrida atrasada de la
 *    franja anterior no cuenta: el 05/11 la de las 18:00 UTC arrancó a las 23:13 y
 *    el Worker se salteó la de las 00:00 UTC creyendo que ya había corrido, y ese
 *    día no salió el mail de resumen. Del lado de GitHub, el job `franja` del
 *    workflow se encarga de que una programada tardía no duplique.
 *  - A las 00:00 UTC (21:00 de Montevideo) pide además el mail de resumen del día
 *    (input correo=true): el workflow sólo lo mandaba con su propio cron de GitHub.
 *  - Reintenta una vez si el disparo falla. Si no pudo, manda un mail de alerta
 *    por Resend (mismo proveedor que el resto del Worker).
 *  - GITHUB_TOKEN: token fino de GitHub, sólo este repo, permiso Actions
 *    lectura/escritura. Se carga con `wrangler secret put GITHUB_TOKEN`; nunca
 *    va en el código ni en wrangler.toml.
 */
export const CRONS_PRECIO_GANADOR = ['0 12 * * *', '0 14 * * *', '0 16 * * *', '0 18 * * *', '0 20 * * *', '0 22 * * *', '0 0 * * *'];
// Qué cuentas corren en cada horario: las dos en todos (Seba, 06/11/2026).
export const CRONS_VINTAGE = CRONS_PRECIO_GANADOR;
// Horario con el mail de resumen del día (21:00 de Montevideo).
export const CRON_RESUMEN = '0 0 * * *';
export const cuentaDelHorario = cron => CRONS_VINTAGE.includes(cron) ? 'ambas' : 'libros';
const REPO_DEFAULT = 'trexxeseba/amadolibros-web';
const WORKFLOW = 'precio-ganador.yml';
const VENTANA_MS = 10 * 60 * 1000;

export async function dispararPrecioGanador(env, { cron = '0 0 * * *', fetcher = (...a) => fetch(...a), now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const repo = String(env?.GITHUB_REPO || REPO_DEFAULT);
  const token = typeof env?.GITHUB_TOKEN === 'string' ? env.GITHUB_TOKEN.trim() : '';
  if (!token) return alertar(env, fetcher, { state: 'sin_token', detalle: 'Falta el secreto GITHUB_TOKEN del Worker (wrangler secret put GITHUB_TOKEN).' });
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'amadolibros-sync', 'X-GitHub-Api-Version': '2022-11-28' };
  const api = `https://api.github.com/repos/${repo}`;

  // ¿Ya hay una corrida de esta franja?
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
        body: JSON.stringify({ ref: 'main', inputs: { accion: 'correr', cuenta: cuentaDelHorario(cron), ...(cron === CRON_RESUMEN ? { correo: 'true' } : {}) } }),
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
