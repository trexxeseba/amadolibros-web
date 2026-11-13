/**
 * POST /api/librero — asistente «Ayudame a encontrarlo».
 *
 * Aparece cuando una búsqueda del catálogo no da resultados. Esta primera
 * versión no usa IA: busca con reglas, muestra hasta tres títulos reales y
 * arma el pedido para Amado. Guarda lo que pasa (sesión y eventos) y el
 * pedido, con el contacto que la persona quiso dejar.
 *
 * Acciones (campo `action` del JSON):
 *   start    abre la sesión y devuelve candidatos reales del catálogo.
 *   event    registra algo que pasó (click en un libro, «ninguno», se fue).
 *   request  guarda el pedido. Solo con 201 se puede decir «pedido registrado».
 *
 * Los datos de las tarjetas (título, precio, stock, enlace) salen del
 * catálogo en el servidor; el navegador nunca los manda.
 */

import { fetchActiveIndex, fetchPausedIndex } from '../_shared/catalog.js';
import { levenshteinAtMost1, tokenize } from '../_shared/catalog-search.js';
import { deriveBookDisplayTitle } from '../_shared/book-display-title.js';
import { slugify } from '../_shared/slug.js';
import { generateRequestCode } from './_book_request_handler.js';

export const MAX_BODY_BYTES = 8 * 1024;
export const LIMITS = Object.freeze({
    sessionsPerWindow: 6, sessionWindowMinutes: 10,
    requestsPerHour: 3, eventsPerSession: 40, maxCandidates: 3,
});
export const EVENT_TYPES = Object.freeze([
    'candidates_shown', 'candidate_click', 'none_fit', 'answer', 'summary_shown', 'left',
]);
const LANGUAGES = new Set(['Español', 'Inglés', 'Portugués', 'Francés', 'Italiano', 'Cualquiera']);
const URGENCIES = new Set(['sin-apuro', 'este-mes', 'urgente']);
const BOOK_REQUEST_LANGUAGES = new Set(['Español', 'Inglés', 'Portugués', 'Francés', 'Italiano']);
const STOPWORDS = new Set(['el', 'la', 'los', 'las', 'de', 'del', 'un', 'una', 'y', 'en', 'que', 'por', 'con', 'libro', 'libros']);

// Mismas tablas que migrations/0023_librero.sql. Se crean solas en Preview,
// donde las migraciones no se aplican; un test compara ambas definiciones.
export const PREVIEW_SCHEMA = [
    `CREATE TABLE IF NOT EXISTS book_requests (id TEXT PRIMARY KEY, public_code TEXT NOT NULL UNIQUE, request_type TEXT NOT NULL, query TEXT NOT NULL, author_isbn TEXT, format TEXT, language TEXT, budget_uyu INTEGER, details TEXT, source_url TEXT, status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','in_progress','answered','closed')), ip_hash TEXT, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS librero_sessions (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, query TEXT NOT NULL, candidate_ids TEXT, catalog_ok INTEGER NOT NULL DEFAULT 1, outcome TEXT NOT NULL DEFAULT 'open' CHECK (outcome IN ('open','clicked','request','left')), ip_hash TEXT)`,
    `CREATE INDEX IF NOT EXISTS idx_librero_sessions_ip_hash ON librero_sessions (ip_hash, created_at)`,
    `CREATE TABLE IF NOT EXISTS librero_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS librero_requests (id TEXT PRIMARY KEY, public_code TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, query TEXT NOT NULL, accepts_used INTEGER, accepts_other_edition INTEGER, language TEXT, budget_uyu INTEGER, urgency TEXT, notes TEXT, contact_kind TEXT CHECK (contact_kind IS NULL OR contact_kind IN ('whatsapp','email')), contact_value TEXT, contact_preferred_time TEXT, consent_reply INTEGER NOT NULL DEFAULT 0, summary TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','in_progress','answered','closed')), created_at TEXT NOT NULL)`,
];
const previewSchema = new WeakMap();

function json(data, status = 200, extra = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json;charset=UTF-8', 'Cache-Control': 'no-store', ...extra },
    });
}

function text(value, max) {
    const s = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
    return s.length > max ? null : s;
}

async function sha256Hex(value) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function sameOrigin(request) {
    const origin = request.headers.get('Origin');
    if (!origin) return true;
    try { return new URL(origin).host === new URL(request.url).host; } catch { return false; }
}

