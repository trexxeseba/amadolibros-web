/**
 * functions/_shared/catalog-search.js
 *
 * Búsqueda de texto sobre el índice del catálogo. La usa /catalogo y queda
 * disponible para cualquier otra pieza que necesite encontrar libros reales
 * por título, autor o ISBN, sin repetir las reglas.
 *
 * Dos pasadas:
 *   1. Estricta: todas las palabras de la consulta están en título o autor
 *      (palabra entera o comienzo de palabra), o el ISBN contiene los dígitos.
 *   2. Tolerante: SOLO si la estricta no encontró nada. Admite una letra de
 *      diferencia por palabra y las iniciales escritas juntas o separadas
 *      («TS Eliot» / «T. S. Eliot»). Está acotada para no devolver resultados
 *      absurdos: ver tolerantMatches.
 *
 * Una coincidencia tolerante es una sugerencia, no una identificación: quien
 * la muestre tiene que tratarla como «puede ser este» (usedFuzzy = true).
 */

export function normalizeText(value = '') {
    return String(value)
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .trim();
}

export function tokenize(value = '') {
    return normalizeText(value).split(/[^a-z0-9]+/).filter(Boolean);
}

export function onlyDigits(value = '') {
    return String(value).replace(/\D/g, '');
}

// Palabras de título y autor de cada libro, calculadas una sola vez por objeto:
// la pasada tolerante vuelve a recorrer todo el catálogo y no tiene por qué
// repetir el trabajo de la estricta.
const itemTokenCache = new WeakMap();
function itemTokens(book) {
    let cached = itemTokenCache.get(book);
    if (!cached) {
        cached = { title: tokenize(book.title), author: tokenize(book.author) };
        itemTokenCache.set(book, cached);
    }
    return cached;
}

function tokenMatches(queryToken, itemTokens) {
    return itemTokens.some(t => t === queryToken || t.startsWith(queryToken));
}

export function itemMatchesQuery(book, queryTokens, queryDigits) {
    const { title, author } = itemTokens(book);
    const textMatch = queryTokens.length > 0
        ? queryTokens.every(qt => tokenMatches(qt, title) || tokenMatches(qt, author))
        : false;

    const isbnMatch = queryDigits.length >= 3
        ? onlyDigits(String(book.isbn ?? '')).includes(queryDigits)
        : false;

    return textMatch || isbnMatch;
}

// ── Orden de relevancia (CF-CATEGORÍAS-2C punto 5) ─────────────────────────
// Rangos, de más a menos relevante. Todo lo que entra al resultado ya pasó
// itemMatchesQuery (o no hay q) — esto solo decide el ORDEN entre lo que ya
// matcheó, nunca agrega resultados nuevos.
export const RANK = {
    ISBN_EXACT: 1,
    TITLE_EXACT: 2,
    TITLE_STARTS_WITH: 3,
    TITLE_PHRASE: 4,
    AUTHOR_EXACT: 5,
    ALL_WORDS_EXACT: 6,
    PARTIAL: 7,
    FUZZY: 8,
};

export function relevanceRank(book, ctx) {
    const { normalizedQuery, queryTokens, queryDigits } = ctx;
    if (!normalizedQuery) return RANK.PARTIAL;
    const normTitle = normalizeText(book.title);
    const normAuthor = normalizeText(book.author);
    if (queryDigits.length >= 3 && onlyDigits(String(book.isbn ?? '')) === queryDigits) return RANK.ISBN_EXACT;
    if (normTitle === normalizedQuery) return RANK.TITLE_EXACT;
    if (normTitle.startsWith(normalizedQuery)) return RANK.TITLE_STARTS_WITH;
    if (normTitle.includes(normalizedQuery)) return RANK.TITLE_PHRASE;
    if (normAuthor === normalizedQuery) return RANK.AUTHOR_EXACT;
    const titleWords = tokenize(book.title);
    if (queryTokens.length > 0 && queryTokens.every(qt => titleWords.includes(qt))) return RANK.ALL_WORDS_EXACT;
    return RANK.PARTIAL;
}

/** Distancia de edición <= 1 (una letra cambiada, de más o de menos). */
export function levenshteinAtMost1(a, b) {
    if (a === b) return true;
    const la = a.length, lb = b.length;
    if (Math.abs(la - lb) > 1) return false;
    let i = 0, j = 0, edits = 0;
    while (i < la && j < lb) {
        if (a[i] === b[j]) { i++; j++; continue; }
        edits++;
        if (edits > 1) return false;
        if (la === lb) { i++; j++; } // sustitución
        else if (la > lb) i++; // borrado en a
        else j++; // inserción en a
    }
    if (i < la || j < lb) edits++;
    return edits <= 1;
}

