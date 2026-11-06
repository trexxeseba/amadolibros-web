/**
 * Promo Liquidación Amado: qué libros entran en /liquidacion y en la etiqueta
 * `custom_label_0=liquidacion` del feed de Merchant.
 *
 * Dos modos:
 *
 * 1. Lista (el bueno): `data/liquidacion.json` → `lista.ids`, la lista de Seba
 *    con los libros sin venta en 2 años en Mercado Libre. Entra solo lo que está
 *    en la lista, activo y con stock, menos las exclusiones automáticas:
 *      - libros médicos (tema medicina-salud, `excluir.medicos`);
 *      - publicados hace menos de 90 días o sin fecha (`excluir.recientes`);
 *      - "gana precio" o sin competencia, según el último reporte del motor
 *        Precio Ganador (`excluir.*.ids`, regenerado con
 *        scripts/liquidacion/actualizar-exclusiones.mjs).
 *    Todo sale del JSON versionado y del catálogo (stock y fecha), sin datos
 *    en vivo: así la página, el carrito y el cobro deciden exactamente igual.
 *
 * 2. Regla anterior (mientras la lista esté vacía): más de un año publicado y
 *    sin ventas en 12 meses en D1. Falla cerrada: si D1 no responde, la
 *    selección queda vacía; nunca se muestra todo el stock.
 *
 * El feed de Merchant usa solo el modo lista: sin lista, no etiqueta nada.
 *
 * Precio: desde el 10/11/2026 00:00 (descuentos.js) applyLiquidationPrices
 * pone el precio de liquidación (descuento base de descuentos.js sobre el habitual, piso $1.200) al leer
 * el catálogo, igual que la promo web. Ficha, listados, feed, carrito y cobro
 * leen ese mismo precio. Los libros que quedarían bajo el piso no reciben
 * descuento y salen de la vitrina y del feed (header x-liquidacion-excluidos,
 * motivo bajo_piso).
 */
import { COUNTED_STATUSES } from '../../worker-sync/ml-sales.js';
import { bookIsbn } from '../../worker-sync/isbn.js';
import LIQUIDACION_DATA from './liquidacion-data.js';
import { liquidationPrice, liquidationPricingActive } from './descuentos.js';

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
 * Regla anterior, pura (sin red): activos con stock, publicados hace más de
 * `minAgeDays`, sin venta reciente por id ni por ISBN.
 * `sold` = { ids: Set, isbns: Set }. Sin datos de ventas (null) devuelve []:
 * falla cerrada, para no ofrecer todo el stock como liquidación.
 */
