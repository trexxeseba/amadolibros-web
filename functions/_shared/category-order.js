// El orden cronológico usa la fecha de publicación del catálogo, no el año
// de edición del libro. Los productos sin fecha/precio van al final.
export const CATEGORY_ORDER_OPTIONS = [
    ['recientes', 'Más nuevos'],
    ['antiguos', 'Más antiguos'],
    ['precio-desc', 'Mayor precio'],
    ['precio-asc', 'Menor precio'],
];

export function parseCategoryOrder(value) {
    return CATEGORY_ORDER_OPTIONS.some(([key]) => key === value) ? value : 'recientes';
}

export function orderCategoryItems(items, order) {
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

export const CATEGORY_ORDER_STYLES = `.category-order{display:flex;flex-wrap:wrap;align-items:center;gap:.6rem;margin:1.2rem 0}.category-order label{font-size:.88rem;font-weight:700}.category-order select,.category-order button{min-height:44px;border:1px solid #ded6ca;border-radius:.55rem;padding:.6rem .8rem;font:inherit;font-size:.9rem}.category-order select{min-width:0;flex:1;max-width:280px;background:#fff;color:#18120e}.category-order button{background:#18120e;color:#fff;cursor:pointer}.category-main.is-simple .intro{padding:1.1rem 1.25rem}.category-main.is-simple .category-scope{margin-top:.55rem}.category-main.is-simple .results-head{margin:1rem 0}.book-image img{min-width:0;min-height:0}@media(max-width:420px){.category-order label{flex-basis:100%}}`;
