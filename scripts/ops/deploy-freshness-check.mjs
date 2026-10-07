/**
 * ¿Lo que se ve en www.amadolibros.com es lo último que se mergeó en main?
 *
 * El 2026-10-05 el deploy de #386 se canceló seis veces seguidas en la cola
 * de Actions y tardó casi dos horas en llegar a producción. Nadie se enteró:
 * una corrida `cancelled` no es roja, y el informe diario no la cuenta como
 * falla. Este chequeo mira el resultado y no el workflow: compara el commit
 * que sirve producción (/build.json, lo escribe deploy.yml) con main.
 *
 * Si producción quedó atrás:
 * - con un deploy en cola o corriendo, espera (no es una falla todavía);
 * - si para estos commits todavía no se reintentó, relanza deploy.yml UNA vez;
 * - si ya se reintentó y sigue atrás, termina en rojo para que se vea.
 *
 * Lo único que escribe es ese relanzamiento, y sólo sobre main.
 */

import { evaluarDeployAlDia } from '../../functions/_shared/health-rules.js';

export { evaluarDeployAlDia };

const DEFAULT_BUILD_URL = 'https://www.amadolibros.com/build.json';
const DEFAULT_REPO = 'trexxeseba/amadolibros-web';
const DEPLOY_WORKFLOW = 'deploy.yml';
const EN_CURSO = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested']);

function asText(value) {
  return String(value ?? '').trim();
}

/**
 * Qué hacer con un veredicto, dadas las últimas corridas de deploy.yml en
 * main. Puro, para poder probarlo sin red.
 *
 * Devuelve `esperar`, `relanzar`, `fallar` o `nada`.
 */
export function decidirAccion(veredicto, corridasDeploy, { desdeIso } = {}) {
  if (veredicto.estado !== 'atrasado') return { accion: 'nada' };

  const corridas = Array.isArray(corridasDeploy) ? corridasDeploy : [];
  const enCurso = corridas.find(corrida => EN_CURSO.has(asText(corrida.status)));
  if (enCurso) return { accion: 'esperar', corrida: enCurso };

  // Un relanzamiento ya hecho para estos commits: cualquier workflow_dispatch
  // posterior al commit pendiente más viejo. Si existe y producción sigue
  // atrás, relanzar de nuevo sólo repetiría el problema.
  const desdeMs = Date.parse(asText(desdeIso));
  const reintento = corridas.find(corrida => corrida.event === 'workflow_dispatch'
    && Number.isFinite(desdeMs)
    && Date.parse(asText(corrida.created_at)) >= desdeMs);
  if (reintento) return { accion: 'fallar', corrida: reintento };

  return { accion: 'relanzar' };
}

export function construirResumen(veredicto, decision) {
  const corto = sha => (sha ? sha.slice(0, 7) : '—');
  const lineas = [
    '## ¿Producción tiene lo último de main?',
    '',
    `- Producción publica: ${corto(veredicto.shaProduccion)}`,
    `- main está en: ${corto(veredicto.shaMain)}`,
    `- Estado: ${veredicto.estado}`,
  ];
  if (veredicto.minutos != null) lineas.push(`- Commit pendiente más viejo: hace ${veredicto.minutos} min`);
  lineas.push('');

  const textos = {
    nada: veredicto.estado === 'sin_dato'
      ? 'Sin datos suficientes para comparar (¿/build.json todavía no publicado?). No se hace nada.'
      : 'Nada que hacer.',
    esperar: `Hay un deploy en curso (${decision.corrida?.html_url || 'sin enlace'}). Se espera.`,
    relanzar: '**Producción quedó atrás y no hay deploy en curso: se relanza deploy.yml sobre main.**',
    fallar: `**Producción sigue atrás aun después de relanzar el deploy** (${decision.corrida?.html_url || 'sin enlace'}). Hay que mirarlo a mano.`,
  };
  if (veredicto.problema) lineas.push(veredicto.problema, '');
  lineas.push(textos[decision.accion]);
  return `${lineas.join('\n')}\n`;
}

async function github(repo, ruta, token, { method = 'GET', body } = {}) {
  const headers = { 'User-Agent': 'amadolibros-deploy-freshness', Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const response = await fetch(`https://api.github.com/repos/${repo}${ruta}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub ${method} ${ruta}: HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
}

async function leerBuildProduccion(url) {
  try {
    const sinCache = new URL(url);
    sinCache.searchParams.set('t', String(Date.now()));
    const response = await fetch(sinCache, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) return { sha: '', error: `HTTP ${response.status}` };
    const body = JSON.parse(await response.text());
    return { sha: asText(body?.sha), error: null };
  } catch (error) {
    return { sha: '', error: asText(error?.message) || 'error de red' };
  }
}

async function escribirResumen(texto) {
  process.stdout.write(texto);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, texto);
  }
}

export async function main() {
  const buildUrl = asText(process.env.BUILD_JSON_URL) || DEFAULT_BUILD_URL;
  const repo = asText(process.env.GITHUB_REPOSITORY) || DEFAULT_REPO;
  const token = asText(process.env.GITHUB_TOKEN);
  const puedeRelanzar = asText(process.env.DEPLOY_RETRY_ENABLED) === 'true';

  const produccion = await leerBuildProduccion(buildUrl);
  if (produccion.error) console.log(`No se pudo leer ${buildUrl}: ${produccion.error}`);

  const ultimoMain = await github(repo, '/commits/main', token);
  const shaMain = asText(ultimoMain?.sha);

  let pendientes = null;
  if (produccion.sha && produccion.sha !== shaMain) {
    try {
      const comparacion = await github(repo, `/compare/${produccion.sha}...${shaMain}`, token);
      pendientes = comparacion?.commits ?? null;
    } catch (error) {
      console.log(`No se pudo comparar ${produccion.sha}...${shaMain}: ${error.message}`);
    }
  }

  const veredicto = evaluarDeployAlDia({ shaProduccion: produccion.sha, shaMain, pendientes });

  let decision = { accion: 'nada' };
  if (veredicto.estado === 'atrasado') {
    const runs = await github(repo, `/actions/workflows/${DEPLOY_WORKFLOW}/runs?branch=main&per_page=10`, token);
    const fechas = (pendientes || [])
      .map(commit => asText(commit?.commit?.committer?.date))
      .filter(fecha => Number.isFinite(Date.parse(fecha)))
      .sort();
    decision = decidirAccion(veredicto, runs?.workflow_runs, { desdeIso: fechas[0] });
  }

  await escribirResumen(construirResumen(veredicto, decision));

  if (decision.accion === 'relanzar') {
    if (!puedeRelanzar) {
      console.log('DEPLOY_RETRY_ENABLED no es true: no se relanza (modo sólo lectura).');
      process.exitCode = 1;
      return;
    }
    await github(repo, `/actions/workflows/${DEPLOY_WORKFLOW}/dispatches`, token, {
      method: 'POST',
      body: { ref: 'main' },
    });
    console.log('Deploy relanzado sobre main.');
  }
  if (decision.accion === 'fallar') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(error => {
    console.error(error?.stack || error?.message || error);
    process.exitCode = 1;
  });
}
