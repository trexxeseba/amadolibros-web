/**
 * scripts/seo/showcase-curated-policy.mjs
 *
 * Cuándo la auditoría de fichas vidriera deja de exigir el piloto curado.
 *
 * Vive aparte y sin efectos para poder probarlo: el auditor baja páginas y el
 * catálogo por red, y una regla que decide si un control se aplica o no tiene
 * que poder verificarse sin depender de eso.
 *
 * La regla protege lo mismo que antes. Sólo separa dos cosas que hasta ahora
 * eran la misma falla:
 *
 *   - alguien rompió la ficha escrita a mano  → sigue fallando, igual que antes
 *   - ese libro ya no está a la venta          → deja de exigirse, y se informa
 *
 * Nunca perdona por duda: si no se pudo leer el catálogo, o si el resto del
 * sitio también está fallando, el piloto se exige igual.
 */

/**
 * @param {object} input
 * @param {number} input.status              HTTP de la ficha curada.
 * @param {boolean|null} input.publishedInCatalog
 *        true  = sigue activo en el catálogo
 *        false = ya no está activo
 *        null  = no se pudo leer el catálogo, o sea que NO SE SABE
 * @param {number[]} input.automaticFailureCounts
 *        Cuántas fallas tuvo cada ficha automática de la muestra.
 * @returns {boolean} true sólo si corresponde no exigir el piloto.
 */
export function curatedIsRetired({ status, publishedInCatalog, automaticFailureCounts }) {
  // 1. Sólo un 404 puede significar "ya no está". Una ficha que responde 200
  //    se revisa entera, sin excepciones.
  if (status !== 404) return false;

  // 2. Sólo un "false" explícito sirve. `null` es no saber, y no saber nunca
  //    alcanza para perdonar una falla.
  if (publishedInCatalog !== false) return false;

  // 3. El resto del sitio tiene que estar sano. Si las fichas automáticas
  //    también fallan, ese 404 es del sitio y hay que verlo, no taparlo.
  if (!Array.isArray(automaticFailureCounts) || automaticFailureCounts.length === 0) return false;
  return automaticFailureCounts.every(count => count === 0);
}
