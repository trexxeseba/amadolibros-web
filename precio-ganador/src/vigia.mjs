// Vigía: comprueba que Precio Ganador haya corrido bien hace poco. Lo corre un
// workflow aparte cada 3 horas. Si la última corrida exitosa en main tiene más de
// MAX_HORAS, manda una alarma y falla. Sólo lee la API de GitHub.
import { enviarAlarma } from './alarma.mjs';

const MAX_HORAS = Number(process.env.VIGIA_MAX_HORAS || 7);
const repo = process.env.GITHUB_REPOSITORY, token = process.env.GITHUB_TOKEN;
const cab = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/precio-ganador.yml/runs?branch=main&per_page=30`, { headers: cab, signal: AbortSignal.timeout(20000) });
if (!res.ok) { await enviarAlarma({ asunto: 'el vigía no pudo consultar GitHub', texto: `HTTP ${res.status}` }); process.exit(1); }
const runs = ((await res.json()).workflow_runs ?? []).filter(r => (r.event === 'schedule' || r.event === 'workflow_dispatch') && r.status === 'completed');
const horasDe = r => (Date.now() - Date.parse(r.updated_at)) / 3600e3;
// "Corrió" = el paso Correr terminó bien en todos los jobs de esa corrida, aunque
// después la auditoría o el guardado hayan fallado. Se mira job por job.
async function corrio(run) {
  const r = await fetch(`https://api.github.com/repos/${repo}/actions/runs/${run.id}/jobs?per_page=10`, { headers: cab, signal: AbortSignal.timeout(20000) });
  if (!r.ok) return null;
  const jobs = (await r.json()).jobs ?? [];
  const pasos = jobs.flatMap(j => (j.steps ?? []).filter(p => p.name === 'Correr'));
  if (!pasos.length) return null;
  return { corrio: pasos.every(p => p.conclusion === 'success'), avisos: jobs.some(j => j.conclusion !== 'success') };
}
let ultimaOk = null, ultimaConAvisos = null, ultimaFallida = null;
for (const run of runs) {
  if (horasDe(run) > MAX_HORAS * 3) break;
  if (run.conclusion === 'success') { ultimaOk ??= run; continue; }
  const c = await corrio(run);
  if (c?.corrio) ultimaConAvisos ??= run; else ultimaFallida ??= run;
}
const ultima = [ultimaOk, ultimaConAvisos].filter(Boolean).sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))[0] ?? null;
const horas = ultima ? horasDe(ultima) : Infinity;
console.log(JSON.stringify({ ultima: ultima?.html_url ?? null, con_avisos: ultima === ultimaConAvisos, horas: Number.isFinite(horas) ? Math.round(horas * 10) / 10 : null, max: MAX_HORAS, ultima_fallida: ultimaFallida?.html_url ?? null }));
if (horas > MAX_HORAS) {
  const h = Number.isFinite(horas) ? `${Math.round(horas)} horas` : 'nunca';
  const caso = ultimaFallida && (!ultima || Date.parse(ultimaFallida.updated_at) > Date.parse(ultima.updated_at))
    ? `Caso: CORRIÓ PERO FALLÓ. La última corrida (${ultimaFallida.html_url}) no completó el paso Correr.`
    : 'Caso: NO CORRIÓ. No hay ninguna corrida reciente (el cron de GitHub se atrasó o no se lanzó).';
  const r = await enviarAlarma({ asunto: `no corre bien desde hace ${h}`,
    texto: `${caso}\nÚltima corrida que terminó el paso Correr: ${ultima ? `${ultima.updated_at} (${ultima.html_url})${ultima === ultimaConAvisos ? ', con avisos de auditoría' : ''}` : 'ninguna'}.\nDebería correr a las 09:00, 15:00 y 21:00. Revisá Actions > Precio Ganador.` });
  console.log('Alarma:', JSON.stringify(r));
  process.exit(1);
}
if (ultima === ultimaConAvisos) console.log('La última corrida terminó con avisos de auditoría; el paso Correr estuvo bien.');
