/**
 * Lógica pura de La Rueda del Librero (y del canje de códigos).
 *
 * Reglas que no se rompen:
 * - El premio lo decide el servidor (drawPrize); el navegador solo lo anima.
 * - Ningún premio supera MAX_TOTAL_DISCOUNT: es la única constante de tope del sistema.
 * - Del número de WhatsApp solo se guarda un hash (con el día).
 */
import { MAX_TOTAL_DISCOUNT, PRICE_FLOOR_UYU, TRANSFER_DISCOUNT } from './descuentos.js';

/** Premios de la Rueda: porcentaje y probabilidad (en %). Suman 100. */
export const RUEDA_PREMIOS = Object.freeze([
    Object.freeze({ pct: 10, peso: 35 }),
    Object.freeze({ pct: 12, peso: 25 }),
    Object.freeze({ pct: 15, peso: 20 }),
    Object.freeze({ pct: 18, peso: 10 }),
    Object.freeze({ pct: 20, peso: 6 }),
    Object.freeze({ pct: 25, peso: 4 }),
]);

export const CODIGO_VIGENCIA_HORAS = 48;
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O ni 1/I
export const CODIGO_RE = /^LIB-[A-HJ-NP-Z2-9]{5}$/;

/** Falla al cargar el módulo si un premio pasa el tope o los pesos no suman 100. */
export function validarPremios(premios = RUEDA_PREMIOS) {
    const total = premios.reduce((s, p) => s + p.peso, 0);
    if (total !== 100) throw new Error(`Los pesos de la Rueda suman ${total}, no 100.`);
    for (const p of premios) {
        if (p.pct / 100 > MAX_TOTAL_DISCOUNT) throw new Error(`El premio ${p.pct}% supera el tope.`);
    }
    return true;
}
validarPremios();

/** Entero uniforme en [0, max) sin sesgo de módulo. */
export function randomInt(max, getBytes = n => crypto.getRandomValues(new Uint32Array(n))) {
    const limit = Math.floor(0x100000000 / max) * max;
    for (;;) {
        const [v] = getBytes(1);
        if (v < limit) return v % max;
    }
}

/** Sortea un premio según los pesos. `roll` (0-99) se puede inyectar en tests. */
export function drawPrize(roll = randomInt(100), premios = RUEDA_PREMIOS) {
    let acc = 0;
    for (const p of premios) {
        acc += p.peso;
        if (roll < acc) return p;
    }
    return premios[premios.length - 1];
}

/** Día calendario en Montevideo (UTC-3): AAAA-MM-DD. */
export function diaMontevideo(now = new Date()) {
    return new Date(now.getTime() - 3 * 3600000).toISOString().slice(0, 10);
}

export function generarCodigo(bytes = crypto.getRandomValues(new Uint8Array(5))) {
    return `LIB-${Array.from(bytes, b => ALFABETO[b % ALFABETO.length]).join('')}`;
}

export function normalizarCodigo(value) {
    const raw = String(value ?? '').toUpperCase().replace(/[\s_]+/g, '');
    const code = /^LIB/.test(raw) && !raw.startsWith('LIB-') ? `LIB-${raw.slice(3)}` : raw;
    return CODIGO_RE.test(code) ? code : null;
}

/**
 * Número de WhatsApp de Uruguay en forma canónica (598 + 8 dígitos, móvil 9xxxxxxx).
 * Acepta 099 841 325, +598 99 841 325, 59899841325. Devuelve null si no es válido.
 */
export function normalizarWhatsapp(value) {
    const digits = String(value ?? '').replace(/\D/g, '');
    let local = digits;
    if (local.startsWith('00598')) local = local.slice(5);
    else if (local.startsWith('598')) local = local.slice(3);
    else if (local.startsWith('0')) local = local.slice(1);
    return /^9\d{7}$/.test(local) ? `598${local}` : null;
}

export async function sha256Hex(value) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Hash del número para el límite diario. La sal es opcional (JUEGO_SALT) y el día entra siempre. */
export function hashWhatsapp(canonico, dia, salt = '') {
    return sha256Hex(`wa|${canonico}|${dia}|${salt}`);
}

export function vencimiento(now = new Date(), horas = CODIGO_VIGENCIA_HORAS) {
    return new Date(now.getTime() + horas * 3600000).toISOString();
}

/**
 * Precio con el premio de un código sobre el precio habitual.
 * - Con transferencia, el 12 % se suma al premio hasta completar el tope:
 *   total = min(premio + 12 %, MAX_TOTAL_DISCOUNT). Así quien gana un premio
 *   nunca paga más que quien paga por transferencia sin premio (10 % + 12 % = 22 %).
 * - El descuento total nunca pasa MAX_TOTAL_DISCOUNT.
 * - Si el precio final queda bajo el piso de $1.200, el premio no se aplica.
 * Devuelve { ok, price, totalPct, transferSumada, reason }; transferSumada es
 * true si la transferencia aportó algo al total.
 */
export function precioConPremio(habitual, premioPct, { transferencia = false } = {}) {
    const h = Number(habitual);
    if (!Number.isFinite(h) || h <= 0) return { ok: false, price: habitual, totalPct: 0, transferSumada: false, reason: 'precio_invalido' };
    const premio = Math.min(Number(premioPct) / 100, MAX_TOTAL_DISCOUNT);
    const total = transferencia ? Math.min(premio + TRANSFER_DISCOUNT, MAX_TOTAL_DISCOUNT) : premio;
    const transferSumada = transferencia && total > premio + 1e-9;
    const price = Math.max(Math.round(h * (1 - total)), Math.ceil(h * (1 - MAX_TOTAL_DISCOUNT)));
    if (price < PRICE_FLOOR_UYU) return { ok: false, price: h, totalPct: 0, transferSumada: false, reason: 'bajo_piso' };
    return { ok: true, price, totalPct: Math.round(total * 100), transferSumada, reason: 'ok' };
}

export function mensajeCodigoWhatsapp(code) {
    return `Hola, tengo el código ${code} para este libro`;
}
