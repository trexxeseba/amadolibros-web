// functions/_shared/generic-author.js
//
// FICHAS-QUALITY-GUARD-1 — fuente única de verdad sobre qué valores de
// "autor" NO son una autoría, sino la ausencia de autoría escrita de
// distintas maneras por el origen de datos ('Desconocido', 'Unknown',
// 'Varios autores', 'N/A'…).
//
// Por qué vive acá y no en showcase-ranking.js: la autoría se muestra en
// varias superficies independientes — el JSON-LD de la ficha, la tabla de
// datos, el mensaje de WhatsApp, el bloque de relacionados y la descripción
// del feed de Merchant. Cada una tenía su propio criterio (o ninguno), así
// que "Desconocido" desaparecía de una y seguía apareciendo en las otras.
// Con un único módulo compartido, arreglar la lista arregla todas a la vez.
//
// REGLA: un valor genérico se OMITE. Nunca se sustituye por "Varios
// autores", "Equipo editorial" ni ninguna otra autoría inventada. El dato
// queda ausente hasta que exista una fuente verificable.

const GENERIC_AUTHORS = new Set([
  'anónimo',
  'anonimo',
  'autor',
  'autores',
  'autor desconocido',
  'autor no especificado',
  'autoria desconocida',
  'autoría desconocida',
  'desconocida',
  'desconocido',
  'no aplica',
  'no especificado',
  'no especificada',
  'n/a',
  'na',
  's/a',
  's/d',
  'sin autor',
  'sin datos',
  'sin especificar',
  'unknown',
  'unknown author',
  'varios',
  'varios autores',
  'vv aa',
  'vv. aa.',
  'vvaa',
  'aa vv',
  'aa. vv.',
  'aavv',
]);

function normalizeAuthorKey(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLocaleLowerCase('es');
}

/**
 * true cuando el valor no identifica a una persona u organización real:
 * vacío, nulo, o una de las formas conocidas de "no sabemos quién es".
 * @param {unknown} value
 */
export function isGenericAuthor(value) {
  const key = normalizeAuthorKey(value);
  if (!key) return true;
  if (GENERIC_AUTHORS.has(key)) return true;
  // Variantes acentuadas normalizadas ('anónimo' -> 'anonimo') y con puntos
  // sueltos ('vv.aa.') caen acá sin necesidad de enumerarlas todas.
  return GENERIC_AUTHORS.has(key.replace(/[.\s]/g, ''));
}

/**
 * Devuelve la autoría real ya limpia, o null si es genérica/ausente.
 * Usar esto en vez de `item.author` en cualquier superficie visible.
 * @param {unknown} value
 */
export function realAuthor(value) {
  if (isGenericAuthor(value)) return null;
  return String(value).replace(/\s+/g, ' ').trim();
}

// Fragmentos explícitos "De <autor genérico>" que algunos títulos mostrados
// y textos alt arrastran desde el origen. Se limpian SÓLO en el texto
// visible; el título comercial original nunca se modifica.
const GENERIC_AUTHOR_ALTERNATION = [...GENERIC_AUTHORS]
  .sort((a, b) => b.length - a.length)
  .map(value => value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&').replace(/\s+/g, '\\s+'))
  .join('|');

const DE_GENERIC_AUTHOR_RE = new RegExp(
  `[,\\u2014\\-–—]?\\s*\\bde\\s+(?:${GENERIC_AUTHOR_ALTERNATION})\\b\\.?`,
  'giu',
);

/**
 * Quita fragmentos como «De Desconocido» / «, de Varios autores» de un texto
 * visible (título mostrado en una tarjeta, atributo alt). No toca el título
 * comercial almacenado: se aplica sólo al string que se va a pintar.
 *
 * Es conservador a propósito: sólo elimina la construcción "de <genérico>",
 * nunca palabras sueltas, para no mutilar títulos legítimos.
 * @param {unknown} value
 */
export function stripGenericAuthorMention(value) {
  const text = String(value ?? '');
  if (!text) return text;
  return text
    .replace(DE_GENERIC_AUTHOR_RE, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/[\s,—\-–—]+$/u, '')
    .trim();
}
