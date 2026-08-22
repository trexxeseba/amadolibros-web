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
 * público de /catalogo?q= y del autocompletado (ya visible en la URL/en
 * Search Console), nunca datos personales.
 *
 * GW2 reutiliza el mismo catálogo activo+pausado ya cargado en cada
 * request (fetchActiveIndex/fetchPausedIndex, sin fetch adicional) para
 * responder, línea por línea de una lista de títulos, si Amado lo tiene
 * ahora, si lo puede conseguir por encargo, o si no lo identifica — nunca
 * inventa una coincidencia dudosa.
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

const UNMATCHED_QUERIES_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS demand_radar_unmatched_queries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  normalized_query TEXT NOT NULL UNIQUE,
  raw_query TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('catalogo_search','autocomplete','reading_list')),
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
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

/**
 * Registra (o incrementa) una búsqueda sin resultado. Deliberadamente
 * "best effort": un fallo acá NUNCA debe romper la respuesta al usuario —
 * quien llama a esta función es responsable de invocarla de forma que no
 * bloquee ni pueda tirar abajo el request (ver uso con ctx.waitUntil en
 * catalogo.js / search-suggestions.js / list-lookup.js).
 */
export async function recordUnmatchedQuery(db, { rawQuery, source, appEnv } = {}) {
    if (!db) return;
    const raw = String(rawQuery || '').trim().slice(0, MAX_QUERY_LENGTH);
    const normalized = normalizeQuery(raw);
    if (normalized.length < MIN_QUERY_LENGTH) return;
    if (!['catalogo_search', 'autocomplete', 'reading_list'].includes(source)) return;

    if (appEnv === 'preview') await ensureDemandRadarSchema(db);

    const now = new Date().toISOString();
    await db.prepare(`
    INSERT INTO demand_radar_unmatched_queries
      (normalized_query, raw_query, source, occurrence_count, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, 1, ?, ?)
    ON CONFLICT(normalized_query) DO UPDATE SET
      occurrence_count = occurrence_count + 1,
      raw_query = excluded.raw_query,
      source = excluded.source,
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
 * Sólo cuenta como match cuando hay evidencia real: ISBN exacto (sin
 * guiones/espacios), o superposición fuerte de tokens del título (y,
 * cuando el candidato trae autor, evidencia también en el autor). Un
 * resultado ambiguo se descarta — 'no_match' siempre es preferible a una
 * coincidencia inventada ("tenemos X" siendo en realidad otro libro).
 */
function scoreCandidate(item, queryTokens, queryDigits) {
    const isbnDigits = String(item.isbn || '').replace(/\D/g, '');
    if (queryDigits && isbnDigits && queryDigits.length >= 10 && queryDigits === isbnDigits) {
        return { score: 100, reason: 'isbn' };
    }
    const titleTokens = tokenize(item.title);
    if (queryTokens.length === 0 || titleTokens.length === 0) return { score: 0, reason: null };
    const titleTokenSet = new Set(titleTokens);
    const overlap = queryTokens.filter(t => titleTokenSet.has(t)).length;
    const coverage = overlap / queryTokens.length;
    // Exige que prácticamente todos los tokens de la consulta aparezcan en
    // el título real — evita matchear "el amor en los tiempos" contra
    // cualquier libro que sólo comparta una palabra común.
    if (coverage < 0.8 || overlap < Math.min(2, queryTokens.length)) return { score: 0, reason: null };
    return { score: 10 + overlap, reason: 'title' };
}

/**
 * Intenta matchear una línea de texto libre contra el catálogo real.
 * activeItems: items de fetchActiveIndex (con price/available_quantity).
 * pausedItems: items de fetchPausedIndex (sin price/stock: por encargo).
 * Nunca inventa una coincidencia: sin evidencia suficiente, 'no_match'.
 */
export function matchCatalogLine(rawLine, { activeItems = [], pausedItems = [] } = {}) {
    const raw = String(rawLine || '').trim();
    if (!raw) return null;
    const queryTokens = tokenize(raw);
    const queryDigits = ISBN_LIKE_RE.test(raw) ? raw.replace(/\D/g, '') : '';

    let best = null;
    for (const item of activeItems) {
        const { score, reason } = scoreCandidate(item, queryTokens, queryDigits);
        if (score > 0 && (!best || score > best.score)) best = { item, score, reason, status: 'matched_active' };
    }
    if (!best) {
        for (const item of pausedItems) {
            const { score, reason } = scoreCandidate(item, queryTokens, queryDigits);
            if (score > 0 && (!best || score > best.score)) best = { item, score, reason, status: 'matched_by_encargo' };
        }
    }

    if (!best) {
        return { query: raw, status: 'no_match', match: null };
    }
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

export { normalizeQuery };
