/**
 * /api/acertijo — El Acertijo del Librero.
 *
 * GET  devuelve el acertijo de hoy (sin respuestas), siempre sin caché.
 * POST valida la respuesta en el servidor, un intento por día y por número:
 *   acierto → código de 25 % (MAX_TOTAL_DISCOUNT) más un regalo configurable;
 *   error   → un premio de la Rueda como consuelo, con sus mismas reglas.
 * Del número solo se guarda un hash con el día; de la red, un hash diario de la IP.
 */
import {
    CODIGO_VIGENCIA_HORAS, diaMontevideo, drawPrize, generarCodigo, hashWhatsapp, normalizarWhatsapp,
    sha256Hex, vencimiento,
} from '../_shared/juego.js';
import { MAX_TOTAL_DISCOUNT } from '../_shared/descuentos.js';
import { acertijoDelDia, acertijoPublico, esRespuestaCorrecta, regaloTexto } from '../_shared/acertijos.js';
import { asegurarTablaPreview, json, sameOrigin, RATE_LIMIT } from './_rueda_handler.js';

export const MAX_BODY_BYTES = 2 * 1024;
export const PREMIO_ACIERTO_PCT = Math.round(MAX_TOTAL_DISCOUNT * 100);

const SELECT_HOY = "SELECT code, discount_pct, regalo, expires_at, used_at FROM juego_codigos WHERE wa_hash=? AND dia=? AND origen='acertijo'";

function respuestaCodigo(fila, extra = {}) {
    const acerto = Boolean(fila.regalo);
    return {
        ok: true, acerto, consuelo: !acerto,
        code: fila.code, discount_pct: Number(fila.discount_pct),
        regalo: fila.regalo || null, expires_at: fila.expires_at, valid_hours: CODIGO_VIGENCIA_HORAS, ...extra,
    };
}

function respuestaRepetida(fila, ahoraIso) {
    if (fila.used_at) return json({ error: 'Hoy ya usaste tu código del acertijo. Mañana te espera otro.', code: 'YA_USADO' }, 409);
    if (fila.expires_at <= ahoraIso) return json({ error: 'Hoy ya respondiste el acertijo. Mañana te espera otro.', code: 'YA_RESPONDIO' }, 409);
    return json(respuestaCodigo(fila, { repeat: true }), 200);
}

export function createAcertijoHandler({ getNow = () => new Date(), roll, codeBytes, data } = {}) {
    return async function onRequest(context) {
        const { request, env } = context;
        const now = getNow();
        const dia = diaMontevideo(now);
        const hoy = acertijoDelDia(dia, data);

        if (request.method === 'GET') {
            if (!hoy) return json({ error: 'Hoy no hay acertijo.' }, 404);
            return json({ ok: true, ...acertijoPublico(hoy, dia) });
        }
        if (request.method !== 'POST') return json({ error: 'Método no permitido.' }, 405, { Allow: 'GET, POST' });
        if (!hoy) return json({ error: 'Hoy no hay acertijo.' }, 404);
        if (!String(request.headers.get('Content-Type') || '').toLowerCase().startsWith('application/json')) {
            return json({ error: 'Content-Type debe ser application/json.' }, 415);
        }
        if (!sameOrigin(request)) return json({ error: 'Origen no permitido.' }, 403);

        const raw = await request.text();
        if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return json({ error: 'Solicitud demasiado grande.' }, 413);
        let body;
        try { body = JSON.parse(raw); } catch { return json({ error: 'JSON inválido.' }, 400); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Solicitud inválida.' }, 400);
        if (typeof body.website === 'string' && body.website.trim()) return json({ ok: true, received: false }, 202);

        const canonico = normalizarWhatsapp(body.whatsapp);
        if (!canonico) return json({ error: 'Escribí tu número de WhatsApp de Uruguay, por ejemplo 099 123 456.', code: 'WHATSAPP_INVALIDO' }, 400);
        const respuesta = typeof body.respuesta === 'string' ? body.respuesta.trim() : '';
        if (respuesta.length < 1 || respuesta.length > 120) return json({ error: 'Escribí tu respuesta al acertijo.', code: 'RESPUESTA_VACIA' }, 400);
        if (body.id !== hoy.id) return json({ error: 'El acertijo cambió. Recargá la página para ver el de hoy.', code: 'ACERTIJO_CAMBIO' }, 409);

        const db = env?.ORDERS_DB;
        if (!db || typeof db.prepare !== 'function') return json({ error: 'Servicio no disponible.' }, 503);

        const createdAt = now.toISOString();
        const ip = request.headers.get('CF-Connecting-IP') || '';
        const ipHash = ip ? await sha256Hex(`${ip}|${dia}`) : null;
        const waHash = await hashWhatsapp(canonico, dia, String(env?.JUEGO_SALT || ''));

        try {
            await asegurarTablaPreview(env, db);
            const existente = await db.prepare(SELECT_HOY).bind(waHash, dia).first();
            if (existente) return respuestaRepetida(existente, createdAt);

            if (ipHash) {
                const desde = new Date(now.getTime() - RATE_LIMIT.windowMinutes * 60000).toISOString();
                const fila = await db.prepare('SELECT COUNT(*) AS n FROM juego_codigos WHERE ip_hash=? AND created_at>=?').bind(ipHash, desde).first();
                if (Number(fila?.n) >= RATE_LIMIT.max) {
                    return json({ error: 'Hubo varios intentos desde esta conexión. Probá de nuevo más tarde o escribinos por WhatsApp.', code: 'RATE_LIMITED' }, 429);
                }
            }

            const acerto = esRespuestaCorrecta(respuesta, hoy);
            const pct = acerto ? PREMIO_ACIERTO_PCT : drawPrize(roll ? roll() : undefined).pct;
            const regalo = acerto ? regaloTexto(env, data) : null;
            for (let intento = 0; intento < 4; intento++) {
                const code = generarCodigo(codeBytes ? codeBytes() : undefined);
                const expira = vencimiento(now);
                const res = await db.prepare(
                    'INSERT OR IGNORE INTO juego_codigos (code, origen, discount_pct, regalo, wa_hash, dia, ip_hash, created_at, expires_at, used_at) ' +
                    "VALUES (?, 'acertijo', ?, ?, ?, ?, ?, ?, ?, NULL)"
                ).bind(code, pct, regalo, waHash, dia, ipHash, createdAt, expira).run();
                if (Number(res?.meta?.changes ?? 1) > 0) {
                    return json(respuestaCodigo({ code, discount_pct: pct, regalo, expires_at: expira }, { repeat: false }), 201);
                }
                const carrera = await db.prepare(SELECT_HOY).bind(waHash, dia).first();
                if (carrera) return respuestaRepetida(carrera, createdAt);
            }
            return json({ error: 'No pudimos registrar tu respuesta. Intentá de nuevo.' }, 503);
        } catch (error) {
            console.error('[acertijo] error', error?.name || 'Error');
            return json({ error: 'No pudimos registrar tu respuesta. Intentá de nuevo.' }, 503);
        }
    };
}
