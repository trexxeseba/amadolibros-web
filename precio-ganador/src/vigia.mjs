// Vigía: comprueba que Precio Ganador haya corrido bien hace poco. Lo corre un
// workflow aparte cada 3 horas. Si la última corrida exitosa en main tiene más de
// MAX_HORAS, manda una alarma y falla. Sólo lee la API de GitHub.
import { enviarAlarma } from './alarma.mjs';

const MAX_HORAS = Number(process.env.VIGIA_MAX_HORAS || 7);
const repo = process.env.GITHUB_REPOSITORY, token = process.env.GITHUB_TOKEN;
const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/precio-ganador.yml/runs?branch=main&status=success&per_page=20`, {
  headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(20000),
});
if (!res.ok) { await enviarAlarma({ asunto: 'el vigía no pudo consultar GitHub', texto: `HTTP ${res.status}` }); process.exit(1); }
const runs = (await res.json()).workflow_runs ?? [];
// Cuentan las corridas normales (programadas o a mano), no las de sólo auditoría o restaurar.
const ultima = runs.find(r => r.event === 'schedule' || r.event === 'workflow_dispatch');
const horas = ultima ? (Date.now() - Date.parse(ultima.updated_at)) / 3600e3 : Infinity;
console.log(JSON.stringify({ ultima: ultima?.html_url ?? null, horas: Number.isFinite(horas) ? Math.round(horas * 10) / 10 : null, max: MAX_HORAS }));
if (horas > MAX_HORAS) {
  const r = await enviarAlarma({ asunto: `no corre desde hace ${Number.isFinite(horas) ? Math.round(horas) + ' horas' : 'nunca'}`,
    texto: `La última corrida exitosa de Precio Ganador fue ${ultima ? `el ${ultima.updated_at} (${ultima.html_url})` : 'nunca'}.\nDebería correr a las 09:00, 15:00 y 21:00. Revisá Actions > Precio Ganador.` });
  console.log('Alarma:', JSON.stringify(r));
  process.exit(1);
}
