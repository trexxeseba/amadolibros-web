/**
 * Mails internos de premios (Rueda y Acertijo), con la misma cuenta de Resend
 * y el mismo destino que el aviso de venta web (SALES_NOTIFICATION_*):
 * - uno por cada premio que alguien gana;
 * - uno cuando un premio se canjea por WhatsApp desde /panel/canje.
 * Los canjes en la web llegan dentro del mail de venta.
 *
 * Nunca bloquean al cliente: se mandan en segundo plano y un fallo solo queda
 * en el log. Del cliente no se manda ningún dato personal (el número de
 * WhatsApp no se guarda en ningún lado).
 */
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const TIMEOUT_MS = 7000;

function config(env) {
    const apiKey = String(env?.RESEND_API_KEY || '').trim();
    const from = String(env?.SALES_NOTIFICATION_FROM || '').trim();
    const to = String(env?.SALES_NOTIFICATION_TO || '').split(',').map(v => v.trim()).filter(Boolean);
    if (!apiKey || !from || !to.length) return null;
    return { apiKey, from, to };
}

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pesos = n => '$' + new Intl.NumberFormat('es-UY', { maximumFractionDigits: 0 }).format(Number(n) || 0);
const fecha = iso => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return new Intl.DateTimeFormat('es-UY', { timeZone: 'America/Montevideo', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(d);
};
const JUEGO = { rueda: 'la Rueda del Librero', acertijo: 'el Acertijo del Librero' };

export function premioGanadoEmail({ code, origen, monto_uyu, regalo, expires_at, umbral_uyu }) {
    const juego = JUEGO[origen] || 'el juego';
    const subject = `Premio de ${pesos(monto_uyu)} en ${juego} — ${code}`;
    const lineas = [
        `Alguien ganó ${pesos(monto_uyu)} de descuento en ${juego}.`,
        regalo ? `Además acertó el acertijo: regalo «${regalo}».` : '',
        `Código: ${code}`,
        `Vence: ${fecha(expires_at)}`,
        umbral_uyu ? `Entra entero en libros desde ${pesos(umbral_uyu)}.` : '',
        'Se usa solo al pagar en la web, o por WhatsApp desde /panel/canje.',
    ].filter(Boolean);
    return { subject, text: lineas.join('\n'), html: `<!doctype html><html lang="es"><body style="font-family:Arial,sans-serif;color:#222;line-height:1.5">${lineas.map(l => `<p style="margin:6px 0">${esc(l)}</p>`).join('')}</body></html>` };
}

export function premioCanjeadoEmail({ code, monto_uyu, libro, precio_habitual, descuento_uyu, canal = 'whatsapp' }) {
    const subject = `Premio canjeado por ${canal === 'web' ? 'la web' : 'WhatsApp'} — ${code}`;
    const lineas = [
        `Se canjeó el premio ${code}${monto_uyu ? ` (${pesos(monto_uyu)})` : ''} por ${canal === 'web' ? 'la web' : 'WhatsApp'}.`,
        `Libro: ${libro || 'sin anotar'}`,
        precio_habitual ? `Precio habitual: ${pesos(precio_habitual)}` : '',
        descuento_uyu ? `Descuento total del libro: ${pesos(descuento_uyu)}` : '',
    ].filter(Boolean);
    return { subject, text: lineas.join('\n'), html: `<!doctype html><html lang="es"><body style="font-family:Arial,sans-serif;color:#222;line-height:1.5">${lineas.map(l => `<p style="margin:6px 0">${esc(l)}</p>`).join('')}</body></html>` };
}

export async function enviarAvisoPremio(env, email, idempotencyKey, { fetchFn = globalThis.fetch } = {}) {
    const cfg = config(env);
    if (!cfg) return { ok: false, skipped: true };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await fetchFn(RESEND_ENDPOINT, {
            method: 'POST',
            headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
            body: JSON.stringify({ from: cfg.from, to: cfg.to, subject: email.subject, text: email.text, html: email.html }),
            signal: controller.signal,
        });
        if (!res.ok) console.error('[premio-aviso] Resend respondió', res.status);
        return { ok: res.ok };
    } catch (error) {
        console.error('[premio-aviso] no se pudo mandar', error?.name || 'Error');
        return { ok: false };
    } finally {
        clearTimeout(timer);
    }
}

/** Corre en segundo plano si el entorno lo permite; nunca tira. */
export function enSegundoPlano(context, promesa) {
    const segura = Promise.resolve(promesa).catch(() => {});
    if (typeof context?.waitUntil === 'function') context.waitUntil(segura);
    return segura;
}
