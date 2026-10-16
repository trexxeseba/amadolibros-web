/**
 * meli-bulk.js — helper del multiget /items/bulk de Mercado Libre.
 *
 * /items/bulk responde [{ status_code, body }]. `attributes` proyecta la
 * entrada completa, no sólo el item: por eso cada campo del item lleva el
 * prefijo `body.` (documentación oficial) y hay que pedir también
 * `status_code`, porque si no la entrada llega como { body } sin status.
 * Sin `body.` el catálogo quedó vacío (deploy c73ec88) y, con `body.` pero sin
 * `status_code`, también (deploy 16bb9b7): las dos veces "Solo 0 items activos".
 */

export const BULK_ATTRIBUTE_PREFIX = 'body.';
export const BULK_STATUS_FIELD = 'status_code';

/**
 * Prefija cada campo del item con `body.` si todavía no lo lleva y antepone
 * `status_code` para que la entrada conserve su estado HTTP. Acepta string
 * separado por comas o array. Ignora espacios y entradas vacías.
 */
export function bulkAttributes(fields) {
  const list = Array.isArray(fields) ? fields : String(fields ?? '').split(',');
  const prefixed = list
    .map(field => String(field).trim())
    .filter(field => field && field !== BULK_STATUS_FIELD)
    .map(field => field.startsWith(BULK_ATTRIBUTE_PREFIX) ? field : BULK_ATTRIBUTE_PREFIX + field);
  return prefixed.length ? [BULK_STATUS_FIELD, ...prefixed].join(',') : '';
}

/**
 * Normaliza una entrada de multiget y devuelve el item o null. Acepta el
 * formato de /items/bulk ({ status_code, body }), el anterior ({ code, body }),
 * una entrada proyectada sin status ({ body }) y un item suelto. Una entrada
 * con status distinto de 200 no aporta item; una entrada sin status pero con
 * body se acepta (la API no devuelve body para ids fallidos).
 */
export function bulkEntryItem(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const status = entry.status_code ?? entry.code;
  const body = entry.body && typeof entry.body === 'object' ? entry.body : null;
  if (status !== undefined) return status === 200 && body ? body : null;
  if (body) return body;
  return 'body' in entry ? null : entry;
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
 * campos del item con `body.`. Devuelve los campos que no lo tienen
 * (`status_code` es de la entrada y no cuenta).
 */
export function unprefixedBulkAttributes(attributes) {
  return String(attributes ?? '')
    .split(',')
    .map(field => field.trim())
    .filter(field => field && field !== BULK_STATUS_FIELD && !field.startsWith(BULK_ATTRIBUTE_PREFIX));
}
