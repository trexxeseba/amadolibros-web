/**
 * Promo Liquidación Amado: libros en stock que llevan más de un año publicados
 * y no tuvieron ninguna venta en Mercado Libre en los últimos 12 meses.
 *
 * La selección se arma sola en cada lectura del catálogo: entra lo que cumple
 * la regla y sale lo que se vende. La usan la página /liquidacion y el feed de
 * Merchant (custom_label_0 = "liquidacion", para la campaña de Shopping que
 * muestra solo estos libros).
 *
 * Esta capa no cambia precios: muestra el precio vigente del catálogo (el
 * mismo que cobran ficha, carrito y checkout, con la promo web activa si la
 * hay). Así no existe forma de que la página prometa un precio que el carrito
 * no respete.
 *
 * Ventas: tabla ml_sales_* de D1 (la misma del panel). Se excluye por id de
 * publicación y por ISBN, porque un mismo libro puede venderse por su
 * publicación de catálogo y seguir en stock en la publicación común. Si D1 no
 * responde, la selección queda solo por antigüedad: afecta qué se muestra, no
 * lo que se cobra.
 */
import { COUNTED_STATUSES } from '../../worker-sync/ml-sales.js';
import { bookIsbn } from '../../worker-sync/isbn.js';

const DAY_MS = 86400000;

export const LIQUIDACION = Object.freeze({
    name: 'Promo Liquidación Amado',
    path: '/liquidacion',
    feedLabel: 'liquidacion',
    minAgeDays: 365,
    noSalesDays: 365,
});

const COUNTED_SQL = COUNTED_STATUSES.map(s => `'${s}'`).join(',');
const SOLD_CACHE_KEY = 'https://cache.amadolibros.internal/liquidacion/vendidos-365d.json';
const SOLD_CACHE_SECONDS = 3600;

function isStocked(item) {
    return item?.status === 'active' && Number(item?.available_quantity) > 0 && Number(item?.price) > 0;
}

export function ageDays(item, now = Date.now()) {
    const start = Date.parse(item?.start_time || '');
    if (!Number.isFinite(start)) return null;
    return Math.floor((now - start) / DAY_MS);
}

/**
 * Selección pura (sin red): activos con stock, publicados hace más de
 * `minAgeDays`, sin venta reciente por id ni por ISBN.
 * `sold` = { ids: Set, isbns: Set } o null si no hay datos de ventas.
 */
export function selectLiquidation(items, sold = null, now = Date.now(), rules = LIQUIDACION) {
    if (!Array.isArray(items)) return [];
    const soldIds = sold?.ids instanceof Set ? sold.ids : new Set();
    const soldIsbns = sold?.isbns instanceof Set ? sold.isbns : new Set();
    return items.filter(item => {
        if (!isStocked(item)) return false;
        const age = ageDays(item, now);
        if (age === null || age < rules.minAgeDays) return false;
        if (soldIds.has(String(item.id))) return false;
        const isbn = bookIsbn(item.isbn);
        if (isbn && soldIsbns.has(isbn)) return false;
        return true;
    });
}

/** Orden de la vitrina: primero las fichas con mejor presentación, después las más antiguas. */
export function sortLiquidation(items, now = Date.now()) {
    return [...items].sort((a, b) => {
        const sa = Number(a.showcase_score) || 0;
        const sb = Number(b.showcase_score) || 0;
        if (sb !== sa) return sb - sa;
        const aa = ageDays(a, now) ?? 0;
        const ab = ageDays(b, now) ?? 0;
        if (ab !== aa) return ab - aa;
        return String(a.id) < String(b.id) ? -1 : 1;
    });
}

async function querySold(db, now) {
    const since = now - LIQUIDACION.noSalesDays * DAY_MS;
    const { results } = await db.prepare(`SELECT DISTINCT i.item_id, i.isbn FROM ml_sales_items i
      JOIN ml_sales_orders o ON o.order_id=i.order_id
      WHERE o.status IN (${COUNTED_SQL}) AND o.date_created_ms>=?`).bind(since).all();
    const ids = [];
    const isbns = [];
    for (const row of results ?? []) {
        if (row.item_id) ids.push(String(row.item_id));
        const isbn = bookIsbn(row.isbn);
        if (isbn) isbns.push(isbn);
    }
    return { ids: [...new Set(ids)], isbns: [...new Set(isbns)] };
}

/**
 * Ventas de los últimos 12 meses, con caché de borde de una hora.
 * Devuelve null si no hay base o la consulta falla (nunca rompe la página).
 */
export async function recentSales(ctx, now = Date.now()) {
    const db = ctx?.env?.ORDERS_DB;
    if (!db || typeof db.prepare !== 'function') return null;
    const cache = typeof caches !== 'undefined' ? caches.default : null;
    const key = new Request(SOLD_CACHE_KEY);
    try {
        if (cache) {
            const hit = await cache.match(key);
            if (hit) {
                const data = await hit.json();
                return { ids: new Set(data.ids), isbns: new Set(data.isbns) };
            }
        }
        const data = await querySold(db, now);
        if (cache) {
            const response = new Response(JSON.stringify(data), {
                headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${SOLD_CACHE_SECONDS}` },
            });
            const put = cache.put(key, response);
            if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(put); else await put;
        }
        return { ids: new Set(data.ids), isbns: new Set(data.isbns) };
    } catch (error) {
        console.error('liquidacion: ventas no disponibles', error?.message || error);
        return null;
    }
}

/** Set de ids en liquidación, para el feed. */
export async function liquidationIds(ctx, items, now = Date.now()) {
    const sold = await recentSales(ctx, now);
    return new Set(selectLiquidation(items, sold, now).map(item => String(item.id)));
}
