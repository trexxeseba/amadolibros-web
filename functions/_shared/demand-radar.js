/**
 * functions/_shared/demand-radar.js
 *
 * GW1 (Radar de Demanda No Satisfecha) + GW2 (Kit de Lista de Lectura).
 *
 * GW1 llena un vacío real, no una funcionalidad nueva de cara al cliente:
 * la recuperación de búsquedas sin resultado YA EXISTE (el CTA de WhatsApp
 * en functions/catalogo.js y la página /pedir-libro), pero esa página dice
 * explícitamente "Este formulario no guarda datos en la web" — hoy, cada
 * búsqueda sin resultado se pierde apenas el visitante cierra la pestaña.
 * Este módulo agrega la única pieza que faltaba: un registro agregado y
 * consultable de qué se busca y no se encuentra, para decidir qué conseguir
 * a continuación. No toca la promesa de privacidad de /pedir-libro (ese
 * formulario sigue sin loguear nada) — sólo persiste el TEXTO de búsqueda
 * público de /catalogo?q= (búsqueda explícita) y de la lista de GW2, nunca
 * datos personales del formulario.
 *
 * Fuentes registradas: sólo 'catalogo_search' y 'reading_list' — el
 * autocompletado NO alimenta este ledger (capturaría fragmentos mientras la
 * persona todavía está tipeando, antes de decidir qué buscar de verdad;
 * sería ruido, no demanda real).
 *
 * GW2 reutiliza el mismo catálogo activo+pausado ya cargado en cada
 * request (fetchActiveIndex/fetchPausedIndex, sin fetch adicional) para
 * responder, línea por línea de una lista de títulos, si Amado lo tiene
 * ahora, si lo puede conseguir por encargo, o si no lo identifica — nunca
 * inventa una coincidencia dudosa, y si dos obras distintas quedan
 * indistinguibles, devuelve 'needs_confirmation' en vez de una afirmación
 * falsa.
 */

