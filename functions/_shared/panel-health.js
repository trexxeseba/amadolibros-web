/**
 * Sección «Salud» del panel: ¿el catálogo se publicó hoy? ¿Los reportes
 * automáticos siguen corriendo y en verde?
 *
 * Hasta ahora las dos respuestas vivían donde nadie mira: el estado del sync
 * en KV (que no se lee desde afuera de Cloudflare) y las corridas en la
 * pestaña Actions de GitHub (donde un rojo puede vivir un mes). El panel es la
 * pantalla que sí se abre, así que las dos van acá, con la misma regla que el
 * correo diario: `_shared/health-rules.js`. Una sola verdad, dos lugares.
 *
 * Reglas de este archivo:
 * - El sync se lee de KV directo, sin pasar por /api/status: el panel tiene
 *   el binding y son las mismas tres claves. Cero red.
 * - Las corridas de GitHub sólo se consultan si PANEL_SALUD_REMOTO="true".
 *   En tests, preview y dev queda apagado: una pantalla de prueba no tiene
 *   por qué salir a Internet, y una suite que depende de red real es una
 *   suite que un día falla sin que nadie haya roto nada.
 * - Con la consulta encendida, el resultado se cachea 10 minutos en KV. Sin
 *   token, la API de GitHub admite 60 pedidos por hora por IP y las IPs de
 *   salida de Cloudflare son compartidas; abrir el panel diez veces no puede
 *   costar setenta pedidos.
 * - Nada de acá hace fallar el tablero. Lo que no se pudo consultar se dice
 *   como tal, y «no se pudo consultar» nunca se confunde con «nunca corrió».
 */

import {
  WORKFLOWS_VIGILADOS,
  deriveSyncWorkerState,
  evaluarWorkflows,
  evaluateSyncStatus,
} from './health-rules.js';

const REPO = 'trexxeseba/amadolibros-web';
const CACHE_KEY = 'panel:salud:workflows';
const CACHE_TTL_SECONDS = 600;
const GITHUB_TIMEOUT_MS = 4000;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function asText(value) {
  return String(value ?? '').trim();
}

