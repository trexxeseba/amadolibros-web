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
 * MEDIDO GANA A MODELADO, SIEMPRE
 *
 * Hay dos formas de saber cuánto pesa el grafo: medirlo sobre el manifest real
 * (`scripts/cover-manifest-measure.mjs`) o estimarlo desde el tamaño del JSON
 * con un factor sacado de manifests sintéticos. Cuando hay medición se usa la
 * medición, y el modelo queda sólo como referencia.
 *
 * Esto no es una preferencia estética. La primera vez que el modelo solo se
 * enfrentó al manifest de producción dijo 202% del isolate —o sea, "esto ya
 * tendría que estar muerto"— y producción estaba viva y sirviendo portadas.
 * Un guardián que se contradice con la realidad la primera vez que habla no
 * sirve para nada: lo van a ignorar justo el día que tenga razón. Por eso el
 * modelo solo NUNCA pone el CI en rojo; sólo la medición puede.
 *
 * DE DÓNDE SALEN LAS CONSTANTES
 *
 * De medir, no de estimar. `scripts/cover-memory-benchmark.mjs` arma manifests
 * sintéticos con la forma real y mide el heap de V8. Se corre así:
 *
 *     node --expose-gc scripts/cover-memory-benchmark.mjs
 *
 * TRES FORMAS DE MEDIR MAL QUE YA SE PROBARON, PARA NO REPETIRLAS
 *
 * 1. Repetir el mismo sha256 en todas las entradas: V8 deduplica cadenas
 *    idénticas y el grafo mide 0,9× en vez de 2,2×. Optimista por 2,5.
 *
 * 2. `JSON.stringify` del manifest entero para medir su tamaño: crea una
 *    cadena de cien megas que ensucia la medición siguiente. Hay que contar
 *    los bytes por pedazos.
 *
 * 3. La peor: CONSTRUIR los objetos en JavaScript en vez de PARSEARLOS.
 *    Sobre exactamente los mismos datos, construidos con literales dan 2,2× y
 *    parseados con JSON.parse dan 1,25×. V8 parsea mucho más compacto porque
 *    comparte la forma de los objetos y las cadenas. El Worker PARSEA, así que
 *    el número que vale es 1,25×; el 2,2× era pesimista por 76%.
 *
 * Por eso el modelo es sólo una referencia y la medición sobre el manifest
 * real es la que manda.
 */

/** El isolate de un Worker de Cloudflare. No es configurable. */
export const ISOLATE_LIMIT_MB = 128;

/**
 * Cuánto pesa en memoria el manifest PARSEADO, por cada MB de JSON.
 *
 * Medido con JSON.parse sobre un manifest del tamaño real (112 MB, 80.871
 * entradas, 1387 bytes por entrada): 1,25×. Se deja 1,3 como margen.
 *
 * Ojo con la trampa 3 de arriba: construir los mismos objetos con literales da
 * 2,2×. Ese número es real pero no es el que corre en el Worker.
 */
export const GRAPH_PER_JSON_MB = 1.3;

/**
 * La copia superficial de `entries` que hace writeManifestAttempt para que un
 * intento fallido no deje un grafo a medio mezclar.
 *
 * Escala con la CANTIDAD de entradas, no con los bytes: copia claves, no
 * contenido. Medido 2,4 MB para 80.871 entradas = 31 bytes por entrada; se
 * deja 56 de margen. Tenerlo en "por MB de JSON" era un error de dimensión y
 * daba de más en manifests con entradas grandes.
 */
export const ENTRIES_COPY_BYTES_PER_ENTRY = 56;

/** Sólo para cuando no se sabe cuántas entradas hay. Peor caso observado. */
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
 * @param {object} [input.measured]     lo que devolvió cover-manifest-measure.mjs
 *        sobre el manifest REAL: { graph_mb, entries_copy_mb, graph_per_json }.
 *        Si viene, manda: el modelo pasa a ser referencia.
 * @returns {object} el presupuesto, con las cuentas a la vista
 */
