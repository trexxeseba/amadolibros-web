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

import { evaluateSyncStatus } from './sync-freshness-check.mjs';

const DEFAULT_STATUS_URL = 'https://www.amadolibros.com/api/status';
const DEFAULT_REPO = 'trexxeseba/amadolibros-web';

/**
 * `maxDias: null` significa "no mirar la antigüedad": deploy.yml corre cuando
 * hay un push y pasar una semana sin publicar no es una falla.
 * `rama` filtra a main donde el workflow también corre en PRs, para no leer
 * como "última corrida" la de una rama cualquiera.
 */
export const WORKFLOWS_VIGILADOS = [
  { archivo: 'deploy.yml', nombre: 'Deploy a producción', maxDias: null, rama: 'main' },
  { archivo: 'sync-freshness.yml', nombre: 'Frescura del sync', maxDias: 2, rama: 'main' },
  { archivo: 'checkout-funnel-report.yml', nombre: 'Embudo de checkout', maxDias: 2, rama: 'main' },
  { archivo: 'gsc-inspection-rotation.yml', nombre: 'Indexación en Google', maxDias: 2, rama: 'main' },
  { archivo: 'full-commerce-audit.yml', nombre: 'Auditoría comercial', maxDias: 9, rama: 'main' },
  { archivo: 'gsc-export.yml', nombre: 'Tráfico de búsqueda', maxDias: 9, rama: 'main' },
  { archivo: 'bing-webmaster-report.yml', nombre: 'Bing Webmaster', maxDias: 9, rama: 'main' },
];

function asText(value) {
  return String(value ?? '').trim();
}

function dias(desdeIso, now) {
  const ms = Date.parse(asText(desdeIso));
  if (!Number.isFinite(ms)) return null;
  return Math.round(((now.getTime() - ms) / 86_400_000) * 10) / 10;
}

/**
 * Convierte la última corrida de cada workflow en un veredicto legible.
 * `corridas` es un mapa archivo → {conclusion, created_at} | null.
 */
export function evaluarWorkflows(corridas, { now = new Date(), vigilados = WORKFLOWS_VIGILADOS } = {}) {
  const filas = [];
  const problemas = [];
  const sinConsultar = [];

  for (const wf of vigilados) {
    const lectura = corridas?.[wf.archivo] ?? null;

    // «No pude preguntar» y «nunca corrió» son cosas distintas y hay que
    // decirlas distinto. Confundirlas convierte un corte de red momentáneo en
    // siete avisos de que tus reportes están muertos — y un aviso que grita en
    // falso una vez es un aviso que no se lee nunca más.
    if (lectura && lectura.ok === false) {
      filas.push({ nombre: wf.nombre, estado: 'no se pudo consultar', dias: null, ok: false });
      sinConsultar.push(wf.nombre);
      continue;
    }

    const corrida = lectura?.corrida ?? null;

    if (!corrida) {
      filas.push({ nombre: wf.nombre, estado: 'sin corridas', dias: null, ok: false });
      problemas.push(`«${wf.nombre}» no tiene ninguna corrida registrada.`);
      continue;
    }

    const conclusion = asText(corrida.conclusion) || 'sin conclusión';
    const antiguedad = dias(corrida.created_at, now);
    // `skipped` y `cancelled` no son fallas: no se avisa por ellas, pero
    // tampoco cuentan como verde, así que se muestran tal cual.
    const fallo = conclusion === 'failure' || conclusion === 'timed_out';
    const viejo = wf.maxDias != null && antiguedad != null && antiguedad > wf.maxDias;

    if (fallo) problemas.push(`«${wf.nombre}» falló en su última corrida (hace ${antiguedad} días).`);
    if (viejo) problemas.push(`«${wf.nombre}» no corre hace ${antiguedad} días (máximo esperado: ${wf.maxDias}).`);

    filas.push({ nombre: wf.nombre, estado: conclusion, dias: antiguedad, ok: !fallo && !viejo });
  }

  // Si no se pudo consultar ninguno, el problema es uno solo —la API no
  // respondió— y no uno por reporte. Un correo con siete avisos que en
  // realidad son el mismo hecho es ruido.
  if (sinConsultar.length && sinConsultar.length === vigilados.length) {
    problemas.push('No se pudo consultar la API de GitHub: esta vez no hay datos de ningún reporte automático.');
  } else {
    for (const nombre of sinConsultar) {
      problemas.push(`No se pudo consultar el estado de «${nombre}».`);
    }
  }

  return { filas, problemas, sinConsultar };
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
