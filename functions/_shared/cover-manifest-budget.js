/**
 * functions/_shared/cover-manifest-budget.js
 *
 * Cuánto aire le queda a la cadena de portadas antes de que Cloudflare mate el
 * pedido con 1102 ("Worker exceeded resource limits").
 *
 * POR QUÉ EXISTE ESTO
 *
 * El manifest privado de portadas es UN objeto JSON con una entrada por imagen.
 * El lector ya está resuelto y es seguro: lee un root de 128 KB como mucho y
 * sólo los shards que necesita, nunca el manifest entero. El que corre riesgo
 * es el ESCRITOR — el cron que espeja portadas — porque para reescribir el
 * manifest tiene que tenerlo entero en memoria, y el isolate tiene 128 MB.
 *
 * Eso ya nos pasó una vez: el publicador de catálogo pausado murió con 1102 y
 * hubo que sacarle el espejo de portadas de adentro del pedido (ver el
 * comentario en worker-sync/index.js y los runs 34366493021 y 34409174184).
 * Lo que faltaba después de ese arreglo era saber CUÁNTO falta para la próxima.
 *
 * Este módulo no arregla el límite: lo hace visible con meses de anticipación,
 * que es lo que no teníamos. Nadie se entera de un 1102 hasta que pasa.
 *
 * DE DÓNDE SALEN LAS CONSTANTES
 *
 * De medir, no de estimar. `scripts/cover-memory-benchmark.mjs` arma manifests
 * sintéticos con la forma real y mide el heap de V8. Se corre así:
 *
 *     node --expose-gc scripts/cover-memory-benchmark.mjs
 *
 * Lo importante que se aprendió midiendo: el grafo ya parseado pesa 2,2 veces
 * el JSON. La primera medición dio 0,9× porque el manifest sintético repetía el
 * mismo sha256 en todas las entradas y V8 deduplica cadenas idénticas. Con un
 * hash distinto por entrada —como son de verdad— el número se triplica. Si
 * alguien vuelve a correr el benchmark, que use datos únicos o el resultado va
 * a salir optimista y este guardián va a mentir.
 */

/** El isolate de un Worker de Cloudflare. No es configurable. */
export const ISOLATE_LIMIT_MB = 128;

/**
 * Cuánto pesa en memoria el manifest parseado, por cada MB de JSON.
 * Medido: 79,5/36,2 = 2,20 · 120,5/54,3 = 2,22 · 156,3/72,3 = 2,16.
 */
export const GRAPH_PER_JSON_MB = 2.2;

/**
 * La copia superficial de `entries` que hace writeManifestAttempt para que un
 * intento fallido no deje un grafo a medio mezclar. Medido entre 0,08 y 0,11;
 * se toma el peor.
 */
export const ENTRIES_COPY_PER_JSON_MB = 0.11;

/**
 * Los shards en vuelo. prepareCoverIndex mantiene ocho proyecciones a la vez y
 * cada una está tope a 1 MB por `MAX_SHARD_BYTES`, así que esto está acotado
 * por diseño y no crece con el catálogo.
 */
export const SHARD_BUFFERS_MB = 8;

/**
 * El piso: el runtime, el código del Worker y el catálogo que el cron ya tiene
 * cargado cuando llega a escribir. Es la constante menos medida de todas —
 * conviene tratarla como una reserva, no como un dato.
 */
export const WORKER_BASELINE_MB = 12;

/** Arriba de esto hay que empezar la migración; arriba del segundo, ya es tarde. */
export const WARN_PERCENT = 60;
export const CRITICAL_PERCENT = 80;

const MB = 1024 * 1024;

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * @param {object} input
 * @param {number} input.manifestBytes  tamaño del manifest privado servido por R2
 * @param {number} [input.entries]      cuántas entradas tiene (sólo para informar)
 * @returns {object} el presupuesto, con las cuentas a la vista
 */
export function coverManifestBudget({ manifestBytes, entries = null }) {
  const jsonMb = Number(manifestBytes) / MB;
  if (!Number.isFinite(jsonMb) || jsonMb <= 0) {
    throw new Error('cover-budget-invalid-manifest-bytes');
  }

  const graphMb = jsonMb * GRAPH_PER_JSON_MB;
  const copyMb = jsonMb * ENTRIES_COPY_PER_JSON_MB;
  const peakMb = graphMb + copyMb + SHARD_BUFFERS_MB + WORKER_BASELINE_MB;
  const usedPercent = (peakMb / ISOLATE_LIMIT_MB) * 100;

  // A cuántos MB de JSON se llega al techo, y cuánto falta desde hoy.
  const jsonMbAtLimit = (ISOLATE_LIMIT_MB - SHARD_BUFFERS_MB - WORKER_BASELINE_MB)
    / (GRAPH_PER_JSON_MB + ENTRIES_COPY_PER_JSON_MB);
  const growthLeft = jsonMbAtLimit / jsonMb;

  let level = 'ok';
  if (usedPercent >= CRITICAL_PERCENT) level = 'critical';
  else if (usedPercent >= WARN_PERCENT) level = 'warn';

  return {
    level,
    manifest_mb: round(jsonMb),
    entries,
    // El desglose se informa entero a propósito: si mañana el número sorprende,
    // se tiene que poder ver cuál de los términos lo movió sin volver a medir.
    breakdown_mb: {
      graph: round(graphMb),
      entries_copy: round(copyMb),
      shard_buffers: SHARD_BUFFERS_MB,
      worker_baseline: WORKER_BASELINE_MB,
    },
    estimated_peak_mb: round(peakMb),
    isolate_limit_mb: ISOLATE_LIMIT_MB,
    used_percent: round(usedPercent),
    manifest_mb_at_limit: round(jsonMbAtLimit),
    // "1.6x" = el manifest puede crecer 60% más antes de morir.
    growth_left_x: round(growthLeft, 2),
    entries_at_limit: Number.isFinite(Number(entries)) && Number(entries) > 0
      ? Math.floor(Number(entries) * growthLeft)
      : null,
    thresholds: { warn_percent: WARN_PERCENT, critical_percent: CRITICAL_PERCENT },
  };
}

/**
 * El texto que va al informe. Dice qué hacer, no sólo cuánto queda: un número
 * suelto en un JSON de CI no lo lee nadie hasta que ya es tarde.
 */
export function coverBudgetMessage(budget) {
  const cabeza = `Manifest de portadas: ${budget.manifest_mb} MB`
    + `${budget.entries ? ` (${budget.entries} entradas)` : ''}`
    + ` → pico estimado ${budget.estimated_peak_mb} MB de ${budget.isolate_limit_mb} MB`
    + ` (${budget.used_percent}%).`;

  if (budget.level === 'critical') {
    return `${cabeza} CRÍTICO: el escritor de portadas está por morir con 1102.`
      + ' Hay que partir el manifest privado en shards YA;'
      + ` al ritmo actual queda ${budget.growth_left_x}x de margen.`;
  }
  if (budget.level === 'warn') {
    return `${cabeza} AVISO: queda ${budget.growth_left_x}x de crecimiento`
      + `${budget.entries_at_limit ? ` (hasta ~${budget.entries_at_limit} entradas)` : ''}`
      + ' antes de que el cron muera con 1102. Es el momento de empezar la'
      + ' migración a un manifest en shards, no cuando ya esté roto.';
  }
  return `${cabeza} Margen suficiente: queda ${budget.growth_left_x}x de crecimiento`
    + `${budget.entries_at_limit ? ` (hasta ~${budget.entries_at_limit} entradas)` : ''}.`;
}