export function coverManifestBudget({ manifestBytes, entries = null, measured = null }) {
  const jsonMb = Number(manifestBytes) / MB;
  if (!Number.isFinite(jsonMb) || jsonMb <= 0) {
    throw new Error('cover-budget-invalid-manifest-bytes');
  }

  const medido = Number.isFinite(Number(measured?.graph_mb)) && Number(measured.graph_mb) > 0;
  const graphMb = medido ? Number(measured.graph_mb) : jsonMb * GRAPH_PER_JSON_MB;
  const cuantas = Number(entries);
  const copyMb = medido && Number.isFinite(Number(measured.entries_copy_mb))
    ? Number(measured.entries_copy_mb)
    : (Number.isFinite(cuantas) && cuantas > 0
      ? (cuantas * ENTRIES_COPY_BYTES_PER_ENTRY) / MB
      : jsonMb * ENTRIES_COPY_PER_JSON_MB);
  const peakMb = graphMb + copyMb + SHARD_BUFFERS_MB + WORKER_BASELINE_MB;
  const usedPercent = (peakMb / ISOLATE_LIMIT_MB) * 100;

  // A cuántos MB de JSON se llega al techo, y cuánto falta desde hoy.
  // El factor que se usa para proyectar es el medido si lo hay: extrapolar con
  // el sintético cuando se tiene el real sería tirar el dato bueno.
  const porMb = (graphMb + copyMb) / jsonMb;
  const jsonMbAtLimit = (ISOLATE_LIMIT_MB - SHARD_BUFFERS_MB - WORKER_BASELINE_MB) / porMb;
  const growthLeft = jsonMbAtLimit / jsonMb;

  let level = 'ok';
  if (usedPercent >= CRITICAL_PERCENT) level = 'critical';
  else if (usedPercent >= WARN_PERCENT) level = 'warn';

  // Pasarse de 128 MB no mata el pedido en el acto: Cloudflare deja terminar
  // el que está en vuelo y recicla el isolate para los siguientes. Por eso el
  // cron puede estar por encima del presupuesto y funcionar igual. Lo que se
  // rompe es cuando ese isolate tiene que hacer otra cosa al mismo tiempo —
  // que es literalmente el 1102 que ya nos pasó con el catálogo pausado.
  const overLimit = peakMb > ISOLATE_LIMIT_MB;

  return {
    level,
    over_limit: overLimit,
    // Sin medición el nivel se informa igual, pero no puede poner el CI en
    // rojo: quien lo consuma tiene que mirar esta bandera antes de fallar.
    source: medido ? 'measured' : 'modelled',
    enforceable: medido,
    manifest_mb: round(jsonMb),
    entries,
    bytes_per_entry: Number.isFinite(Number(entries)) && Number(entries) > 0
      ? Math.round(Number(manifestBytes) / Number(entries))
      : null,
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
    // Para poder comparar de un vistazo cuánto se apartó el modelo sintético
    // de la realidad, que es exactamente lo que hay que vigilar.
    modelled_graph_mb: round(jsonMb * GRAPH_PER_JSON_MB),
    measured_graph_per_json: medido ? Number(measured.graph_per_json) || null : null,
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

  if (!budget.enforceable) {
    return `${cabeza} SIN MEDIR: es una estimación desde el tamaño del JSON, no`
      + ' una medición del manifest real, así que no decide nada por sí sola.'
      + ' Para medirlo: node --expose-gc scripts/cover-manifest-measure.mjs <manifest.json.gz>';
  }
  if (budget.level === 'critical') {
    // Ojo con el texto: decir "está por morir" cuando el sitio funciona hace
    // que nadie vuelva a creerle al guardián. Lo que pasa de verdad es que ya
    // se pasó del presupuesto y sobrevive porque Cloudflare deja terminar el
    // pedido en vuelo y recicla el isolate.
    if (budget.over_limit) {
      return `${cabeza} CRÍTICO: el escritor YA se pasa del isolate.`
        + ' Sigue andando sólo porque Cloudflare deja terminar el pedido en vuelo'
        + ' y recicla el isolate — pero cuando a ese isolate le toca otra cosa al'
        + ' mismo tiempo, sale 1102. Eso ya pasó con el catálogo pausado.'
        + ' Hay que partir el manifest privado en shards.';
    }
    return `${cabeza} CRÍTICO: al escritor de portadas casi no le queda margen`
      + ` (${budget.growth_left_x}x). Hay que partir el manifest privado en shards.`;
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
