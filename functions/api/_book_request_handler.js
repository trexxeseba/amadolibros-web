/**
 * Registra búsquedas de libros. Las solicitudes con contacto se guardan en D1
 * y se avisan al equipo; solo se confirma el envío cuando el aviso fue aceptado.
 * El contacto no se incluye en analítica, respuestas públicas ni logs.
 */
import { notifyBookRequest } from './_book_request_email.js';
import { contactValidation } from '../../shared/contact-validation.js';

export const MAX_BODY_BYTES = 8 * 1024;
export const RATE_LIMIT = Object.freeze({ max: 5, windowMinutes: 10 });

export const REQUEST_TYPES = Object.freeze([
    'exacto', 'agotado', 'sin-resultados', 'novedades-tecnicas', 'digital',
    'antiguo', 'tapa', 'bibliografia', 'regalo',
]);
const FORMATS = new Set(['Me sirve cualquier formato', 'Libro físico', 'Edición digital', 'Original antiguo', 'Facsímil o reedición']);
const LANGUAGES = new Set(['Español', 'Puede ser otro idioma', 'Inglés', 'Portugués', 'Francés', 'Italiano']);

const PREVIEW_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS book_requests (
  id TEXT PRIMARY KEY,
  public_code TEXT NOT NULL UNIQUE,
  request_type TEXT NOT NULL,
  query TEXT NOT NULL,
  author_isbn TEXT,
  format TEXT,
  language TEXT,
  budget_uyu INTEGER,
  details TEXT,
  source_url TEXT,
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received','in_progress','answered','closed')),
  ip_hash TEXT,
  created_at TEXT NOT NULL
)`;
const previewSchema = new WeakMap();
const previewContactsSchema = new WeakMap();
const CONTACTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS book_request_contacts (
  request_id TEXT PRIMARY KEY REFERENCES book_requests(id) ON DELETE CASCADE,
  contact_type TEXT NOT NULL CHECK (contact_type IN ('email','whatsapp')),
  contact_value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  notification_sent_at TEXT
)`;

export function normalizeReplyContact(value) {
    return contactValidation.replyContact(value);
}

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

