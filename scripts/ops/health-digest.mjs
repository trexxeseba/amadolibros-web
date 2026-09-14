/**
 * ¿Hay algo roto en la web ahora mismo?
 *
 * Junta en un solo bloque las dos cosas que hoy nadie mira: el estado del sync
 * en producción y si los reportes automáticos siguen corriendo y en verde.
 *
 * El caso que motiva esto: «AI measurement baseline» estuvo un mes en rojo sin
 * que nadie se enterara. Un workflow rojo sólo se ve entrando a Actions, y con
 * 167 workflows en el repo el ruido tapa la señal. Acá se miran nada más los
 * que importan, y se avisa por dos motivos distintos: que la última corrida
 * haya fallado, o que hace demasiado que no corre — una tarea programada que
 * dejó de dispararse no falla, simplemente desaparece, y es el modo de fallar
 * más fácil de no notar.
 *
 * Solo lectura: GET a /api/status y GET a la API de GitHub.
 */

import {
  WORKFLOWS_VIGILADOS,
  evaluarWorkflows,
  evaluateSyncStatus,
} from '../../functions/_shared/health-rules.js';

// Las reglas viven en functions/_shared/health-rules.js, compartidas con el
// panel. Se re-exportan para que las pruebas sigan importándolas de acá.
export { WORKFLOWS_VIGILADOS, evaluarWorkflows };

const DEFAULT_STATUS_URL = 'https://www.amadolibros.com/api/status';
const DEFAULT_REPO = 'trexxeseba/amadolibros-web';

function asText(value) {
  return String(value ?? '').trim();
}

export function construirDigest({ estadoSync, workflows, now = new Date() }) {
  const problemas = [...(estadoSync?.problemas || []), ...(workflows?.problemas || [])];
  const lineas = ['# Amado Libros — informe diario', '', `_Generado ${now.toISOString()}_`, ''];

  if (problemas.length) {
    lineas.push(`## ⚠️ Hay ${problemas.length} cosa(s) para mirar`, '');
    for (const problema of problemas) lineas.push(`- ${problema}`);
  } else {
    lineas.push('## ✅ Todo en orden', '', 'El sync publicó dentro de plazo y los reportes automáticos están en verde.');
  }

  lineas.push('', '## Catálogo', '');
  if (estadoSync) {
    lineas.push(`- Último sync exitoso: ${estadoSync.lastOk || '—'}`);
    lineas.push(`- Antigüedad: ${estadoSync.edadHoras == null ? '—' : `${estadoSync.edadHoras} h`}`);
    lineas.push(`- Ítems publicados: ${estadoSync.totalItems ?? '—'}`);
    for (const nota of estadoSync.notas || []) lineas.push(`- ${nota}`);
  } else {
    lineas.push('- No se pudo leer el estado del sync.');
  }

  lineas.push('', '## Reportes automáticos', '', '| Reporte | Última corrida | Hace |', '| --- | --- | ---: |');
  for (const fila of workflows?.filas || []) {
    const marca = fila.ok ? '' : ' ⚠️';
    lineas.push(`| ${fila.nombre}${marca} | ${fila.estado} | ${fila.dias == null ? '—' : `${fila.dias} d`} |`);
  }

  return { markdown: `${lineas.join('\n')}\n`, problemas, hayProblemas: problemas.length > 0 };
}

async function leerUltimaCorrida(repo, wf, token) {
  const url = new URL(`https://api.github.com/repos/${repo}/actions/workflows/${wf.archivo}/runs`);
  url.searchParams.set('per_page', '1');
  if (wf.rama) url.searchParams.set('branch', wf.rama);
  const headers = { 'User-Agent': 'amadolibros-health-digest', Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    const data = await response.json();
    return { ok: true, corrida: data?.workflow_runs?.[0] ?? null };
  } catch (error) {
    return { ok: false, error: asText(error?.message) || 'error de red' };
  }
}

export async function main() {
  const statusUrl = asText(process.env.SYNC_STATUS_URL) || DEFAULT_STATUS_URL;
  const repo = asText(process.env.GITHUB_REPOSITORY) || DEFAULT_REPO;
  const token = asText(process.env.GITHUB_TOKEN);
  const now = new Date();

  let estadoSync = null;
  try {
    const response = await fetch(statusUrl, { signal: AbortSignal.timeout(30_000) });
    // Se lee como texto y recién después se parsea: cuando algo se interpone
    // —un proxy, una página de error de Cloudflare— la respuesta es HTML, y
    // `response.json()` explota con un "Unexpected token" que no le dice nada
    // a quien lee el correo. Mejor decir que no vino JSON y con qué código.
    const crudo = await response.text();
    let body;
    try {
      body = JSON.parse(crudo);
    } catch {
      throw new Error(`respondió algo que no es JSON (HTTP ${response.status})`);
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    estadoSync = evaluateSyncStatus(body, { now });
  } catch (error) {
    estadoSync = {
      ok: false,
      edadHoras: null,
      lastOk: null,
      totalItems: null,
      problemas: [`No se pudo leer el estado del sitio en ${statusUrl}: ${asText(error?.message) || 'error desconocido'}`],
      notas: [],
    };
  }

  const corridas = {};
  await Promise.all(WORKFLOWS_VIGILADOS.map(async wf => {
    corridas[wf.archivo] = await leerUltimaCorrida(repo, wf, token);
  }));

  const workflows = evaluarWorkflows(corridas, { now });
  const digest = construirDigest({ estadoSync, workflows, now });

  const salida = asText(process.env.HEALTH_DIGEST_OUTPUT);
  if (salida) {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const path = await import('node:path');
    await mkdir(path.dirname(salida), { recursive: true });
    await writeFile(salida, digest.markdown);
  }

  process.stdout.write(digest.markdown);

  // No falla la corrida: este script informa, y el que avisa es el correo.
  // Si reprobara, el paso de envío no llegaría a ejecutarse justo el día en
  // que hay algo que contar.
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(error => {
    console.error(error?.stack || error?.message || error);
    process.exitCode = 1;
  });
}
