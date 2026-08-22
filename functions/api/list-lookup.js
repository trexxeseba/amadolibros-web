/**
 * functions/api/list-lookup.js
 *
 * GW2 (Kit de Lista de Lectura): recibe una lista de líneas de texto libre
 * (título, autor, ISBN — lo que la persona tenga) y responde, línea por
 * línea, contra el catálogo real: disponible ahora (con precio), lo
 * conseguimos por encargo, o no lo identificamos (nunca inventa una
 * coincidencia). Cada línea sin match alimenta el mismo Radar de Demanda
 * No Satisfecha que ya usan catalogo.js y search-suggestions.js
 * (functions/_shared/demand-radar.js) — "o en el mundo" también queda
 * registrado, no sólo lo que hay en stock.
 */

import { fetchActiveIndex, fetchPausedIndex } from '../_shared/catalog.js';
import { matchCatalogLine, recordUnmatchedQuery } from '../_shared/demand-radar.js';

const MAX_BODY_BYTES = 8 * 1024;
const MAX_LINES = 40;
const MAX_LINE_LENGTH = 200;

function json(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json;charset=UTF-8',
            'Cache-Control': 'no-store',
            ...extraHeaders,
        },
    });
}

export async function onRequest(context) {
    const { request, env, waitUntil } = context;

    if (request.method !== 'POST') {
        return json({ error: 'Método no permitido.' }, 405, { Allow: 'POST' });
    }
    const contentType = request.headers.get('Content-Type') || '';
    if (!contentType.toLowerCase().includes('application/json')) {
        return json({ error: 'Content-Type debe ser application/json.' }, 415);
    }
    const contentLength = Number.parseInt(request.headers.get('Content-Length') || '0', 10);
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
        return json({ error: 'Solicitud demasiado grande.' }, 413);
    }

    let body;
    try {
        const text = await request.text();
        if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
            return json({ error: 'Solicitud demasiado grande.' }, 413);
        }
        body = JSON.parse(text);
    } catch {
        return json({ error: 'JSON inválido.' }, 400);
    }

    if (!body || typeof body !== 'object' || !Array.isArray(body.lines)) {
        return json({ error: 'Se espera { lines: string[] }.' }, 400);
    }

    const lines = body.lines
        .filter(line => typeof line === 'string')
        .map(line => line.slice(0, MAX_LINE_LENGTH).trim())
        .filter(Boolean)
        .slice(0, MAX_LINES);

    if (lines.length === 0) {
        return json({ results: [] });
    }

    const [active, paused] = await Promise.all([fetchActiveIndex(context), fetchPausedIndex(context)]);
    const activeItems = Array.isArray(active?.items) ? active.items : [];
    const pausedItems = Array.isArray(paused?.items) ? paused.items : [];

    const results = lines.map(line => matchCatalogLine(line, { activeItems, pausedItems })).filter(Boolean);

    const unmatched = results.filter(r => r.status === 'no_match');
    if (unmatched.length > 0 && typeof waitUntil === 'function') {
        waitUntil(Promise.all(unmatched.map(r =>
            recordUnmatchedQuery(env?.ORDERS_DB, {
                rawQuery: r.query,
                source: 'reading_list',
                appEnv: env?.APP_ENV,
            }).catch(() => {}),
        )));
    }

    return json({ results });
}
