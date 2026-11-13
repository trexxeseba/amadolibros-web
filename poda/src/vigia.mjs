// Latido de la poda: si pasadas las 13:00 de Montevideo no hubo una corrida exitosa de hoy,
// manda un mail y falla (GitHub manda además su propio mail de falla). Sólo lee GitHub.
import { fechaMontevideo, horaMontevideo } from '../../agentes-ml/src/config.mjs';
import { enviarMail } from './mesa.mjs';

export function hayCorridaDeHoy(runs, hoy) {
  return runs.some(r => r.conclusion === 'success' && ['schedule', 'workflow_dispatch'].includes(r.event) && fechaMontevideo(new Date(r.created_at)) === hoy);
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY, token = process.env.GITHUB_TOKEN;
  const hoy = fechaMontevideo();
  if (horaMontevideo() < 13) { console.log('Todavía no son las 13:00: no se comprueba.'); return; }
  const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/poda-anuncios.yml/runs?branch=main&per_page=30`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) { await enviarMail({ asunto: 'Poda de anuncios: el latido no pudo consultar GitHub', texto: `HTTP ${res.status}` }); process.exit(1); }
  const runs = (await res.json()).workflow_runs ?? [];
  if (hayCorridaDeHoy(runs, hoy)) { console.log('La poda corrió bien hoy.'); return; }
  const r = await enviarMail({ asunto: `ALARMA poda de anuncios: no hay corrida exitosa hoy (${hoy})`, texto: `Pasadas las 13:00 de Montevideo no hay una corrida exitosa de la poda de anuncios de hoy. Revisá Actions > Poda de anuncios y la fila poda|${hoy} de la mesa.` });
  console.log('Alarma:', JSON.stringify(r));
  process.exit(1);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) main();
