/**
 * worker-sync/ml-visits.js
 *
 * RADAR DATA 1 (issue #275) — cliente de sólo lectura para el recurso de
 * visitas de Mercado Libre. Reutiliza mlGet() de meli-catalog.js (mismo
 * retry/backoff/rate-limit que ya usa el sync de catálogo) — no crea un
 * cliente HTTP paralelo.
 *
 * AUDITORÍA DE ENDPOINTS (2026-08-27) — ver también el cuerpo del PR:
 *
 *   GET /items/visits?ids=$IDS&date_from=$FROM&date_to=$FROM
 *     — Único de los tres candidatos que acepta múltiples item_id separados
 *       por coma en una sola request (según documentación pública de ML y
 *       una librería cliente de referencia). Se usa acá como la vía de
 *       ingesta diaria en lote: date_from=date_to=un único día calendario,
 *       así el resultado es directamente "visitas de ESE día", no un
 *       acumulado a repartir. Devuelve, por item, un total_visits para el
 *       rango pedido.
 *
 *   GET /items/$ITEM_ID/visits/time_window?last=$LAST&unit=day&ending=$END
 *     — Un solo item_id por request. Se reserva para verificación puntual
 *       (el endpoint /visits/verify de este PR) y para un futuro backfill
 *       histórico dirigido, nunca para la ingesta diaria de todo el
 *       catálogo (sería ~16.000 requests/día).
 *
 *   GET /visits/items?ids=$IDS
 *     — Total histórico acumulado, sin rango de fechas. No sirve para
 *       ventanas 7/30/90 y no se usa en este PR.
 *
 * LÍMITES DOCUMENTADOS (verificados sólo por búsqueda pública — este
 * entorno no tiene salida de red hacia mercadolibre.com ni credenciales
 * OAuth reales, así que ningún número de esta sección fue confirmado
 * empíricamente contra la API real; ver limitación explícita en el PR):
 *   - Rango máximo de fechas: 150 días.
 *   - Datos definitivos hasta ~48h después de ocurridos (por eso
 *     VISITS_AVAILABILITY_LAG_DAYS en index.js).
 *   - El máximo de ids por request en /items/visits no está confirmado de
 *     forma primaria; una fuente secundaria (librería cliente de terceros)
 *     sugiere 50. DEFAULT_VISITS_BATCH_SIZE acá es deliberadamente más
 *     conservador (20, igual que el multi-get de catálogo ya probado en
 *     producción) hasta poder confirmarlo con una corrida real.
 */

import { mlGet } from './meli-catalog.js';

export const DEFAULT_VISITS_BATCH_SIZE = 20;

/**
 * Trae visitas totales para un lote de item_ids en un único rango de
 * fechas (para ingesta diaria, dateFrom === dateTo). No banca deduplicar
 * ni completar ítems ausentes: si Mercado Libre no devuelve un item_id, no
 * se inventa un cero para él — el llamador simplemente no escribe fila.
 */
export async function fetchVisitsRange(itemIds, accessToken, {
  dateFrom,
  dateTo = dateFrom,
  retryBudget,
  mlGetDeps = {},
} = {}) {
  const ids = (itemIds || []).filter(Boolean);
  if (ids.length === 0) return [];
  if (!dateFrom) throw new Error('[Visits] dateFrom es requerido.');

  const url = `https://api.mercadolibre.com/items/visits` +
    `?ids=${ids.map(encodeURIComponent).join(',')}` +
    `&date_from=${encodeURIComponent(dateFrom)}&date_to=${encodeURIComponent(dateTo)}`;

  const data = await mlGet(url, accessToken, { ...mlGetDeps, retryBudget });
  const entries = Array.isArray(data) ? data : [data];
  return entries
    .filter(entry => entry && entry.item_id)
    .map(entry => ({
      item_id: entry.item_id,
      total_visits: Number(entry.total_visits) || 0,
    }));
}

/**
 * Verificación puntual de un solo item_id contra /visits/time_window —
 * usada por el endpoint interno de validación, no por la ingesta diaria.
 */
export async function fetchVisitsTimeWindow(itemId, accessToken, {
  last = 90,
  unit = 'day',
  ending,
  retryBudget,
  mlGetDeps = {},
} = {}) {
  if (!itemId) throw new Error('[Visits] itemId es requerido.');
  const params = new URLSearchParams({ last: String(last), unit });
  if (ending) params.set('ending', ending);
  const url = `https://api.mercadolibre.com/items/${encodeURIComponent(itemId)}/visits/time_window?${params.toString()}`;
  return mlGet(url, accessToken, { ...mlGetDeps, retryBudget });
}
