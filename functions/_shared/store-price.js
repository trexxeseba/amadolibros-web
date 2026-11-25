/** Public UYU prices follow the existing checkout rounding rule. Raw supplier
 * data stays untouched for reconciliation and internal margin calculations. */
export function normalizeStorePrices(items) {
    if (!Array.isArray(items)) return items;
    return items.map(item => {
        if (!item || typeof item !== 'object') return item;
        const currency = String(item.currency || item.currency_id || 'UYU').trim().toUpperCase();
        if (currency !== 'UYU') return item;
        const price = Number(item.price);
        if (!Number.isFinite(price) || price <= 0) return item;
        const rounded = Math.round(price);
        const original = Number(item.original_price);
        const habitual = Number.isFinite(original) && original > 0 ? Math.round(original) : item.original_price;
        if (rounded === item.price && habitual === item.original_price) return item;
        return { ...item, price: rounded, ...(item.original_price !== undefined ? { original_price: habitual } : {}) };
    });
}

export function normalizeStoreCatalog(catalog) {
    return catalog && Array.isArray(catalog.items) ? { ...catalog, items: normalizeStorePrices(catalog.items) } : catalog;
}