export function selectLiquidation(items, sold = null, now = Date.now(), rules = LIQUIDACION) {
    if (!Array.isArray(items) || !sold) return [];
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

/** La lista de Seba ya normalizada, o null si todavía no la entregó. */
export function liquidationList(data = LIQUIDACION_DATA) {
    const ids = (Array.isArray(data?.lista?.ids) ? data.lista.ids : [])
        .map(id => String(id).trim().toUpperCase())
        .filter(id => /^MLU\d+$/.test(id));
    if (ids.length === 0) return null;
    const set = key => new Set((data?.excluir?.[key]?.ids ?? []).map(String));
    return {
        ids: new Set(ids),
        medicos: set('medicos'),
        recientes: set('recientes'),
        ganaPrecio: set('gana_precio'),
        sinCompetencia: set('sin_competencia'),
    };
}

/**
 * Modo lista, puro y determinista (solo JSON + catálogo). Devuelve los
 * elegibles y cuántos quedaron afuera por cada exclusión (cada libro cuenta
 * en la primera que lo saca, en este orden).
 */
export function selectFromList(items, list) {
    const excluded = { fuera_de_stock: 0, medicos: 0, recientes: 0, gana_precio: 0, sin_competencia: 0 };
    if (!list || !Array.isArray(items)) return { selected: [], excluded };
    const inList = items.filter(item => list.ids.has(String(item?.id)));
    const stocked = inList.filter(isStocked);
    excluded.fuera_de_stock = list.ids.size - stocked.length;
    const selected = [];
    for (const item of stocked) {
        const id = String(item.id);
        if (list.medicos.has(id)) { excluded.medicos++; continue; }
        if (list.recientes.has(id)) { excluded.recientes++; continue; }
        if (list.ganaPrecio.has(id)) { excluded.gana_precio++; continue; }
        if (list.sinCompetencia.has(id)) { excluded.sin_competencia++; continue; }
        selected.push(item);
    }
    return { selected, excluded };
}

/**
 * Selección completa para la página. `mode` = 'lista' | 'regla';
 * `sales` = 'd1' | 'sin-datos' | 'no-aplica'.
 */
export async function resolveLiquidation(ctx, items, { now = Date.now(), data = LIQUIDACION_DATA } = {}) {
    const list = liquidationList(data);
    if (list) {
        const { selected, excluded } = selectFromList(items, list);
        if (!liquidationPricingActive(now, ctx?.env)) return { mode: 'lista', sales: 'no-aplica', selected, excluded };
        const priced = selected.filter(item => item.liquidation === true);
        excluded.bajo_piso = selected.filter(item => item.liquidation_skip === 'bajo_piso').length;
        return { mode: 'lista', sales: 'no-aplica', selected: priced, excluded };
    }
    const sold = await recentSales(ctx, now);
    return { mode: 'regla', sales: sold ? 'd1' : 'sin-datos', selected: selectLiquidation(items, sold, now), excluded: null };
}

/**
 * Set de ids en liquidación para el feed: solo la lista de Seba, nunca la
 * regla de 1 año. Con el precio de liquidación vigente, solo los que lo
 * recibieron (los que quedarían bajo el piso no se promocionan).
 */
export function liquidationIds(items, { data = LIQUIDACION_DATA, now = Date.now(), env = {} } = {}) {
    const list = liquidationList(data);
    if (!list) return new Set();
    let selected = selectFromList(items, list).selected;
    if (liquidationPricingActive(now, env)) selected = selected.filter(item => item.liquidation === true);
    return new Set(selected.map(item => String(item.id)));
}

/**
 * Precio de liquidación al leer el catálogo (desde LIQUIDACION_PRECIO.startsAt).
 * Devuelve una copia: los elegibles con `price` de liquidación,
 * `original_price` = habitual y `liquidation: true`; los que quedarían bajo el
 * piso, intactos con `liquidation_skip: 'bajo_piso'`. Idempotente.
 */
export function applyLiquidationPrices(items, { now = Date.now(), env = {}, data = LIQUIDACION_DATA } = {}) {
    if (!Array.isArray(items) || !liquidationPricingActive(now, env)) return items;
    const list = liquidationList(data);
    if (!list) return items;
    const eligible = new Set(selectFromList(items, list).selected.map(item => String(item.id)));
    if (eligible.size === 0) return items;
    return items.map(item => {
        if (!item || !eligible.has(String(item.id)) || item.liquidation === true || item.liquidation_skip) return item;
        const habitual = Number(item.original_price) > 0 ? Number(item.original_price) : Number(item.price);
        const result = liquidationPrice(habitual);
        if (!result.applied) return { ...item, liquidation_skip: result.reason };
        // Si ya rige otra promo con mejor precio (p. ej. Amado Week), gana la mejor: no se acumulan
        // ni se pisan, y el precio nunca sube.
        const current = Number(item.price);
        const price = Number.isFinite(current) && current > 0 ? Math.min(current, result.price) : result.price;
        return { ...item, price, original_price: habitual, liquidation: true };
    });
}

export function applyLiquidationToCatalog(catalog, options = {}) {
    if (!catalog || !Array.isArray(catalog.items)) return catalog;
    const items = applyLiquidationPrices(catalog.items, options);
    return items === catalog.items ? catalog : { ...catalog, items };
}
