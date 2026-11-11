/**
 * POST /api/rueda — un giro de La Rueda del Librero.
 *
 * El premio lo sortea el servidor (nunca el navegador) y devuelve un código de
 * 48 horas y un solo uso. Un giro por día y por número de WhatsApp: si el número
 * ya giró hoy, se le muestra el mismo código (mientras siga vigente).
 * Del número solo se guarda un hash; de la red, un hash diario de la IP.
 */
import {
    CODIGO_VIGENCIA_HORAS, diaMontevideo, drawPrize, generarCodigo, hashWhatsapp,
    normalizarWhatsapp, sha256Hex, vencimiento,
} from '../_shared/juego.js';

export const MAX_BODY_BYTES = 2 * 1024;
export const RATE_LIMIT = Object.freeze({ max: 6, windowMinutes: 60 });

/** Misma estructura que migrations/0017_juego_codigos.sql (un test las compara). */
export const PREVIEW_TABLE_SQL = `CREATE TABLE IF NOT EXISTS juego_codigos (
  code TEXT PRIMARY KEY,
  origen TEXT NOT NULL CHECK (origen IN ('rueda','acertijo')),
  discount_pct INTEGER NOT NULL CHECK (discount_pct BETWEEN 1 AND 25),
  regalo TEXT,
  wa_hash TEXT NOT NULL,
  dia TEXT NOT NULL,
  ip_hash TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
)`;
const previewSchema = new WeakMap();

function json(data, status = 200, extra = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json;charset=UTF-8', 'Cache-Control': 'no-store', ...extra },
    });
}

function sameOrigin(request) {
    const origin = request.headers.get('Origin');
    if (!origin) return true;
    try { return new URL(origin).host === new URL(request.url).host; } catch { return false; }
}

const publico = row => ({
    ok: true,
    code: row.code,
    discount_pct: Number(row.discount_pct),
    expires_at: row.expires_at,
    valid_hours: CODIGO_VIGENCIA_HORAS,
});

export function createRuedaHandler({ getNow = () => new Date(), roll, codeBytes } = {}) {
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
        if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Solicitud inválida.' }, 400);

        // Campo trampa: una persona no lo ve ni lo completa.
        if (typeof body.website === 'string' && body.website.trim()) return json({ ok: true, received: false }, 202);

        const canonico = normalizarWhatsapp(body.whatsapp);
        if (!canonico) return json({ error: 'Escribí tu número de WhatsApp de Uruguay, por ejemplo 099 123 456.', code: 'WHATSAPP_INVALIDO' }, 400);

        const db = env?.ORDERS_DB;
        if (!db || typeof db.prepare !== 'function') return json({ error: 'Servicio no disponible.' }, 503);

        const now = getNow();
        const createdAt = now.toISOString();
        const dia = diaMontevideo(now);
        const ip = request.headers.get('CF-Connecting-IP') || '';
        const ipHash = ip ? await sha256Hex(`${ip}|${dia}`) : null;
        const waHash = await hashWhatsapp(canonico, dia, String(env?.JUEGO_SALT || ''));

        try {
            if (String(env?.APP_ENV || '') === 'preview') {
                let pending = previewSchema.get(db);
                if (!pending) { pending = db.prepare(PREVIEW_TABLE_SQL).bind().run(); previewSchema.set(db, pending); }
                await pending;
            }

            const existente = await db.prepare(
                "SELECT code, discount_pct, expires_at, used_at FROM juego_codigos WHERE wa_hash=? AND dia=? AND origen='rueda'"
            ).bind(waHash, dia).first();
            if (existente) return respuestaRepetida(existente, createdAt);

            if (ipHash) {
                const desde = new Date(now.getTime() - RATE_LIMIT.windowMinutes * 60000).toISOString();
                const fila = await db.prepare('SELECT COUNT(*) AS n FROM juego_codigos WHERE ip_hash=? AND created_at>=?')
                    .bind(ipHash, desde).first();
                if (Number(fila?.n) >= RATE_LIMIT.max) {
                    return json({ error: 'Hubo varios giros desde esta conexión. Probá de nuevo más tarde o escribinos por WhatsApp.', code: 'RATE_LIMITED' }, 429);
                }
            }

            const premio = drawPrize(roll ? roll() : undefined);
            for (let intento = 0; intento < 4; intento++) {
                const code = generarCodigo(codeBytes ? codeBytes() : undefined);
                const res = await db.prepare(
                    'INSERT OR IGNORE INTO juego_codigos (code, origen, discount_pct, regalo, wa_hash, dia, ip_hash, created_at, expires_at, used_at) ' +
                    "VALUES (?, 'rueda', ?, NULL, ?, ?, ?, ?, ?, NULL)"
                ).bind(code, premio.pct, waHash, dia, ipHash, createdAt, vencimiento(now)).run();
                if (Number(res?.meta?.changes ?? 1) > 0) {
                    return json({ ...publico({ code, discount_pct: premio.pct, expires_at: vencimiento(now) }), repeat: false }, 201);
                }
                // Si fue una carrera por el mismo número, devolvemos el código ya creado.
                const carrera = await db.prepare(
                    "SELECT code, discount_pct, expires_at, used_at FROM juego_codigos WHERE wa_hash=? AND dia=? AND origen='rueda'"
                ).bind(waHash, dia).first();
                if (carrera) return respuestaRepetida(carrera, createdAt);
            }
            return json({ error: 'No pudimos darte el giro. Intentá de nuevo.' }, 503);
        } catch (error) {
            console.error('[rueda] error', error?.name || 'Error');
            return json({ error: 'No pudimos darte el giro. Intentá de nuevo.' }, 503);
        }
    };
}

function respuestaRepetida(fila, ahoraIso) {
    if (fila.used_at) {
        return json({ error: 'Hoy ya usaste tu código. Mañana tenés otro giro esperándote.', code: 'YA_USADO' }, 409);
    }
    if (fila.expires_at <= ahoraIso) {
        return json({ error: 'Hoy ya giraste. Mañana tenés otro giro esperándote.', code: 'YA_GIRO' }, 409);
    }
    return json({ ...publico(fila), repeat: true }, 200);
}