/** Valida y normaliza el cuerpo. Devuelve { ok, value } o { ok: false, error }. */
export function validateBookRequest(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Solicitud inválida.' };
    const requestType = text(body.request_type, 40);
    if (!REQUEST_TYPES.includes(requestType)) return { ok: false, error: 'Tipo de pedido inválido.' };
    const query = text(body.query, 300);
    if (!query || query.length < 2) return { ok: false, error: 'Contanos qué libro buscás.' };
    const authorIsbn = text(body.author_isbn ?? '', 200);
    const details = text(body.details ?? '', 1000);
    if (authorIsbn === null || details === null) return { ok: false, error: 'Algún dato es demasiado largo.' };
    const format = text(body.format ?? '', 60);
    const language = text(body.language ?? '', 60);
    const rawBudget = body.budget === undefined || body.budget === null || body.budget === '' ? null : Number(body.budget);
    if (rawBudget !== null && (!Number.isFinite(rawBudget) || rawBudget < 0 || rawBudget > 10_000_000)) {
        return { ok: false, error: 'Presupuesto inválido.' };
    }
    const sourceUrl = text(body.source_url ?? '', 500);
    const replyContact = body.reply_contact ? normalizeReplyContact(body.reply_contact) : null;
    if (body.reply_contact !== undefined && !replyContact) return { ok: false, error: 'Ingresá un correo o un número de WhatsApp válido.' };
    return {
        ok: true,
        value: {
            request_type: requestType,
            reply_contact: replyContact,
            query,
            author_isbn: authorIsbn || null,
            format: FORMATS.has(format) ? format : null,
            language: LANGUAGES.has(language) ? language : null,
            budget_uyu: rawBudget === null ? null : Math.round(rawBudget),
            details: details || null,
            source_url: sourceUrl && /^https:\/\/[^/]*amadolibros/.test(sourceUrl) ? sourceUrl.split('#')[0] : null,
        },
    };
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Código corto para leer por WhatsApp: PL-AAMMDD-XXXX (hora de Montevideo). */
export function generateRequestCode(now = new Date(), random = crypto.getRandomValues(new Uint8Array(4))) {
    const mvd = new Date(now.getTime() - 3 * 3600000);
    const ymd = mvd.toISOString().slice(2, 10).replace(/-/g, '');
    const suffix = Array.from(random, byte => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
    return `PL-${ymd}-${suffix}`;
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

export function createBookRequestHandler({ getNow = () => new Date(), random = () => crypto.getRandomValues(new Uint8Array(4)), notify = notifyBookRequest } = {}) {
    return async function onRequest(context) {
        const { request, env } = context;
        if (request.method !== 'POST') return json({ error: 'Método no permitido.' }, 405, { Allow: 'POST' });
        if (!String(request.headers.get('Content-Type') || '').toLowerCase().startsWith('application/json')) {
            return json({ error: 'Content-Type debe ser application/json.' }, 415);
        }
        if (!sameOrigin(request)) return json({ error: 'Origen no permitido.' }, 403);

        const raw = await request.text();
        if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return json({ error: 'Solicitud demasiado grande.' }, 413);
        let body;
        try { body = JSON.parse(raw); } catch { return json({ error: 'JSON inválido.' }, 400); }

        // Campo trampa: una persona no lo ve ni lo completa.
        if (typeof body?.website === 'string' && body.website.trim()) return json({ ok: true, received: false }, 202);

        const parsed = validateBookRequest(body);
        if (!parsed.ok) return json({ error: parsed.error }, 400);

        const db = env?.ORDERS_DB;
        if (!db || typeof db.prepare !== 'function') return json({ error: 'Servicio no disponible.' }, 503);

        const now = getNow();
        const createdAt = now.toISOString();
        const ip = request.headers.get('CF-Connecting-IP') || '';
        const ipHash = ip ? await sha256Hex(`${ip}|${createdAt.slice(0, 10)}`) : null;

        try {
            if (String(env?.APP_ENV || '') === 'preview') {
                let pending = previewSchema.get(db);
                if (!pending) { pending = db.prepare(PREVIEW_TABLE_SQL).bind().run(); previewSchema.set(db, pending); }
                await pending;
                if (parsed.value.reply_contact) {
                    let contacts = previewContactsSchema.get(db);
                    if (!contacts) { contacts = db.prepare(CONTACTS_TABLE_SQL).bind().run(); previewContactsSchema.set(db, contacts); }
                    await contacts;
                }
            }
            if (ipHash) {
                const since = new Date(now.getTime() - RATE_LIMIT.windowMinutes * 60000).toISOString();
                const row = await db.prepare('SELECT COUNT(*) AS n FROM book_requests WHERE ip_hash=? AND created_at>=?')
                    .bind(ipHash, since).first();
                if (Number(row?.n) >= RATE_LIMIT.max) {
                    return json({ error: 'Recibimos varios pedidos seguidos. Escribinos por WhatsApp y lo vemos juntos.', code: 'RATE_LIMITED' }, 429);
                }
            }
            const v = parsed.value;
            for (let attempt = 0; attempt < 3; attempt++) {
                const code = generateRequestCode(now, random());
                const requestId = crypto.randomUUID();
                const insert = db.prepare(
                    'INSERT OR IGNORE INTO book_requests (id, public_code, request_type, query, author_isbn, format, language, ' +
                    'budget_uyu, details, source_url, status, ip_hash, created_at) ' +
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?)"
                ).bind(
                    requestId, code, v.request_type, v.query, v.author_isbn, v.format, v.language,
                    v.budget_uyu, v.details, v.source_url, ipHash, createdAt,
                );
                const result = v.reply_contact
                    ? (await db.batch([
                        insert,
                        db.prepare('INSERT INTO book_request_contacts (request_id, contact_type, contact_value, created_at) SELECT id, ?, ?, ? FROM book_requests WHERE id=?')
                            .bind(v.reply_contact.type, v.reply_contact.value, createdAt, requestId),
                    ]))[0]
                    : await insert.run();
                if (Number(result?.meta?.changes ?? 1) > 0) {
                    if (v.reply_contact) {
                        const notification = await notify({ env, value: v, code, requestId }).catch(() => ({ ok: false }));
                        if (!notification.ok) {
                            return json({ received: true, notification_sent: false, request_code: code,
                                error: 'Guardamos tu solicitud, pero no pudimos avisar al equipo. Podés continuar por WhatsApp con este código.' }, 202);
                        }
                        await db.prepare('UPDATE book_request_contacts SET notification_sent_at=? WHERE request_id=?')
                            .bind(createdAt, requestId).run().catch(() => console.error('[book-request] notification status unavailable'));
                        return json({ ok: true, received: true, notification_sent: true, request_code: code }, 201);
                    }
                    return json({ ok: true, received: true, request_code: code }, 201);
                }
            }
            return json({ error: 'No pudimos registrar el pedido. Intentá de nuevo.' }, 503);
        } catch (error) {
            console.error('[book-request] error', error?.name || 'Error');
            return json({ error: 'No pudimos registrar el pedido. Intentá de nuevo.' }, 503);
        }
    };
}