function normalizeQuery(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

// ---------------------------------------------------------------------------
// Persistencia — GW1
// ---------------------------------------------------------------------------

// La clave es (normalized_query, source): la MISMA palabra buscada en
// /catalogo?q= y pegada en una lista son señales de calidad distinta y no
// deben pisarse — mezclarlas en una sola fila destruiría la atribución de
// origen que el negocio necesita para decidir qué canal está generando la
// demanda.
const UNMATCHED_QUERIES_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS demand_radar_unmatched_queries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  normalized_query TEXT NOT NULL,
  raw_query TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('catalogo_search','reading_list')),
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE (normalized_query, source)
)`;

const previewSchemaPromises = new WeakMap();

/**
 * Crea la tabla si no existe — sólo necesario en Preview (producción la
 * recibe vía migrations/, aplicada por deploy.yml). Memoizado por
 * instancia de DB para no repetir el CREATE TABLE en cada request.
 */
export async function ensureDemandRadarSchema(db) {
    if (!db) return;
    let pending = previewSchemaPromises.get(db);
    if (!pending) {
        pending = db.prepare(UNMATCHED_QUERIES_TABLE_SQL).bind().run();
        previewSchemaPromises.set(db, pending);
        try {
            await pending;
        } catch (error) {
            previewSchemaPromises.delete(db);
            throw error;
        }
    } else {
        await pending;
    }
}

const MAX_QUERY_LENGTH = 200;
const MIN_QUERY_LENGTH = 2;
const VALID_SOURCES = ['catalogo_search', 'reading_list'];

const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const URL_RE = /https?:\/\/|www\./i;

/**
 * GW2: 'reading_list' es texto libre que la persona pega tal cual — a
 * diferencia de /catalogo?q=, puede traer un mail, un teléfono o una URL
 * sin que lo piense como "una búsqueda". Esto sólo afecta si la línea se
 * persiste en el ledger agregado; la respuesta que ve la persona
 * (matchCatalogLine) nunca depende de esto. Un ISBN real (10 o 13 dígitos,
 * el mismo shape que ya usa matchCatalogLine) se preserva a propósito: es
 * una señal de demanda válida, no un teléfono.
 */
function looksLikePersonalData(raw) {
    if (EMAIL_RE.test(raw)) return true;
    if (URL_RE.test(raw)) return true;
    const digitsOnly = raw.replace(/[^\d]/g, '');
    const nonSpaceLength = raw.replace(/\s/g, '').length;
    const mostlyDigits = digitsOnly.length >= 7 && nonSpaceLength > 0 &&
        (digitsOnly.length / nonSpaceLength) > 0.7;
    if (!mostlyDigits) return false;
    const isIsbnShaped = digitsOnly.length === 10 || digitsOnly.length === 13;
    return !isIsbnShaped;
}

/**
 * Registra (o incrementa) una búsqueda sin resultado. Deliberadamente
 * "best effort": un fallo acá NUNCA debe romper la respuesta al usuario —
 * quien llama a esta función es responsable de invocarla de forma que no
 * bloquee ni pueda tirar abajo el request (ver uso con ctx.waitUntil en
 * catalogo.js / list-lookup.js).
 */
export async function recordUnmatchedQuery(db, { rawQuery, source, appEnv } = {}) {
    if (!db) return;
    const raw = String(rawQuery || '').trim().slice(0, MAX_QUERY_LENGTH);
    const normalized = normalizeQuery(raw);
    if (normalized.length < MIN_QUERY_LENGTH) return;
    if (!VALID_SOURCES.includes(source)) return;
    if (source === 'reading_list' && looksLikePersonalData(raw)) return;

    if (appEnv === 'preview') await ensureDemandRadarSchema(db);

    const now = new Date().toISOString();
    await db.prepare(`
    INSERT INTO demand_radar_unmatched_queries
      (normalized_query, raw_query, source, occurrence_count, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, 1, ?, ?)
    ON CONFLICT(normalized_query, source) DO UPDATE SET
      occurrence_count = occurrence_count + 1,
      raw_query = excluded.raw_query,
      last_seen_at = excluded.last_seen_at
  `).bind(normalized, raw, source, now, now).run();
}

// ---------------------------------------------------------------------------
// Matching de lista — GW2
// ---------------------------------------------------------------------------

const ISBN_LIKE_RE = /^[\d\s-]{8,}$/;

function tokenize(value) {
    return normalizeQuery(value).split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Pre-tokeniza el catálogo (activo + pausado) UNA vez por request, no una
 * vez por línea. Con hasta 40 líneas por lista, tokenizar cada título de
 * cada candidato en cada línea multiplica trabajo innecesario — acá se
 * arma la estructura una sola vez y matchCatalogLine la reutiliza para
 * todas las líneas de la misma solicitud.
 */
export function prepareCatalogCandidates({ activeItems = [], pausedItems = [] } = {}) {
    const prepareOne = (item, status) => {
        const titleTokens = tokenize(item.title);
        const authorTokens = tokenize(item.author);
        return {
            item,
            status,
            titleTokens,
            titleTokenSet: new Set(titleTokens),
            authorTokens,
            authorTokenSet: new Set(authorTokens),
            isbnDigits: String(item.isbn || '').replace(/\D/g, ''),
        };
    };
    return [
        ...activeItems.map(item => prepareOne(item, 'matched_active')),
        ...pausedItems.map(item => prepareOne(item, 'matched_by_encargo')),
    ];
}

/**
 * Sólo cuenta como match cuando hay evidencia real: ISBN exacto, o
 * superposición fuerte de tokens del título. El autor, cuando está en la
 * consulta, REFUERZA una coincidencia de título real (agregar "Gabriel
 * García Márquez" a "Cien años de soledad" nunca debe empeorar la
 * cobertura) pero nunca la SUSTITUYE — una consulta que sólo trae el autor
 * correcto pero ningún token real del título sigue sin matchear, porque
 * un autor prolífico tiene muchos libros y "sólo el autor" es ambiguo por
 * definición. Un resultado ambiguo se descarta acá y se resuelve más
 * arriba (matchCatalogLine): 'no_match'/'needs_confirmation' siempre es
 * preferible a una coincidencia inventada.
 */
function scoreCandidate(candidate, queryTokens, queryDigits) {
    if (queryDigits && candidate.isbnDigits && queryDigits.length >= 10 && queryDigits === candidate.isbnDigits) {
        return { score: 100, reason: 'isbn' };
    }
    if (queryTokens.length === 0 || candidate.titleTokens.length === 0) return { score: 0, reason: null };

    const titleOverlap = queryTokens.filter(t => candidate.titleTokenSet.has(t)).length;
    // Tokens que sólo el autor explica (ya contados por el título no se
    // recuentan) — es lo que permite que agregar el autor correcto sume en
    // vez de diluir la cobertura.
    const authorOnlyOverlap = queryTokens.filter(t =>
        !candidate.titleTokenSet.has(t) && candidate.authorTokenSet.has(t)).length;
    const coveredCount = titleOverlap + authorOnlyOverlap;
    const coverage = coveredCount / queryTokens.length;

    // Exige que el TÍTULO por sí solo aporte una base real — el autor sólo
    // completa cobertura, nunca la reemplaza.
    if (coverage < 0.8 || titleOverlap < Math.min(2, candidate.titleTokens.length)) {
        return { score: 0, reason: null };
    }
    // La precisión combina dos cosas: cuánto de la CONSULTA explica este
    // candidato (coverage) y cuánto del TÍTULO del candidato usa la
    // consulta (titlePrecision). Sin lo segundo, "Eva Luna" y "Eva Luna
    // Historias De Mujeres" puntuarían igual para la búsqueda "eva luna" —
    // el primero es un match mucho más exacto y debe ganar el ranking, no
    // sólo empatar por casualidad de orden. El autor, cuando refuerza, suma
    // un empujón menor — nunca decide por sí solo (ver el gate de arriba).
    const titlePrecision = titleOverlap / candidate.titleTokens.length;
    return {
        score: coverage + titlePrecision + (authorOnlyOverlap > 0 ? 0.01 : 0),
        reason: authorOnlyOverlap > 0 ? 'title+author' : 'title',
    };
}

function toResult(raw, best) {
    const item = best.item;
    return {
        query: raw,
        status: best.status,
        match: {
            id: item.id,
            title: item.title,
            author: item.author || null,
            price: best.status === 'matched_active' ? Number(item.price) || 0 : null,
            stock: best.status === 'matched_active' ? Number(item.available_quantity) || 0 : null,
        },
    };
}

/**
 * Intenta matchear una línea de texto libre contra el catálogo ya
 * preparado por prepareCatalogCandidates(). Activo y pausado se rankean
 * JUNTOS por precisión — el estado comercial sólo desempata cuando la
 * precisión es idéntica, nunca antes: un activo mediocre no debe tapar un
 * por-encargo mucho más exacto. Si tras desempatar por estado comercial
 * siguen empatadas dos OBRAS DISTINTAS, es ambigüedad real: se devuelve
 * 'needs_confirmation' en vez de afirmar "tenemos X" siendo en realidad
 * otro libro.
 */
export function matchCatalogLine(rawLine, preparedCandidates = []) {
    const raw = String(rawLine || '').trim();
    if (!raw) return null;
    const queryTokens = tokenize(raw);
    const queryDigits = ISBN_LIKE_RE.test(raw) ? raw.replace(/\D/g, '') : '';

    const scored = [];
    for (const candidate of preparedCandidates) {
        const { score, reason } = scoreCandidate(candidate, queryTokens, queryDigits);
        if (score > 0) scored.push({ ...candidate, score, reason });
    }

    if (scored.length === 0) {
        return { query: raw, status: 'no_match', match: null };
    }

    const maxScore = Math.max(...scored.map(c => c.score));
    const top = scored.filter(c => c.score === maxScore);
    if (top.length === 1) return toResult(raw, top[0]);

    const topActive = top.filter(c => c.status === 'matched_active');
    if (topActive.length === 1) return toResult(raw, topActive[0]);

    const winners = topActive.length > 1 ? topActive : top;
    const uniqueById = [];
    const seenIds = new Set();
    for (const c of winners) {
        if (seenIds.has(c.item.id)) continue;
        seenIds.add(c.item.id);
        uniqueById.push(c);
    }
    if (uniqueById.length === 1) return toResult(raw, uniqueById[0]);

    return {
        query: raw,
        status: 'needs_confirmation',
        match: null,
        candidates: uniqueById.map(c => ({
            id: c.item.id,
            title: c.item.title,
            author: c.item.author || null,
        })),
    };
}

export { normalizeQuery };
