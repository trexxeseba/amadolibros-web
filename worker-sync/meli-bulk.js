/**
 * meli-bulk.js — helper del multiget /items/bulk de Mercado Libre.
 *
 * /items/bulk responde [{ status_code, body }]. Cuando se pide `attributes`,
 * cada campo debe llevar el prefijo `body.` (documentación oficial): sin él,
 * la API devuelve entradas sin los campos pedidos y el catálogo queda vacío
 * (incidente del deploy c73ec88: "Solo 0 items activos").
 */

export const BULK_ATTRIBUTE_PREFIX = 'body.';

/**
 * Prefija cada campo con `body.` si todavía no lo lleva. Acepta string
 * separado por comas o array. Ignora espacios y entradas vacías.
 */
export function bulkAttributes(fields) {
  const list = Array.isArray(fields) ? fields : String(fields ?? '').split(',');
  return list
    .map(field => String(field).trim())
    .filter(Boolean)
    .map(field => field.startsWith(BULK_ATTRIBUTE_PREFIX) ? field : BULK_ATTRIBUTE_PREFIX + field)
    .join(',');
}

/**
 * Arma el path `/items/bulk?ids=...&attributes=body....`. Sin `fields`
 * no agrega `attributes` (los usos sin proyección siguen igual).
 */
export function bulkItemsPath(ids, fields) {
  const query = 'ids=' + ids.join(',');
  const attributes = fields === undefined ? '' : bulkAttributes(fields);
  return '/items/bulk?' + query + (attributes ? '&attributes=' + attributes : '');
}

/**
 * Verifica que un `attributes` destinado a /items/bulk tenga todos sus
 * campos con `body.`. Devuelve los campos que no lo tienen.
 */
export function unprefixedBulkAttributes(attributes) {
  return String(attributes ?? '')
    .split(',')
    .map(field => field.trim())
    .filter(field => field && !field.startsWith(BULK_ATTRIBUTE_PREFIX));
}