// ── Candidatos ─────────────────────────────────────────────────────────────

/** Tarjeta pública de un libro. Todo sale del catálogo, nada del navegador. */
export function buildCard(book) {
    const display = deriveBookDisplayTitle(book);
    const available = book.status === 'active' && Number(book.available_quantity) > 0;
    const price = Number(book.price);
    return {
        id: book.id,
        title: display.removedParts.length ? display.title : book.title,
        author: book.author || null,
        available,
        price: available && Number.isFinite(price) && price > 0 ? Math.round(price) : null,
        url: `/libro/${book.id}/${slugify(book.title)}`,
    };
}

/**
 * Libros que PUEDEN ser lo que la persona buscaba. Es una sugerencia, nunca
 * una identificación: la persona confirma. Pide al menos dos coincidencias
 * (una exacta pesa doble que una con una letra de diferencia), y con una sola
 * palabra exige que sea exacta, para no ofrecer libros absurdos.
 */
export function suggestCandidates(items, query, limit = LIMITS.maxCandidates) {
    const tokens = [...new Set(tokenize(query).filter(t => t.length >= 3 && !STOPWORDS.has(t)))];
    if (tokens.length === 0) return [];
    const scored = [];
    for (const book of items) {
        const title = tokenize(book.title);
        const author = tokenize(book.author);
        let score = 0;
        let exact = 0;
        let matched = 0;
        // Una palabra corta mal escrita («azl») solo se corrige si hay otras
        // palabras que sostengan la búsqueda.
        const minFuzzy = tokens.length >= 2 ? 3 : 5;
        for (const token of tokens) {
            const inAuthor = author.some(w => w === token);
            const inTitle = title.some(w => w === token);
            if (inAuthor || inTitle) { score += inAuthor ? 3 : 2; exact++; matched++; continue; }
            if (token.length >= minFuzzy && [...title, ...author].some(w => w.length >= 4 && levenshteinAtMost1(token, w))) {
                score += 1;
                matched++;
            }
        }
        // Con varias palabras, no alcanza con que coincida una sola: «perro» solo
        // trae cualquier libro de perros.
        if (exact === 0 || score < 2 || (tokens.length >= 2 && matched < 2)) continue;
        const available = book.status === 'active' && Number(book.available_quantity) > 0;
        scored.push({ book, score, available });
    }
    scored.sort((a, b) =>
        b.score - a.score || Number(b.available) - Number(a.available) || String(a.book.id).localeCompare(String(b.book.id)));
    const seen = new Set();
    const out = [];
    for (const { book } of scored) {
        const key = `${tokenize(book.title).join(' ')}|${tokenize(book.author).join(' ')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(book);
        if (out.length >= limit) break;
    }
    return out;
}

/**
 * Otros libros del autor del primer candidato (hasta 3, disponibles primero),
 * para «ver más libros de ese autor». Sale del catálogo, nunca del navegador.
 */
export function sameAuthorBooks(items, candidates, limit = LIMITS.maxCandidates) {
    const first = candidates?.[0];
    const authorKey = first?.author ? tokenize(first.author).sort().join(' ') : '';
    if (!authorKey) return null;
    const shown = new Set(candidates.map(c => c.id));
    const seen = new Set();
    const pool = [];
    for (const book of items) {
        if (shown.has(book.id) || tokenize(book.author).sort().join(' ') !== authorKey) continue;
        const key = tokenize(book.title).join(' ');
        if (seen.has(key)) continue;
        seen.add(key);
        pool.push(book);
    }
    pool.sort((a, b) =>
        Number(b.status === 'active' && Number(b.available_quantity) > 0) - Number(a.status === 'active' && Number(a.available_quantity) > 0) ||
        String(a.id).localeCompare(String(b.id)));
    const books = pool.slice(0, limit).map(buildCard);
    return books.length ? { author: first.author, books } : null;
}

async function defaultLoadItems(context) {
    const ctx = {
        env: context.env, request: context.request, data: {},
        waitUntil: typeof context.waitUntil === 'function' ? context.waitUntil.bind(context) : undefined,
    };
    const [active, paused] = await Promise.all([fetchActiveIndex(ctx), fetchPausedIndex(ctx)]);
    const items = [
        ...(Array.isArray(active?.items) ? active.items : []),
        ...(Array.isArray(paused?.items) ? paused.items : []),
    ];
    return items.length ? items : null;
}

// ── Pedido ─────────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Valida el pedido. Devuelve { ok, value } o { ok: false, error }. */
export function validateRequest(body) {
    const sessionId = text(body.session_id, 64);
    const key = text(body.idempotency_key, 80);
    if (!sessionId || !key || key.length < 8) return { ok: false, error: 'Solicitud inválida.' };
    const query = text(body.query, 300);
    if (!query || query.length < 2) return { ok: false, error: 'Contanos qué libro buscás.' };
    const notes = text(body.notes ?? '', 1000);
    const urgencyRaw = text(body.urgency ?? '', 20);
    const languageRaw = text(body.language ?? '', 30);
    const prefTime = text(body.contact_preferred_time ?? '', 80);
    if (notes === null || urgencyRaw === null || languageRaw === null || prefTime === null) {
        return { ok: false, error: 'Algún dato es demasiado largo.' };
    }
    const rawBudget = body.budget_uyu === undefined || body.budget_uyu === null || body.budget_uyu === '' ? null : Number(body.budget_uyu);
    if (rawBudget !== null && (!Number.isFinite(rawBudget) || rawBudget < 0 || rawBudget > 10_000_000)) {
        return { ok: false, error: 'Presupuesto inválido.' };
    }

    let contactKind = null;
    let contactValue = null;
    const kindRaw = text(body.contact_kind ?? '', 20);
    const valueRaw = text(body.contact_value ?? '', 120);
    if (valueRaw === null || kindRaw === null) return { ok: false, error: 'Contacto inválido.' };
    if (valueRaw) {
        if (kindRaw === 'email' && EMAIL_RE.test(valueRaw)) {
            contactKind = 'email';
            contactValue = valueRaw.toLowerCase();
        } else if (kindRaw === 'whatsapp' && /^[+\d][\d\s().-]{6,20}$/.test(valueRaw)) {
            const digits = valueRaw.replace(/\D/g, '');
            if (digits.length < 8 || digits.length > 15) return { ok: false, error: 'El WhatsApp no parece válido.' };
            contactKind = 'whatsapp';
            contactValue = valueRaw.startsWith('+') ? `+${digits}` : digits;
        } else {
            return { ok: false, error: kindRaw === 'email' ? 'El email no parece válido.' : 'El WhatsApp no parece válido.' };
        }
        // El contacto solo se guarda si la persona pidió que le respondamos.
        if (body.consent_reply !== true) return { ok: false, error: 'Para guardar tu contacto necesitamos que nos autorices a responderte.' };
    }
    const flag = value => (value === true ? 1 : value === false ? 0 : null);
    return {
        ok: true,
        value: {
            session_id: sessionId,
            idempotency_key: key,
            query,
            accepts_used: flag(body.accepts_used),
            accepts_other_edition: flag(body.accepts_other_edition),
            language: LANGUAGES.has(languageRaw) ? languageRaw : null,
            budget_uyu: rawBudget === null ? null : Math.round(rawBudget),
            urgency: URGENCIES.has(urgencyRaw) ? urgencyRaw : null,
            notes: notes || null,
            contact_kind: contactKind,
            contact_value: contactValue,
            contact_preferred_time: contactKind ? (prefTime || null) : null,
            consent_reply: contactKind ? 1 : 0,
        },
    };
}

/** Resumen de una línea para quien atiende. Nunca incluye el contacto. */
export function buildSummary(v) {
    const parts = [`Busca: ${v.query}`];
    if (v.accepts_used === 1) parts.push('acepta usado');
    if (v.accepts_used === 0) parts.push('prefiere nuevo');
    if (v.accepts_other_edition === 1) parts.push('acepta otra edición');
    if (v.accepts_other_edition === 0) parts.push('solo esa edición');
    if (v.language) parts.push(`idioma: ${v.language}`);
    if (v.budget_uyu !== null) parts.push(`presupuesto: $${v.budget_uyu} UYU`);
    if (v.urgency) parts.push(`urgencia: ${v.urgency}`);
    if (v.notes) parts.push(`nota: ${v.notes}`);
    return parts.join(' · ');
}

// ── Handler ────────────────────────────────────────────────────────────────

export function createLibreroHandler({
    getNow = () => new Date(),
    random = () => crypto.getRandomValues(new Uint8Array(4)),
    loadItems = defaultLoadItems,
} = {}) {
    async function ensureSchema(db, env) {
        if (String(env?.APP_ENV || '') !== 'preview') return;
        let pending = previewSchema.get(db);
        if (!pending) {
            pending = Promise.all(PREVIEW_SCHEMA.map(sql => db.prepare(sql).bind().run()));
            previewSchema.set(db, pending);
        }
        await pending;
    }

    async function start(db, body, ctx, ipHash, now) {
        const query = text(body.query, 200);
        if (!query || query.length < 2) return json({ error: 'Contanos qué libro buscás.' }, 400);
        const iso = now.toISOString();
        if (ipHash) {
            const since = new Date(now.getTime() - LIMITS.sessionWindowMinutes * 60000).toISOString();
            const row = await db.prepare('SELECT COUNT(*) AS n FROM librero_sessions WHERE ip_hash=? AND created_at>=?')
                .bind(ipHash, since).first();
            if (Number(row?.n) >= LIMITS.sessionsPerWindow) {
                return json({ error: 'Probaste varias veces seguidas. Escribinos por WhatsApp y lo vemos juntos.', code: 'RATE_LIMITED' }, 429);
            }
        }
        let items = null;
        try { items = await loadItems(ctx); } catch { items = null; }
        const catalogOk = Array.isArray(items) && items.length > 0;
        const candidates = catalogOk ? suggestCandidates(items, query).map(buildCard) : [];
        const sessionId = crypto.randomUUID();
        await db.prepare(
            'INSERT INTO librero_sessions (id, created_at, updated_at, query, candidate_ids, catalog_ok, outcome, ip_hash) ' +
            "VALUES (?, ?, ?, ?, ?, ?, 'open', ?)"
        ).bind(sessionId, iso, iso, query, JSON.stringify(candidates.map(c => c.id)), catalogOk ? 1 : 0, ipHash).run();
        return json({
            ok: true, session_id: sessionId, query, catalog_ok: catalogOk, candidates,
            same_author: catalogOk ? sameAuthorBooks(items, candidates) : null,
        }, 201);
    }

    async function event(db, body, now) {
        const sessionId = text(body.session_id, 64);
        const type = text(body.type, 40);
        if (!sessionId || !EVENT_TYPES.includes(type)) return json({ error: 'Evento inválido.' }, 400);
        const payload = text(body.payload ?? '', 300);
        if (payload === null) return json({ error: 'Evento inválido.' }, 400);
        const session = await db.prepare('SELECT id, outcome FROM librero_sessions WHERE id=?').bind(sessionId).first();
        if (!session) return json({ error: 'Sesión desconocida.' }, 404);
        const count = await db.prepare('SELECT COUNT(*) AS n FROM librero_events WHERE session_id=?').bind(sessionId).first();
        if (Number(count?.n) >= LIMITS.eventsPerSession) return json({ ok: true, recorded: false }, 202);
        const iso = now.toISOString();
        await db.prepare('INSERT INTO librero_events (session_id, type, payload, created_at) VALUES (?, ?, ?, ?)')
            .bind(sessionId, type, payload || null, iso).run();
        // El resultado final de la sesión solo avanza: un pedido no se pisa.
        const next = type === 'candidate_click' ? 'clicked' : type === 'left' ? 'left' : null;
        if (next && session.outcome === 'open') {
            await db.prepare('UPDATE librero_sessions SET outcome=?, updated_at=? WHERE id=?').bind(next, iso, sessionId).run();
        }
        return json({ ok: true, recorded: true });
    }

    async function request(db, body, ipHash, now) {
        const parsed = validateRequest(body);
        if (!parsed.ok) return json({ error: parsed.error }, 400);
        const v = parsed.value;
        // Reintento del mismo envío: devuelve el mismo código, no crea otro pedido.
        const previous = await db.prepare('SELECT public_code FROM librero_requests WHERE idempotency_key=?').bind(v.idempotency_key).first();
        if (previous) return json({ ok: true, received: true, request_code: previous.public_code, repeated: true }, 200);
        const session = await db.prepare('SELECT id FROM librero_sessions WHERE id=?').bind(v.session_id).first();
        if (!session) return json({ error: 'Sesión desconocida.' }, 404);
        if (ipHash) {
            const since = new Date(now.getTime() - 3600000).toISOString();
            const row = await db.prepare(
                'SELECT COUNT(*) AS n FROM librero_requests r JOIN librero_sessions s ON s.id=r.session_id WHERE s.ip_hash=? AND r.created_at>=?'
            ).bind(ipHash, since).first();
            if (Number(row?.n) >= LIMITS.requestsPerHour) {
                return json({ error: 'Recibimos varios pedidos seguidos. Escribinos por WhatsApp y lo vemos juntos.', code: 'RATE_LIMITED' }, 429);
            }
        }
        const iso = now.toISOString();
        const summary = buildSummary(v);
        for (let attempt = 0; attempt < 3; attempt++) {
            const code = generateRequestCode(now, random());
            const taken = await db.prepare('SELECT 1 AS n FROM librero_requests WHERE public_code=?').bind(code).first();
            if (taken) continue;
            const insertLibrero = db.prepare(
                'INSERT INTO librero_requests (id, public_code, session_id, idempotency_key, query, accepts_used, accepts_other_edition, ' +
                'language, budget_uyu, urgency, notes, contact_kind, contact_value, contact_preferred_time, consent_reply, summary, status, created_at) ' +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?)"
            ).bind(
                crypto.randomUUID(), code, v.session_id, v.idempotency_key, v.query, v.accepts_used, v.accepts_other_edition,
                v.language, v.budget_uyu, v.urgency, v.notes, v.contact_kind, v.contact_value, v.contact_preferred_time,
                v.consent_reply, summary, iso,
            );
            // Misma fila en book_requests, sin contacto, para el panel y el export de siempre.
            const insertShared = db.prepare(
                'INSERT INTO book_requests (id, public_code, request_type, query, author_isbn, format, language, budget_uyu, details, source_url, status, ip_hash, created_at) ' +
                "VALUES (?, ?, 'sin-resultados', ?, NULL, NULL, ?, ?, ?, NULL, 'received', ?, ?)"
            ).bind(
                crypto.randomUUID(), code, v.query, BOOK_REQUEST_LANGUAGES.has(v.language) ? v.language : null,
                v.budget_uyu, `Asistente: ${summary}`.slice(0, 1000), ipHash, iso,
            );
            const updateSession = db.prepare("UPDATE librero_sessions SET outcome='request', updated_at=? WHERE id=?").bind(iso, v.session_id);
            if (typeof db.batch === 'function') await db.batch([insertLibrero, insertShared, updateSession]);
            else { await insertLibrero.run(); await insertShared.run(); await updateSession.run(); }
            return json({ ok: true, received: true, request_code: code }, 201);
        }
        return json({ error: 'No pudimos registrar el pedido. Intentá de nuevo.' }, 503);
    }

    return async function onRequest(context) {
        const { request: req, env } = context;
        if (req.method !== 'POST') return json({ error: 'Método no permitido.' }, 405, { Allow: 'POST' });
        if (!String(req.headers.get('Content-Type') || '').toLowerCase().startsWith('application/json')) {
            return json({ error: 'Content-Type debe ser application/json.' }, 415);
        }
        if (!sameOrigin(req)) return json({ error: 'Origen no permitido.' }, 403);

        const raw = await req.text();
        if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return json({ error: 'Solicitud demasiado grande.' }, 413);
        let body;
        try { body = JSON.parse(raw); } catch { return json({ error: 'JSON inválido.' }, 400); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Solicitud inválida.' }, 400);

        // Campo trampa: una persona no lo ve ni lo completa.
        if (typeof body.website === 'string' && body.website.trim()) return json({ ok: true, received: false }, 202);

        const db = env?.ORDERS_DB;
        if (!db || typeof db.prepare !== 'function') return json({ error: 'Servicio no disponible.' }, 503);

        const now = getNow();
        const ip = req.headers.get('CF-Connecting-IP') || '';
        const ipHash = ip ? await sha256Hex(`${ip}|${now.toISOString().slice(0, 10)}`) : null;
        try {
            await ensureSchema(db, env);
            if (body.action === 'start') return await start(db, body, context, ipHash, now);
            if (body.action === 'event') return await event(db, body, now);
            if (body.action === 'request') return await request(db, body, ipHash, now);
            return json({ error: 'Acción inválida.' }, 400);
        } catch (error) {
            console.error('[librero] error', error?.name || 'Error');
            return json({ error: 'No pudimos completar la acción. Intentá de nuevo.' }, 503);
        }
    };
}