/** dd/mm HH:MM en UTC, o «—». El panel entero habla en UTC y lo dice. */
export function fechaCorta(iso) {
  const ms = Date.parse(asText(iso));
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${dd}/${mm} ${hh}:${mi}`;
}

async function leerUltimaCorrida(wf, fetchFn) {
  const url = new URL(`https://api.github.com/repos/${REPO}/actions/workflows/${wf.archivo}/runs`);
  url.searchParams.set('per_page', '1');
  if (wf.rama) url.searchParams.set('branch', wf.rama);

  try {
    const response = await fetchFn(url.toString(), {
      headers: { 'User-Agent': 'amadolibros-panel-salud', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (!response?.ok) return { ok: false, error: `HTTP ${response?.status ?? 'sin respuesta'}` };
    const data = await response.json();
    const run = data?.workflow_runs?.[0];
    // Se guardan sólo los tres campos que se usan: lo que va a KV tiene que
    // ser chico y no puede arrastrar nada que no se muestre.
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

async function leerCache(kv) {
  if (!kv) return null;
  try {
    const raw = await kv.get(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.corridas) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function guardarCache(kv, valor) {
  if (!kv) return;
  try {
    await kv.put(CACHE_KEY, JSON.stringify(valor), { expirationTtl: CACHE_TTL_SECONDS });
  } catch {
    // Un caché que no se pudo escribir no es un problema del panel.
  }
}

export async function loadHealth(context, { now = new Date(), fetchFn = globalThis.fetch } = {}) {
  const env = context?.env || {};
  const kv = env.AMADO_KV;

  // ── Sync del catálogo, desde KV ─────────────────────────────────────────
  let sync;
  if (!kv) {
    sync = { disponible: false, motivo: 'Sin AMADO_KV en este entorno.', problemas: [], notas: [] };
  } else {
    const [lastStarted, lastOk, lastError] = await Promise.all([
      kv.get('sync:last_started'),
      kv.get('sync:last_ok'),
      kv.get('sync:last_error'),
    ]);
    const worker = deriveSyncWorkerState({ lastStarted, lastOk, lastError }, now);
    const veredicto = evaluateSyncStatus({ worker }, { now });
    sync = { disponible: true, worker, ...veredicto };
  }

  // ── Reportes automáticos, desde GitHub (con caché) ──────────────────────
  let reportes;
  const remoto = asText(env.PANEL_SALUD_REMOTO) === 'true';
  if (!remoto) {
    reportes = {
      disponible: false,
      motivo: 'La consulta a GitHub está apagada en este entorno (PANEL_SALUD_REMOTO).',
      filas: [],
      problemas: [],
      sinConsultar: [],
      desdeCache: false,
      consultadoEn: null,
    };
  } else {
    let corridas = null;
    let consultadoEn = null;
    let desdeCache = false;

    const cache = await leerCache(kv);
    if (cache) {
      corridas = cache.corridas;
      consultadoEn = cache.consultadoEn || null;
      desdeCache = true;
    } else {
      corridas = {};
      await Promise.all(WORKFLOWS_VIGILADOS.map(async wf => {
        corridas[wf.archivo] = await leerUltimaCorrida(wf, fetchFn);
      }));
      consultadoEn = now.toISOString();
      // Sólo se cachea una lectura completa. Cachear "no se pudo consultar"
      // dejaría el panel diez minutos diciendo que no sabe, por un corte de
      // dos segundos.
      const completa = WORKFLOWS_VIGILADOS.every(wf => corridas[wf.archivo]?.ok === true);
      if (completa) await guardarCache(kv, { corridas, consultadoEn });
    }

    reportes = { disponible: true, ...evaluarWorkflows(corridas, { now }), desdeCache, consultadoEn };
  }

  return {
    generadoEn: now.toISOString(),
    sync,
    reportes,
    problemas: [...(sync.problemas || []), ...(reportes.problemas || [])],
  };
}

function tonoCorrida(fila) {
  if (fila.estado === 'no se pudo consultar') return 'aviso';
  if (fila.estado === 'failure' || fila.estado === 'timed_out') return 'grave';
  if (fila.estado === 'sin corridas') return 'grave';
  if (fila.estado === 'success' && fila.ok) return 'bien';
  if (fila.estado === 'success' && !fila.ok) return 'aviso'; // verde pero viejo
  return 'neutro';
}

const ETIQUETA_CORRIDA = {
  success: 'ok',
  failure: 'falló',
  timed_out: 'se colgó',
  cancelled: 'cancelada',
  skipped: 'salteada',
  'sin corridas': 'nunca corrió',
  'no se pudo consultar': 'sin consultar',
};

function hace(dias) {
  if (dias == null) return '—';
  if (dias < 1) return `${Math.round(dias * 24)} h`;
  return `${dias} d`;
}

/**
 * La tarjeta. Regla de la casa: cada número lleva su fecha al lado. Un
 * tablero que no dice cuándo se midió es peor que no tenerlo, porque da
 * confianza falsa.
 */
export function healthSection(salud, { catalogo = null } = {}) {
  const problemas = Array.isArray(salud?.problemas) ? salud.problemas : [];
  const sync = salud?.sync || {};
  const reportes = salud?.reportes || {};

  const cabecera = problemas.length
    ? `<span class="cuenta">${escapeHtml(problemas.length)}</span>`
    : '<span class="cuenta cuenta-cero">todo bien</span>';

  let bloqueSync;
  if (!sync.disponible) {
    bloqueSync = `<p class="muted">Estado del sync no disponible: ${escapeHtml(sync.motivo || 'sin datos')}</p>`;
  } else {
    const tono = sync.ok ? 'bien' : 'grave';
    const etiqueta = sync.ok ? 'publicó a tiempo' : 'con problemas';
    bloqueSync = `
      <p><span class="pastilla p-${tono}">${escapeHtml(etiqueta)}</span>
        <b>Último sync exitoso:</b> ${escapeHtml(fechaCorta(sync.lastOk))} UTC
        ${sync.edadHoras != null ? `<span class="muted">· hace ${escapeHtml(sync.edadHoras)} h</span>` : ''}
        ${catalogo?.feed?.activeTotal != null ? `<span class="muted">· ${escapeHtml(catalogo.feed.activeTotal)} libros publicados</span>` : ''}
      </p>
      ${(sync.notas || []).map(nota => `<p class="muted">${escapeHtml(nota)}</p>`).join('')}`;
  }

  let bloqueReportes;
  if (!reportes.disponible) {
    bloqueReportes = `<p class="muted">${escapeHtml(reportes.motivo || 'Reportes no disponibles.')}</p>`;
  } else {
    const filas = (reportes.filas || []).map(fila => {
      const tono = tonoCorrida(fila);
      const etiqueta = ETIQUETA_CORRIDA[fila.estado] || fila.estado;
      const nombre = fila.url
        ? `<a href="${escapeHtml(fila.url)}" rel="noopener noreferrer">${escapeHtml(fila.nombre)}</a>`
        : escapeHtml(fila.nombre);
      return `<tr>
        <td>${nombre}</td>
        <td><span class="pastilla p-${tono}">${escapeHtml(etiqueta)}</span></td>
        <td>${escapeHtml(hace(fila.dias))}</td>
      </tr>`;
    }).join('');
    const origen = reportes.desdeCache
      ? `consultado ${escapeHtml(fechaCorta(reportes.consultadoEn))} UTC, desde caché`
      : `consultado ${escapeHtml(fechaCorta(reportes.consultadoEn))} UTC`;
    bloqueReportes = `
      <table>
        <thead><tr><th>Reporte</th><th>Última corrida</th><th>Hace</th></tr></thead>
        <tbody>${filas}</tbody>
      </table>
      <p class="muted mas">${origen}. Un reporte «ok» pero viejo va en amarillo: dejó de correr, que es la falla que menos se nota.</p>`;
  }

  return `
<section class="card" id="salud">
  <div class="card-cabeza">
    <h2>Salud</h2>
    ${cabecera}
    <span class="muted">${escapeHtml(fechaCorta(salud?.generadoEn))} UTC</span>
  </div>
  ${problemas.length
    ? `<ul class="tareas">${problemas.map(p => `<li class="tarea t-alta"><div class="tarea-texto"><b>${escapeHtml(p)}</b></div></li>`).join('')}</ul>`
    : ''}
  <h3>Catálogo</h3>
  ${bloqueSync}
  <h3>Reportes automáticos</h3>
  ${bloqueReportes}
</section>`;
}
