// Lecturas de la API de GitHub que comparten los partes automáticos (scripts/partes/).
// Sólo GET. El token nunca se imprime: va en la cabecera y nada más.
const API = 'https://api.github.com';

export function cliente({ token = process.env.GITHUB_TOKEN, fetcher = (...a) => globalThis.fetch(...a) } = {}) {
  const cab = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  async function get(ruta, { crudo = false, cabeceras = cab } = {}) {
    const res = await fetcher(`${API}${ruta}`, { headers: crudo ? { ...cabeceras, Accept: 'application/vnd.github.raw+json' } : cabeceras, signal: AbortSignal.timeout(30000) });
    if (!res.ok) { const e = new Error(`github_http_${res.status}`); e.status = res.status; throw e; }
    return crudo ? res.text() : res.json();
  }
  return {
    // Corridas terminadas de un workflow en main, de la más nueva a la más vieja.
    corridas: async (repo, workflow, n = 6) => (await get(`/repos/${repo}/actions/workflows/${workflow}/runs?branch=main&status=completed&per_page=${n}`)).workflow_runs ?? [],
    // Registro del primer job de una corrida, como texto.
    registro: async (repo, runId) => {
      const jobs = (await get(`/repos/${repo}/actions/runs/${runId}/jobs?per_page=5`)).jobs ?? [];
      if (!jobs.length) return '';
      const res = await fetcher(`${API}/repos/${repo}/actions/jobs/${jobs[0].id}/logs`, { headers: cab, signal: AbortSignal.timeout(60000) });
      return res.ok ? res.text() : '';
    },
    // Archivo JSON de otro repo (con su propio token, por ejemplo el del estado privado).
    json: async (repo, ruta, rama, tokenRepo) => JSON.parse(await get(`/repos/${repo}/contents/${ruta}?ref=${encodeURIComponent(rama)}`, { crudo: true, cabeceras: { ...cab, Authorization: `Bearer ${tokenRepo}` } })),
  };
}

// Las líneas del registro vienen con la hora adelante: "2026-11-18T13:33:44.6153353Z {...}".
export const lineas = texto => String(texto ?? '').split('\n').map(l => l.replace(/^﻿?\d{4}-\d\d-\d\dT[\d:.]+Z /, '').trimEnd());

// Último objeto JSON del registro cuya línea empieza con el prefijo dado.
export function ultimoJson(texto, prefijo) {
  for (const l of lineas(texto).reverse()) {
    if (!l.startsWith(prefijo)) continue;
    try { return JSON.parse(l); } catch { /* línea cortada: se sigue buscando */ }
  }
  return null;
}

// Objeto JSON de la línea que sigue a una marca (por ejemplo "=== REPORTE ===").
export function jsonDespuesDe(texto, marca) {
  const ls = lineas(texto), i = ls.lastIndexOf(marca);
  if (i < 0 || !ls[i + 1]) return null;
  try { return JSON.parse(ls[i + 1]); } catch { return null; }
}

export const horasDesde = (iso, ahora = Date.now()) => (ahora - Date.parse(iso)) / 3600e3;
export const horaUy = iso => new Date(iso).toLocaleString('es-UY', { timeZone: 'America/Montevideo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
