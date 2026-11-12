/**
 * POST /api/premio — vista previa del premio en el carrito.
 *
 * Recibe { code, items: [{ product_id, quantity }] } y devuelve cuánto
 * descuenta el premio con los precios del catálogo (los mismos que cobra
 * /api/orders). No reserva ni gasta el código: eso pasa al crear el pedido.
 */
import { MAX_BODY_BYTES, buildSnapshot, consolidateItems, validateCartBody } from './_orders_logic.js';
import { normalizarCodigo } from '../_shared/juego.js';
import {
    PREMIO_MENSAJES, PREMIO_SELECT, calcularPremioPedido, estadoPremio, premioPublico,
} from '../_shared/premio-web.js';

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json;charset=UTF-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' },
    });
}

function sameOrigin(request) {
    const origin = request.headers.get('Origin');
    if (!origin) return true;
    try { return new URL(origin).host === new URL(request.url).host; } catch { return false; }
}

export function createPremioHandler({ fetchCatalog, getNow = () => new Date() }) {
    return async function onRequest(context) {
        const { request, env } = context;
        if (request.method !== 'POST') return json({ error: 'Método no permitido.' }, 405);
        if (!String(request.headers.get('Content-Type') || '').toLowerCase().includes('application/json')) {
            return json({ error: 'Content-Type debe ser application/json.' }, 415);
        }
        if (!sameOrigin(request)) return json({ error: 'Origen no permitido.' }, 403);

        let body;
        try {
            const text = await request.text();
            if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return json({ error: 'Solicitud demasiado grande.' }, 413);
            body = JSON.parse(text);
        } catch {
            return json({ error: 'JSON inválido.' }, 400);
        }
        const cartError = validateCartBody(body);
        if (cartError) return json({ error: cartError }, 400);

        const code = normalizarCodigo(body.code);
        if (!code) return json({ ok: false, premio_estado: 'formato', error: PREMIO_MENSAJES.formato }, 200);

        const db = env?.ORDERS_DB;
        if (!db) return json({ error: 'Servicio no disponible.' }, 503);

        let row;
        try {
            row = await db.prepare(PREMIO_SELECT).bind(code).first();
        } catch {
            return json({ error: 'No pudimos revisar tu premio. Intentá de nuevo en unos segundos.' }, 503);
        }
        const now = getNow();
        const estado = estadoPremio(row, now.toISOString());
        if (estado !== 'vigente') return json({ ok: false, premio_estado: estado, error: PREMIO_MENSAJES[estado] }, 200);

        const catalog = await Promise.resolve(fetchCatalog(context)).catch(() => null);
        if (!catalog || !Array.isArray(catalog.items)) {
            return json({ error: 'No pudimos calcular tu premio. Probá de nuevo en unos minutos.' }, 503);
        }
        const { snapshot } = buildSnapshot(consolidateItems(body.items), catalog.items);
        const calc = calcularPremioPedido(snapshot, row, now);
        return json({ ok: true, premio_estado: 'vigente', expires_at: row.expires_at, premio: premioPublico(code, calc) });
    };
}