/**
 * Junta las iniciales sueltas seguidas: ['t','s','eliot'] → ['ts','eliot'].
 * Devuelve la misma lista si no hay nada que juntar.
 */
export function joinInitials(tokens) {
    const out = [];
    let run = '';
    for (const token of tokens) {
        if (token.length === 1 && /[a-z]/.test(token)) { run += token; continue; }
        if (run) { out.push(run); run = ''; }
        out.push(token);
    }
    if (run) out.push(run);
    return out;
}

function sameTokens(a, b) {
    return a.length === b.length && a.every((t, i) => t === b[i]);
}

function tolerantTokensMatch(queryTokens, itemTokens) {
    const single = queryTokens.length === 1;
    // Una sola palabra: 4 letras o más, como siempre. En una consulta de varias
    // palabras las demás ya acotan el resultado, así que alcanza con 3 («azl»).
    const minQueryLength = single ? 4 : 3;
    const maxFuzzy = queryTokens.length > 3 ? 2 : 1;
    let fuzzy = 0;
    let anchors = 0;
    for (const qt of queryTokens) {
        if (tokenMatches(qt, itemTokens)) { if (qt.length >= 3) anchors++; continue; }
        const near = qt.length >= minQueryLength
            && itemTokens.some(w => w.length >= 4 && levenshteinAtMost1(qt, w));
        if (!near) return false;
        fuzzy++;
        if (fuzzy > maxFuzzy) return false;
    }
    // Con varias palabras, al menos una de 3 letras o más tiene que coincidir
    // sin tolerancia: una inicial suelta coincide con el comienzo de cualquier
    // palabra y no alcanza para sostener el resultado.
    return single || anchors > 0;
}

/**
 * Coincidencia tolerante, para usar solo cuando la estricta no encontró nada.
 * Compara contra palabras de título y autor; las iniciales cuentan juntas o
 * separadas de los dos lados.
 */
export function tolerantMatches(book, queryTokens) {
    if (queryTokens.length === 0) return false;
    if (queryTokens.length === 1 && queryTokens[0].length < 4) return false;
    const { title: titleTokens, author: authorTokens } = itemTokens(book);
    const allTokens = [
        ...titleTokens, ...authorTokens,
        ...joinInitials(titleTokens), ...joinInitials(authorTokens),
    ];
    if (tolerantTokensMatch(queryTokens, allTokens)) return true;
    const joinedQuery = joinInitials(queryTokens);
    if (sameTokens(joinedQuery, queryTokens)) return false;
    if (joinedQuery.length === 1 && joinedQuery[0].length < 4) return false;
    return tolerantTokensMatch(joinedQuery, allTokens);
}

/** Contexto de una consulta: se calcula una vez y se reutiliza para ordenar. */
export function buildQueryContext(rawQuery = '') {
    const raw = String(rawQuery ?? '');
    return {
        normalizedQuery: normalizeText(raw),
        queryTokens: tokenize(raw),
        // Solo interpretar la consulta como ISBN cuando contiene únicamente
        // números y separadores habituales. Una búsqueda alfanumérica como
        // "zzzinexistente999" no debe coincidir con ISBN que contengan 999.
        queryDigits: /^[\d\s-]+$/.test(raw.trim()) ? onlyDigits(raw) : '',
    };
}

/**
 * Filtra `items` por la consulta. Sin consulta devuelve todo. No ordena ni
 * deduplica: eso depende de quién muestre el resultado.
 * @returns {{ matches: object[], usedFuzzy: boolean, context: object }}
 */
export function matchCatalogQuery(items, rawQuery = '') {
    const context = buildQueryContext(rawQuery);
    if (!String(rawQuery ?? '').trim()) return { matches: items, usedFuzzy: false, context };
    const { queryTokens, queryDigits } = context;
    const strict = items.filter(b => itemMatchesQuery(b, queryTokens, queryDigits));
    if (strict.length > 0 || queryTokens.length === 0) return { matches: strict, usedFuzzy: false, context };
    const tolerant = items.filter(b => tolerantMatches(b, queryTokens));
    return { matches: tolerant, usedFuzzy: tolerant.length > 0, context };
}
