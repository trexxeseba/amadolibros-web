/**
 * Regalos de Navidad: qué libros entran en /regalos.
 *
 * La lista vive en data/regalos.json (ids MLU elegidos con criterio de regalo:
 * packs, estuches, ilustrados, cómics, clásicos en tapa dura, mazos). Entra lo
 * que está en la lista, activo y con stock: lo que se agota sale solo, sin
 * tocar nada. Los precios son los del catálogo vigente, iguales a los de la
 * ficha y el carrito; esta página no inventa descuentos.
 *
 * Fechas de entrega para Navidad (Seba, 21/11/2026): pedidos en Montevideo
 * hasta el 23/12 y en el interior hasta el 18/12. Pasada la Navidad la página
 * sigue como vitrina de regalos, sin fechas.
 */
import REGALOS_DATA from './regalos-data.js';

export const REGALOS = Object.freeze({
    name: 'Regalos que se recuerdan',
    path: '/regalos',
    minPrice: 2500,
    navidad: Object.freeze({
        year: 2026,
        montevideoHasta: '2026-12-23',
        interiorHasta: '2026-12-18',
        fin: '2026-12-25',
    }),
});

/** Grupos de la vitrina, en el orden en que se muestran. */
export const REGALOS_GROUPS = Object.freeze([
    { id: 'literatura', name: 'Para quien lee todo', categories: ['literatura-ficcion', 'filosofia-ciencias-sociales', 'historia'] },
    { id: 'arte', name: 'Para quien ama el arte y la música', categories: ['arte-diseno-fotografia'] },
    { id: 'comics', name: 'Cómics y novela gráfica', categories: ['comics-manga'] },
    { id: 'infantil', name: 'Para los más chicos', categories: ['infantil-juvenil'] },
    { id: 'cocina', name: 'Para la mesa y el vino', categories: ['cocina-gastronomia'] },
    { id: 'tarot', name: 'Tarot y oráculos', categories: ['esoterismo-tarot', 'religion-espiritualidad'] },
]);

const LIST = new Set(Array.isArray(REGALOS_DATA?.lista?.ids) ? REGALOS_DATA.lista.ids.map(String) : []);

export function regalosListIds() {
    return [...LIST];
}

function isStocked(item) {
    return item?.status === 'active' && Number(item?.available_quantity) > 0 && Number(item?.price) > 0;
}

/** Lista de regalos presente en el catálogo, activa y con stock. */
export function selectRegalos(items, list = LIST) {
    if (!Array.isArray(items)) return [];
    const seen = new Set();
    return items.filter(item => {
        const id = String(item?.id ?? '');
        if (!list.has(id) || seen.has(id) || !isStocked(item)) return false;
        seen.add(id);
        return true;
    });
}

/** Grupo de la vitrina para una categoría del sitio; null si no entra en ninguno. */
export function groupForCategory(categoryId) {
    if (!categoryId) return null;
    return REGALOS_GROUPS.find(g => g.categories.includes(categoryId)) || null;
}

/**
 * Agrupa los libros seleccionados por grupo de la vitrina. `categoryOf(id)`
 * devuelve la categoría principal del sitio. Lo que no cae en ningún grupo va
 * a "Más ideas". Dentro de cada grupo, de mayor a menor precio.
 */
export function groupRegalos(selected, categoryOf) {
    const buckets = new Map(REGALOS_GROUPS.map(g => [g.id, []]));
    const rest = [];
    for (const item of selected) {
        const group = groupForCategory(categoryOf(item.id));
        if (group) buckets.get(group.id).push(item);
        else rest.push(item);
    }
    const byPrice = (a, b) => Number(b.price) - Number(a.price) || String(a.title).localeCompare(String(b.title), 'es');
    const out = REGALOS_GROUPS
        .map(g => ({ id: g.id, name: g.name, items: buckets.get(g.id).sort(byPrice) }))
        .filter(g => g.items.length > 0);
    if (rest.length) out.push({ id: 'mas', name: 'Más ideas', items: rest.sort(byPrice) });
    return out;
}

const DAY_MS = 86400000;

function parseDay(iso) {
    // Fin del día en Uruguay (UTC-3).
    return Date.parse(`${iso}T23:59:59-03:00`);
}

/**
 * Estado de la promesa de entrega navideña en un instante dado.
 * - 'ambas': se pueden prometer Montevideo e interior;
 * - 'montevideo': pasó la fecha del interior, sigue Montevideo;
 * - 'ninguna': pasó Navidad (o pasaron las dos fechas).
 */
export function navidadEstado(now = Date.now(), cfg = REGALOS.navidad) {
    if (now > parseDay(cfg.fin) || now > parseDay(cfg.montevideoHasta)) return 'ninguna';
    if (now > parseDay(cfg.interiorHasta)) return 'montevideo';
    return 'ambas';
}

/** Días completos que faltan para una fecha ISO (0 si es hoy, negativo si pasó). */
export function diasHasta(iso, now = Date.now()) {
    return Math.ceil((parseDay(iso) - now) / DAY_MS) - 1;
}

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

export function fechaLarga(iso) {
    const [, m, d] = iso.split('-').map(Number);
    return `${d} de ${MESES[m - 1]}`;
}
