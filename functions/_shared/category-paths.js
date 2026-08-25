/**
 * Normaliza el artefacto compacto de categorías.
 *
 * V1: items[mlu] = [categoryId, subcategoryId?]
 * V2: items[mlu] = [[categoryId, subcategoryId?], ...]
 *
 * Aceptar ambos formatos permite desplegar código y artefacto sin una
 * ventana en la que el catálogo deje de filtrar.
 */
export function normalizeCategoryPaths(raw) {
    if (!Array.isArray(raw) || raw.length === 0) return [];
    const candidates = Array.isArray(raw[0]) ? raw : [raw];
    const seen = new Set();
    const paths = [];

    for (const candidate of candidates) {
        if (!Array.isArray(candidate)) continue;
        const categoryId = typeof candidate[0] === 'string' ? candidate[0].trim() : '';
        const subcategoryId = typeof candidate[1] === 'string' ? candidate[1].trim() : '';
        if (!categoryId) continue;
        const key = `${categoryId}/${subcategoryId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        paths.push(subcategoryId ? [categoryId, subcategoryId] : [categoryId]);
    }

    return paths;
}

export function matchesCategoryPath(raw, categoryId, subcategoryId = '') {
    return normalizeCategoryPaths(raw).some(path =>
        path[0] === categoryId && (!subcategoryId || path[1] === subcategoryId)
    );
}

export function hasClassificationId(raw, classificationId) {
    return normalizeCategoryPaths(raw).some(path =>
        path[0] === classificationId || path[1] === classificationId
    );
}

export function primaryCategoryPath(raw) {
    return normalizeCategoryPaths(raw)[0] || null;
}
