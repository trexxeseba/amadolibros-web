/**
 * Deja en KV la última corrida de cada workflow vigilado, para la sección
 * Salud del panel.
 *
 * Con el repo privado, GitHub no le contesta al panel sin una credencial. En
 * vez de pedirle a alguien que cree y cargue un token, un workflow (que ya
 * tiene el token del job, con `actions: read`) consulta GitHub y escribe el
 * resultado en la misma clave de KV que el panel ya lee como caché
 * (`panel:salud:workflows`, ver functions/_shared/panel-health.js).
 *
 * Uso: node scripts/ops/panel-salud-cache.mjs <archivo-de-salida.json>
 * Variables: GITHUB_TOKEN, GITHUB_REPOSITORY (opcional).
 * Sale con código 1 si alguna consulta falló: una lectura incompleta no se
 * guarda, igual que hace el panel.
 */

import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { WORKFLOWS_VIGILADOS } from '../../functions/_shared/health-rules.js';

const DEFAULT_REPO = 'trexxeseba/amadolibros-web';

const asText = value => String(value ?? '').trim();

export async function leerUltimaCorrida(repo, wf, token, fetchFn = fetch) {
  const url = new URL(`https://api.github.com/repos/${repo}/actions/workflows/${wf.archivo}/runs`);
  url.searchParams.set('per_page', '1');
  if (wf.rama) url.searchParams.set('branch', wf.rama);
  const headers = { 'User-Agent': 'amadolibros-panel-salud-cache', Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const response = await fetchFn(url, { headers, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    const run = (await response.json())?.workflow_runs?.[0];
    // Los mismos tres campos que guarda el panel: nada más va a KV.
    return {
      ok: true,
      corrida: run
        ? { conclusion: asText(run.conclusion) || null, created_at: asText(run.created_at) || null, html_url: asText(run.html_url) || null }
        : null,
    };
  } catch (error) {
    return { ok: false, error: asText(error?.message) || 'error de red' };
  }
}

export async function construirCache({ repo = DEFAULT_REPO, token = '', now = new Date(), fetchFn = fetch } = {}) {
  const corridas = {};
  await Promise.all(WORKFLOWS_VIGILADOS.map(async wf => {
    corridas[wf.archivo] = await leerUltimaCorrida(repo, wf, token, fetchFn);
  }));
  const completa = WORKFLOWS_VIGILADOS.every(wf => corridas[wf.archivo]?.ok === true);
  return { completa, valor: { corridas, consultadoEn: now.toISOString() } };
}

export async function main() {
  const salida = process.argv[2];
  if (!salida) throw new Error('Falta el archivo de salida.');
  const { completa, valor } = await construirCache({
    repo: asText(process.env.GITHUB_REPOSITORY) || DEFAULT_REPO,
    token: asText(process.env.GITHUB_TOKEN),
  });
  if (!completa) {
    const fallidos = Object.entries(valor.corridas).filter(([, l]) => !l.ok).map(([archivo, l]) => `${archivo} (${l.error})`);
    console.error(`No se pudo leer: ${fallidos.join(', ')}. No se guarda una lectura incompleta.`);
    process.exitCode = 1;
    return;
  }
  await writeFile(salida, JSON.stringify(valor));
  console.log(`Estado de ${WORKFLOWS_VIGILADOS.length} workflows listo para el panel.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error?.message || error); process.exitCode = 1; });
}
