/**
 * functions/_shared/measurement.js
 *
 * Una sola línea de medición para las páginas que arma un Function de
 * Cloudflare — catálogo, fichas de libro, categorías, especialidades y las
 * landings de autor.
 *
 * POR QUÉ EXISTE ESTE ARCHIVO
 *
 * Esas páginas se sirven con HTML propio, sin pasar por BaseLayout.astro, así
 * que quedaron fuera de toda la medición del sitio: ni GA4 ni el píxel de Meta.
 * No es un detalle menor — son el catálogo y cada una de las ~3.690 fichas, o
 * sea las páginas donde la gente efectivamente mira libros.
 *
 * El síntoma más claro estaba escrito en el código de la ficha: llama a
 * AmadoAnalytics.trackCommerce('view_item', …) dentro de un `if` que pregunta
 * si AmadoAnalytics existe. Como este archivo nunca se cargaba ahí, la
 * respuesta era siempre no y el evento no se disparó jamás. El `if` lo hacía
 * fallar en silencio.
 *
 * SIN defer A PROPÓSITO
 *
 * La ficha llama a trackCommerce desde un <script> inline en el cuerpo, que
 * corre mientras el parser baja. Con `defer` este archivo se ejecutaría
 * después y AmadoAnalytics seguiría sin existir en ese momento: el mismo bug,
 * más difícil de ver. Es un archivo chico y propio, servido desde el mismo
 * dominio.
 */
export function measurementHeadHtml() {
  return '<script src="/analytics-events.js"></script>';
}

/**
 * Atributos que dejan la búsqueda medible desde el cliente.
 *
 * GA4 ya dispara view_search_results por su cuenta: el sitio busca con `?q=`,
 * que es uno de los parámetros que la Medición mejorada reconoce por defecto.
 * Nunca se vio porque /catalogo no cargaba GA4; al corregir eso empieza a
 * llegar sin que nadie lo programe. Por eso acá NO se expone nada para emitir
 * un evento de búsqueda propio: sería contar la misma búsqueda dos veces.
 *
 * Lo que GA4 no trae es la CANTIDAD DE RESULTADOS, que es el dato que importa
 * para una librería: una búsqueda sin resultados es un cliente diciendo por
 * escrito qué le falta al catálogo.
 *
 * Va también si había filtros puestos, porque cero resultados no siempre es
 * demanda nueva: puede ser un filtro de categoría, un ISBN mal tipeado o una
 * falta de ortografía. Sin ese dato las causas no se pueden separar, y se
 * termina comprando stock por un error de tipeo.
 *
 * @param {string} safeQuery Consulta YA escapada para HTML.
 */
export function searchResultsAttrs({ safeQuery, totalResults, filtered = false }) {
  if (!safeQuery) return '';
  const total = Number.isFinite(Number(totalResults)) ? Number(totalResults) : 0;
  return ` data-search-term="${safeQuery}" data-search-results="${total}"`
    + (filtered ? ' data-search-filtered="1"' : '');
}
