/**
 * functions/_shared/search-misses.js
 *
 * Búsquedas del catálogo que no encontraron nada: el pedido más directo que
 * hace un visitante y que hasta ahora se perdía (el texto de ?q= se saca a
 * propósito de lo que va a GA4). Alimenta el bloque «demanda sin atender» del
 * informe semanal.
 *
 * Qué se guarda: el texto normalizado y un contador por día (hora de
 * Montevideo). Nada de IP, navegador ni sesión. Lo que parece un correo o un
 * teléfono no se guarda; un ISBN sí, porque es justamente el pedido más
 * preciso que puede hacer alguien.
 *
 * Nunca rompe ni demora la página: corre en waitUntil y traga sus errores.
 */

export const SEARCH_MISS_MAX_LENGTH = 80;
const MONTEVIDEO_OFFSET_MS = 3 * 60 * 60 * 1000; // UTC-3, sin horario de verano

const BOT_UA_RE = /bot|crawl|spider|slurp|preview|monitor|headless|lighthouse|curl|wget|python|go-http|java\/|httpclient|axios|node-fetch/i;

/** El día del registro, en Montevideo. */
export function montevideoDate(now = new Date()) {
  return new Date(now.getTime() - MONTEVIDEO_OFFSET_MS).toISOString().slice(0, 10);
}

export function isLikelyBot(userAgent) {
  const ua = String(userAgent || '');
  return !ua || BOT_UA_RE.test(ua);
}

/**
 * Texto que se guarda, o '' si no se debe guardar. Minúsculas, sin tildes,
 * espacios colapsados y sin signos raros: «García Márquez» y «garcia marquez»
 * cuentan como la misma búsqueda.
 */
export function normalizeSearchMiss(raw) {
  const text = String(raw ?? '');
  if (!text.trim() || text.includes('@')) return '';

  // Números largos: sólo pasa el ISBN entero (10 o 13 dígitos, con o sin
  // guiones). Cualquier otro número de 7 dígitos o más puede ser un teléfono
  // o un documento.
  const compact = text.replace(/[\s.-]/g, '');
  if (/\d{7,}/.test(compact) && !/^(97[89])?\d{9}[\dx]$/i.test(compact)) return '';

  const normalized = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9ñ\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SEARCH_MISS_MAX_LENGTH)
    .trim();
  return normalized;
}

/**
 * Suma uno a la búsqueda del día. Devuelve si se escribió algo, para los
 * tests; quien la llama no espera el resultado.
 */
export async function recordSearchMiss({ db, query, now = new Date() }) {
  const normalized = normalizeSearchMiss(query);
  if (!normalized || !db || typeof db.prepare !== 'function') return false;
  const at = now.toISOString();
  try {
    await db.prepare(
      'INSERT INTO search_misses (date, query, count, first_seen, last_seen) VALUES (?, ?, 1, ?, ?) ' +
      'ON CONFLICT(date, query) DO UPDATE SET count = count + 1, last_seen = excluded.last_seen'
    ).bind(montevideoDate(now), normalized, at, at).run();
    return true;
  } catch {
    return false;
  }
}
