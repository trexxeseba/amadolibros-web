// Títulos de libros para MOSTRAR en pantalla (tarjetas, h1 de la ficha,
// resultados de búsqueda).
//
// Los títulos vienen de Mercado Libre con todas las palabras en mayúscula
// ("Cien Años De Soledad"). Acá se pasan a minúscula los conectores en
// español que no abren el título ni un subtítulo. Es SÓLO presentación: no se
// usa en <title>, meta, JSON-LD, feeds, sitemap, slugs ni datos guardados.

const CONNECTORS = new Set([
  'de', 'del', 'la', 'las', 'el', 'los', 'y', 'e', 'o', 'u', 'en', 'a', 'al',
  'con', 'para', 'por', 'sin', 'sobre', 'un', 'una', 'que', 'se', 'su', 'sus',
  'lo', 'como',
]);

// Signos que pueden rodear a una palabra sin ser parte de ella.
const LEADING_PUNCT = /^[¿¡"'“‘«(\[]+/u;
const TRAILING_PUNCT = /[,;:.!?"'”’»)\]…]+$/u;
// Un guion suelto (o pegado al final de la palabra anterior) abre subtítulo.
const DASH_ONLY = /^[-–—]+$/u;
const OPENS_SEGMENT_AFTER = /[:\-–—.!?(|/]$/u;

function isTitleCaseWord(word) {
  // "De", "Y": primera letra mayúscula y el resto en minúscula. Las siglas
  // ("UY", "II", "DEL" en un título gritado) quedan como vienen.
  const first = word.charAt(0);
  const rest = word.slice(1);
  return first !== first.toLocaleLowerCase('es')
    && rest === rest.toLocaleLowerCase('es');
}

/**
 * Devuelve el título con los conectores en minúscula, salvo:
 * - la primera palabra del título o de un subtítulo (después de ":", "-",
 *   "—", ".", "?", "!", "(", "|" o "/");
 * - palabras en mayúsculas sostenidas (siglas o títulos enteros en mayúscula);
 * - números y cualquier palabra que no sea conector.
 */
export function presentBookTitle(title) {
  if (title === null || title === undefined) return '';
  const text = String(title);
  // Un título entero en mayúsculas se deja como está: bajar sólo los
  // conectores lo dejaría peor.
  if (!/\p{Ll}/u.test(text)) return text;

  const parts = text.split(/(\s+)/u);
  let segmentStart = true;
  return parts.map(part => {
    if (!part || /^\s+$/u.test(part)) return part;
    if (DASH_ONLY.test(part)) {
      segmentStart = true;
      return part;
    }
    const lead = (part.match(LEADING_PUNCT) || [''])[0];
    const trail = (part.slice(lead.length).match(TRAILING_PUNCT) || [''])[0];
    const core = part.slice(lead.length, part.length - trail.length);
    let output = part;
    if (
      !segmentStart
      && !lead.includes('(')
      && core
      && CONNECTORS.has(core.toLocaleLowerCase('es'))
      && isTitleCaseWord(core)
    ) {
      output = lead + core.toLocaleLowerCase('es') + trail;
    }
    segmentStart = OPENS_SEGMENT_AFTER.test(part) || (!core && Boolean(lead));
    return output;
  }).join('');
}
