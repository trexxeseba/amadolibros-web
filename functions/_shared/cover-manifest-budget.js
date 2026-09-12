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
 * LO QUE SE PROBO GANA A LO QUE SE MODELO
 *
 * Este módulo se equivocó dos veces seguidas antes de encontrar la forma
 * correcta de plantearlo, y las dos veces del mismo modo: prediciendo una
 * muerte que no ocurría.
 *
 *   - Primero dijo 202% del isolate. Producción estaba viva.
 *   - Corregido, dijo 122%. Y entonces apareció la prueba directa: en la
 *     corrida de CI 34521572816, un Worker REAL de Cloudflare corrió el sync
 *     completo sobre el manifest de 108.774.952 bytes DOS VECES —incluido un
 *     conflicto CAS con reconstrucción entera— y las dos terminaron bien:
 *     mismo hash, 256 shards, 80.871 entradas, `full_manifest_preserved`.
 *     Cero 1102.
 *
 * O sea que el pico absoluto que calcula un modelo desde afuera NO se puede
 * validar: workerd no expone su heap, y todo intento de estimarlo dio de más.
 * Insistir con eso es fabricar alarmas falsas.
 *
 * Así que el guardián dejó de predecir la muerte y pasó a vigilar otra cosa,
 * que sí se puede afirmar con honestidad: CUÁNTO SE ALEJÓ EL MANIFEST DEL
 * TAMAÑO MÁS GRANDE QUE SE PROBÓ QUE FUNCIONA. Mientras esté en ese terreno,
 * no hay nada que decir. Cuando se aleje, hay que volver a probarlo — porque
 * nadie sabe dónde está el techo real, y esa ignorancia es el riesgo.
 *
 * El pico modelado se sigue informando, pero como cota superior conocida por
 * pesimista. No decide nada.
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

/**
 * El manifest más grande con el que se PROBÓ que el escritor completo funciona
 * dentro de un Worker real de Cloudflare.
 *
 * Fuente: run 34521572816 (job cover-index-check). Dos `/prepare` completos
 * sobre este manifest exacto, con conflicto CAS inyectado y reconstrucción
 * entera, ambos exitosos y con el manifest preservado.
 *
 * Cuando una corrida pruebe uno más grande, se sube este número Y se cita la
 * corrida. No se sube "porque parece que aguanta".
 */
export const PROVEN_MANIFEST_BYTES = 108774952;
export const PROVEN_MANIFEST_ENTRIES = 80871;
export const PROVEN_RUN = 'https://github.com/trexxeseba/amadolibros-web/actions/runs/34521572816';

/**
 * Cuánto puede crecer por encima de lo probado antes de que haya que decir
 * algo. No son límites físicos —nadie sabe dónde está el techo real— son la
 * distancia a la que dejamos de tener evidencia.
 */
export const WARN_OVER_PROVEN = 1.25;
export const CRITICAL_OVER_PROVEN = 1.6;

/** Umbrales del pico modelado. Sólo informativos: el modelo no decide. */
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

  // El nivel sale de la distancia a lo PROBADO, no del pico modelado.
  const overProven = Number(manifestBytes) / PROVEN_MANIFEST_BYTES;
  let level = 'ok';
  if (overProven >= CRITICAL_OVER_PROVEN) level = 'critical';
  else if (overProven >= WARN_OVER_PROVEN) level = 'warn';

  // Pasarse de 128 MB no mata el pedido en el acto: Cloudflare deja terminar
  // el que está en vuelo y recicla el isolate para los siguientes. Por eso el
  // cron puede estar por encima del presupuesto y funcionar igual. Lo que se
  // rompe es cuando ese isolate tiene que hacer otra cosa al mismo tiempo —
  // que es literalmente el 1102 que ya nos pasó con el catálogo pausado.
  const overLimit = peakMb > ISOLATE_LIMIT_MB;
  const modelledLevel = usedPercent >= CRITICAL_PERCENT ? 'critical'
    : usedPercent >= WARN_PERCENT ? 'warn' : 'ok';

  return {
    level,
    over_proven_x: round(overProven, 2),
    proven_manifest_mb: round(PROVEN_MANIFEST_BYTES / MB),
    proven_manifest_entries: PROVEN_MANIFEST_ENTRIES,
    proven_run: PROVEN_RUN,
    // Lo que dice el modelo, marcado como lo que es: una cota superior que ya
    // se demostró pesimista. Se informa para vigilarla, no para obedecerla.
    modelled_level: modelledLevel,
    modelled_over_isolate: overLimit,
    // El nivel sale de comparar bytes contra bytes, así que es un hecho y no
    // depende de que haya medición. La medición sólo afina la cota modelada.
    source: medido ? 'measured' : 'modelled',
    enforceable: true,
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
    + ` — ${budget.over_proven_x}x del tamaño probado`
    + ` (${budget.proven_manifest_mb} MB).`;

  const modelo = ` Cota superior modelada: ${budget.estimated_peak_mb} MB`
    + ` de ${budget.isolate_limit_mb} MB — pesimista y no vinculante: a`
    + ` ${budget.proven_manifest_mb} MB el modelo también daba por encima del`
    + ` isolate y un Worker real completó el sync igual (${budget.proven_run}).`;

  if (budget.level === 'critical') {
    return `${cabeza} CRÍTICO: el manifest se fue muy por encima de lo que`
      + ' alguna vez se probó que funciona. Nadie sabe dónde está el techo real,'
      + ' y esa es justamente la parte peligrosa: el 1102 del catálogo pausado'
      + ' apareció así. Hay que correr el chequeo de portadas y, si pasa, subir'
      + ` PROVEN_MANIFEST_BYTES citando la corrida; si no pasa, partir el`
      + ` manifest privado en shards.${modelo}`;
  }
  if (budget.level === 'warn') {
    return `${cabeza} AVISO: creció por encima de lo probado. Todavía no hay`
      + ' motivo para alarmarse, pero conviene volver a probar el escritor'
      + ' completo a este tamaño y dejar constancia, en vez de suponer que'
      + ` aguanta.${modelo}`;
  }
  return `${cabeza} Dentro del terreno probado.${modelo}`;
}
