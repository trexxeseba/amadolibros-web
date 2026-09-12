// El orden cronológico usa la fecha de publicación del catálogo, no el año
// de edición del libro. Los productos sin fecha/precio van al final.
export const CATEGORY_ORDER_OPTIONS = [
    ['mezclados', 'Disponibles y por encargo'],
    ['recientes', 'Más nuevos'],
    ['antiguos', 'Más antiguos'],
    ['precio-desc', 'Mayor precio'],
    ['precio-asc', 'Menor precio'],
];

export function parseCategoryOrder(value) {
    return CATEGORY_ORDER_OPTIONS.some(([key]) => key === value) ? value : 'mezclados';
}

export function orderCategoryItems(items, order) {
    if (order === 'mezclados') {
        // Orden estable por título dentro de cada estado, intercalado antes de paginar.
        const byTitle = (a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'es')
            || String(a.id).localeCompare(String(b.id));
        const available = items.filter(item => item.status !== 'paused').sort(byTitle);
        const byRequest = items.filter(item => item.status === 'paused').sort(byTitle);
        const mixed = [];
        for (let i = 0; i < Math.max(available.length, byRequest.length); i++) {
            if (available[i]) mixed.push(available[i]);
            if (byRequest[i]) mixed.push(byRequest[i]);
        }
        return mixed;
    }
    const direction = order === 'antiguos' || order === 'precio-asc' ? 1 : -1;
    const priceOrder = order.startsWith('precio-');
    const value = item => {
        const result = priceOrder ? Number(item.price) : Date.parse(item.start_time || '');
        return Number.isFinite(result) && result > 0 ? result : null;
    };
    return [...items].sort((a, b) => {
        const av = value(a), bv = value(b);
        if (av === null && bv !== null) return 1;
        if (bv === null && av !== null) return -1;
        return (av !== null && bv !== null ? direction * (av - bv) : 0)
            || String(a.id).localeCompare(String(b.id));
    });
}

export function categoryOrderHtml(categoryId, selected) {
    const options = CATEGORY_ORDER_OPTIONS.map(([value, label]) =>
        `<option value="${value}"${value === selected ? ' selected' : ''}>${label}</option>`).join('');
    return `<form class="category-order" action="/libros/${categoryId}" method="get">
      <label for="category-order">Ordenar por</label>
      <select id="category-order" name="orden">${options}</select>
      <button type="submit">Ordenar</button>
    </form>`;
}

export const CATEGORY_ORDER_STYLES = `.category-order{display:flex;flex-wrap:wrap;align-items:center;gap:.6rem;margin:1.2rem 0}.category-decks-link{display:inline-flex;align-items:center;min-height:44px;padding:.35rem 0;color:#8f493b;font-size:.85rem;font-weight:700;text-underline-offset:.2em}.category-order label{font-size:.88rem;font-weight:700}.category-order select,.category-order button{min-height:44px;border:1px solid #ded6ca;border-radius:.55rem;padding:.6rem .8rem;font:inherit;font-size:.9rem}.category-order select{min-width:0;flex:1;max-width:280px;background:#fff;color:#18120e}.category-order button{background:#18120e;color:#fff;cursor:pointer}.category-main.is-simple .intro{padding:1.1rem 1.25rem}.category-main.is-simple .category-scope{margin-top:.55rem}.category-main.is-simple .results-head{margin:1rem 0}.book-image img{min-width:0;min-height:0}@media(max-width:420px){.category-order label{flex-basis:100%}}`;


export function categoryProductTabsHtml(category) {
    const decks = category.tarotFilter === 'verified-decks';
    return `<nav class="category-product-tabs" aria-label="Tipo de producto">
      <a href="/libros/esoterismo-tarot"${decks ? ' aria-current="page"' : ''}>Tarot y oráculos</a>
      <a href="/libros/esoterismo-tarot/libros-esoterismo"${decks ? '' : ' aria-current="page"'}>Libros</a>
    </nav>`;
}

export const CATEGORY_PRODUCT_STYLES = `.category-product-tabs{display:flex;gap:.5rem;margin:1rem 0 .6rem}.category-product-tabs a{display:flex;align-items:center;justify-content:center;min-height:44px;min-width:0;flex:1;padding:.6rem .8rem;border:1px solid #d8cfc2;border-radius:.6rem;background:#fff;font-weight:700;text-decoration:none}.category-product-tabs a[aria-current]{background:#18120e;color:#fff;border-color:#18120e}.category-product-tabs a:focus-visible{outline:3px solid #a94e3d;outline-offset:2px}.stock-badge.by-request{background:#f7ebd6;color:#775117;text-transform:none}.book-order-note{font-size:.75rem;color:#6b6157}`;
