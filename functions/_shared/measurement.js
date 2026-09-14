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
