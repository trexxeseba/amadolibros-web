/**
 * functions/_shared/cover-probe-retention.js
 *
 * Qué historial de sondeos vale la pena guardar dentro del manifest privado.
 *
 * EL PROBLEMA
 *
 * El manifest de portadas pesa ~104 MB y hay que abrirlo entero en memoria
 * cada vez que el cron escribe. La proyección pública —lo mínimo para servir
 * una portada— pesa 32 MB. O sea que ~70% del archivo son datos privados que
 * el sitio no usa para funcionar, y la parte más gorda es `source_probes`:
 * qué URLs se probaron para cada imagen, con su tamaño y resultado.
 *
 * QUIEN LO USA DE VERDAD
 *
 * Se rastreó cada lectura de `source_probes` en el repositorio:
 *
 *   - `covers/v1/quality-report.json`, en la lista `needs_better_source`
 *   - la pantalla interna de QA (worker-sync/image-system-preview.js)
 *
 * Y NADA MÁS. En particular `candidatePriority` —la función que decide qué
 * portada trabajar— no lo mira: le alcanza con `last_error.at`,
 * `current.source_url`, `source_policy_version`, `native_checked_at`,
 * `last_validated_at` y el tamaño de la imagen. El historial no decide nada.
 *
 * LA REGLA
 *
 * El reporte arma `needs_better_source` así:
 *
 *     entry.current.object_key && !googleFutureReadyImage(entry.current)
 *
 * O sea: portadas que YA tienen copia pero todavía no llegan a los 500px que
 * Google va a exigir. Para esas, el historial es justo lo que se mira para
 * entender por qué no se consiguió algo mejor.
 *
 * Para una portada que ya llegó a 500px, ese historial no lo lee nadie. Nunca.
 * Es peso muerto que hay que cargar en memoria en cada escritura.
 *
 * Así que se guarda el historial de las que faltan y se tira el de las que ya
 * están. No se pierde nada que alguien mire: se deja de guardar dos veces lo
 * mismo, porque el reporte de calidad ya lo escribe aparte en cada corrida.
 *
 * SE PODA SOLO LO QUE SE ESCRIBE, Y ESO ES A PROPOSITO
 *
 * La primera versión barría el manifest entero en cada escritura. Tres tests y
 * un chequeo de aceptación la voltearon, y con razón: reescribir con un lote
 * vacío tiene que dejar el manifest IDENTICO. Esa garantía es la que prueba
 * que una reescritura completa no pierde datos, y vale mucho más que ahorrar
 * unos megas más rápido.
 *
 * Así que sólo se poda la entrada que la corrida está escribiendo igual. El
 * archivo se achica de a poco, al ritmo con el que el cron revalida cada
 * portada, en vez de liberar todo de una.
 *
 * LA EXCEPCION, QUE LA ENCONTRO UN TEST
 *
 * Hay un caso que la regla de arriba se llevaba puesto: cuando una variante de
 * la fuente se cayó (un 503, por ejemplo) pero otra sí anduvo, la portada
 * termina bien y el historial es lo ÚNICO que registra que hubo un problema.
 * Sin eso no hay forma de saber que quizás había una imagen mejor detrás de la
 * variante caída.
 *
 * Así que el historial con algún error se conserva siempre, mida lo que mida
 * la imagen final. Son pocas entradas y es justo la información que uno va a
 * querer el día que investigue por qué una portada quedó peor de lo esperado.
 */

import { googleFutureReadyImage } from './image-source-policy.js';

/**
 * ¿Hay que conservar el historial de sondeos de esta entrada?
 *
 * @param {object|null} entry  una entrada del manifest
 * @returns {boolean} true si el reporte de calidad todavía lo puede necesitar
 */
export function shouldKeepProbes(entry) {
  // Un sondeo con error se conserva siempre: es la única marca de que hubo un
  // problema con la fuente, incluso cuando la portada terminó estando bien.
  if (probesRecordAnError(entry?.source_probes)) return true;

  const current = entry?.current;
  // Sin copia todavía: la entrada está en pleno trabajo y el historial es lo
  // único que explica por qué no se pudo. Se conserva.
  if (!current?.object_key) return true;
  // Con copia: sólo importa mientras no llegue al tamaño que Google va a pedir.
  return !googleFutureReadyImage(current);
}

function probesRecordAnError(probes) {
  return Array.isArray(probes) && probes.some(probe => {
    if (!probe || typeof probe !== 'object') return false;
    // `error` es como lo escribe fetchCover; el estado HTTP se mira igual por
    // si alguna vez se registra sin campo `error`.
    if (probe.error) return true;
    const estado = Number(probe.status);
    return Number.isFinite(estado) && estado >= 400;
  });
}

/**
 * La entrada sin el historial que ya no se lee. Devuelve LA MISMA referencia
 * cuando no hay nada que sacar: así el barrido sobre 80.000 entradas no crea
 * ochenta mil objetos nuevos sólo para dejarlos iguales.
 *
 * @param {object|null} entry
 * @returns {object|null}
 */
export function pruneEntryProbes(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  if (!('source_probes' in entry)) return entry;
  if (shouldKeepProbes(entry)) return entry;
  const { source_probes: descartado, ...resto } = entry;
  // `descartado` no se usa: existe sólo para sacarlo del resto.
  void descartado;
  return resto;
}
