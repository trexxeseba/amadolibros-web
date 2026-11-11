// /panel/canje — verificación y canje de códigos de La Rueda del Librero.
// Para Gaby y Lola desde el celular. Solo con sesión del panel y en producción.
// Verificar no cambia nada; "Marcar como usado" lo hace una sola vez (atómico).
import { deriveSessionSecret, hasValidSession, resolvePanelConfig } from '../_shared/panel-auth.js';
import { normalizarCodigo, precioConPremio } from '../_shared/juego.js';

const ORIGIN = 'https://www.amadolibros.com';
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(body, status = 200) {
    return new Response(`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Canje de códigos</title>
<style>body{font:18px system-ui;max-width:520px;margin:4vh auto;padding:16px;line-height:1.5}input{font:inherit;width:100%;padding:12px;margin:6px 0 12px;box-sizing:border-box;text-transform:uppercase}button{font:inherit;padding:12px 18px;margin:4px 6px 4px 0;border-radius:8px;border:1px solid #18120e;background:#18120e;color:#fff;min-height:48px}button.sec{background:#fff;color:#18120e}.ok{color:#1a7a3c}.err{color:#b3261e}.card{border:1px solid #d1c8be;border-radius:12px;padding:14px;margin:12px 0}</style>
<p><a href="/panel">← Panel</a></p><h1>Canje de códigos</h1>${body}</html>`, {
        status,
        headers: {
            'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow',
            'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
            'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        },
    });
}

const formHtml = (code = '', precio = '') => `<form method="post"><label>Código del cliente<input name="codigo" value="${esc(code)}" placeholder="LIB-XXXXX" autocomplete="off" autocapitalize="characters" required></label>
<label>Precio habitual del libro (el tachado), si querés ver el precio final<input name="precio" value="${esc(precio)}" inputmode="numeric" placeholder="2000" autocomplete="off" style="text-transform:none"></label>
<button name="accion" value="verificar">Verificar</button></form>`;

const pesos = n => `$${Math.round(n).toLocaleString('es-UY')}`;

/** Calculadora para Gaby y Lola: precio final con el premio, con y sin transferencia. */
function calculadoraHtml(row, precio) {
    const h = Number(String(precio ?? '').replace(/[^\d]/g, ''));
    if (!h) return '';
    const premio = { monto_uyu: row.monto_uyu, discount_pct: row.discount_pct };
    const fila = (titulo, r) => (r.ok
        ? `<li>${titulo}: <b>${pesos(r.price)}</b> (descuento ${pesos(r.descuentoUyu)}, ${r.totalPct}% en total${r.reason === 'recortado_por_piso' ? '; se recortó para no bajar de $1.200' : ''})</li>`
        : `<li>${titulo}: no corresponde el premio (el precio ya está en el piso de $1.200).</li>`);
    return `<div class="card"><p><b>Precio final para un libro de ${pesos(h)}</b></p><ul>${fila('Pagando por transferencia', precioConPremio(h, premio, { transferencia: true }))}${fila('Otro medio de pago', precioConPremio(h, premio, { transferencia: false }))}</ul></div>`;
}

export function estadoCodigo(row, ahoraIso) {
    if (!row) return { estado: 'inexistente' };
    if (row.used_at) return { estado: 'usado', row };
    if (row.expires_at <= ahoraIso) return { estado: 'vencido', row };
    return { estado: 'vigente', row };
}

const fecha = iso => new Date(iso).toLocaleString('es-UY', { timeZone: 'America/Montevideo', dateStyle: 'medium', timeStyle: 'short' });

function resultado(info, code, precio = '') {
    if (info.estado === 'inexistente') return `<p class="err card">No encontramos ese código.</p>${formHtml(code)}`;
    const r = info.row;
    const premio = r.monto_uyu != null ? `${pesos(r.monto_uyu)} de descuento` : `${esc(r.discount_pct)}% de descuento`;
    const detalle = `<p>Premio: <b>${premio}</b>${r.regalo ? ` · Regalo: <b>${esc(r.regalo)}</b>` : ''}<br>Vence: ${esc(fecha(r.expires_at))}</p>
<p><small>El premio se suma al 10% de la liquidación y, si paga por transferencia, al 12% de la transferencia, pero el total no pasa 25% del precio habitual ni deja el libro por debajo de $1.200. Escribí el precio habitual del libro (el tachado) y la pantalla calcula el precio final.</small></p>${info.estado === 'vigente' ? calculadoraHtml(r, precio) : ''}`;
    if (info.estado === 'usado') return `<div class="card"><p class="err">Ya fue usado el ${esc(fecha(r.used_at))}.</p>${detalle}</div>${formHtml()}`;
    if (info.estado === 'vencido') return `<div class="card"><p class="err">Venció.</p>${detalle}</div>${formHtml()}`;
    return `<div class="card"><p class="ok"><b>Código vigente</b> ${esc(r.code)}</p>${detalle}
<form method="post"><input type="hidden" name="codigo" value="${esc(r.code)}"><input type="hidden" name="precio" value="${esc(precio)}"><button name="accion" value="usar">Marcar como usado</button><button name="accion" value="verificar" class="sec">Solo verificar</button></form></div>${formHtml()}`;
}

export function createCanjePanel({ getNow = () => new Date() } = {}) {
    return async ({ request, env }) => {
        const url = new URL(request.url);
        if (url.origin !== ORIGIN || env.APP_ENV !== 'production') return page('<p>No disponible.</p>', 403);
        const config = resolvePanelConfig(env);
        if (!config.ok || !await hasValidSession(request, await deriveSessionSecret(config.password))) return Response.redirect(`${ORIGIN}/panel`, 303);
        if (request.method === 'GET') return page(formHtml());
        if (request.method !== 'POST') return page('<p>Método no permitido.</p>', 405);
        if (request.headers.get('origin') !== ORIGIN) return page('<p class="err">Origen no válido.</p>', 403);

        const form = await request.formData();
        const code = normalizarCodigo(form.get('codigo'));
        const accion = String(form.get('accion') || 'verificar');
        const precio = String(form.get('precio') || '').slice(0, 12);
        if (!code) return page(`<p class="err card">El código tiene el formato LIB-XXXXX.</p>${formHtml(String(form.get('codigo') || ''))}`, 400);
        const db = env.ORDERS_DB;
        if (!db) return page('<p class="err">Servicio no disponible.</p>', 503);

        const ahora = getNow().toISOString();
        const leer = () => db.prepare('SELECT code, origen, discount_pct, monto_uyu, regalo, expires_at, used_at FROM juego_codigos WHERE code=?').bind(code).first();
        if (accion === 'usar') {
            const res = await db.prepare('UPDATE juego_codigos SET used_at=? WHERE code=? AND used_at IS NULL AND expires_at>?').bind(ahora, code, ahora).run();
            const row = await leer();
            if (Number(res?.meta?.changes) > 0) {
                return page(`<p class="ok card"><b>Listo, quedó marcado como usado.</b></p>${resultado(estadoCodigo(row, ahora), code, precio)}`);
            }
            return page(resultado(estadoCodigo(row, ahora), code, precio));
        }
        return page(resultado(estadoCodigo(await leer(), ahora), code, precio));
    };
}

export const onRequest = createCanjePanel();
