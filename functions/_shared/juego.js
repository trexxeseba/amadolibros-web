/**
 * Lógica pura de La Rueda del Librero (y del canje de códigos).
 *
 * Reglas que no se rompen:
 * - El premio lo decide el servidor (drawPrize); el navegador solo lo anima.
 * - Ningún premio supera MAX_TOTAL_DISCOUNT: es la única constante de tope del sistema.
 * - Del número de WhatsApp solo se guarda un hash (con el día).
 */
import { LIQUIDACION_PRECIO, MAX_TOTAL_DISCOUNT, PRICE_FLOOR_UYU, TRANSFER_DISCOUNT } from './descuentos.js';

/**
 * Premios de la Rueda: descuento en pesos y probabilidad (en %). Suman 100.
 * El descuento se suma al de la liquidación, pero el total nunca pasa
 * MAX_TOTAL_DISCOUNT ni deja el precio bajo PRICE_FLOOR_UYU (ver precioConPremio).
 */
export const PREMIO_MIN_UYU = 150;
export const PREMIO_MAX_UYU = 450;
export const RUEDA_PREMIOS = Object.freeze([
    Object.freeze({ monto: 150, peso: 30 }),
    Object.freeze({ monto: 200, peso: 25 }),
    Object.freeze({ monto: 250, peso: 20 }),
    Object.freeze({ monto: 300, peso: 12 }),
    Object.freeze({ monto: 350, peso: 8 }),
    Object.freeze({ monto: 450, peso: 5 }),
]);

export const CODIGO_VIGENCIA_HORAS = 48;
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O ni 1/I
export const CODIGO_RE = /^LIB-[A-HJ-NP-Z2-9]{5}$/;

/** Falla al cargar el módulo si un premio sale del rango o los pesos no suman 100. */
export function validarPremios(premios = RUEDA_PREMIOS) {
    const total = premios.reduce((s, p) => s + p.peso, 0);
    if (total !== 100) throw new Error(`Los pesos de la Rueda suman ${total}, no 100.`);
    for (const p of premios) {
        if (!Number.isInteger(p.monto) || p.monto < PREMIO_MIN_UYU || p.monto > PREMIO_MAX_UYU) {
            throw new Error('Un premio de la Rueda sale del rango permitido: ' + p.monto);
        }
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
 * Precio con el premio de un código sobre el precio habitual (el tachado).
 * `premio` es un monto en pesos, o { monto_uyu, discount_pct } de un código;
 * los códigos viejos con porcentaje reemplazan el descuento base.
 * - Con monto: total = base (10 %) + monto + transferencia (12 %, si paga así).
 * - El total nunca pasa MAX_TOTAL_DISCOUNT del precio habitual.
 * - El precio final nunca baja de PRICE_FLOOR_UYU: el descuento se recorta hasta ahí.
 * - Quien gana un premio nunca paga más que sin premio.
 * Devuelve { ok, price, descuentoUyu, totalPct, transferSumada, reason } con
 * reason = 'ok' | 'recortado_por_piso' | 'bajo_piso' | 'precio_invalido'.
 */
export function precioConPremio(habitual, premio, { transferencia = false } = {}) {
    const h = Number(habitual);
    const vacio = reason => ({ ok: false, price: habitual, descuentoUyu: 0, totalPct: 0, transferSumada: false, reason });
    if (!Number.isFinite(h) || h <= 0) return vacio('precio_invalido');
    const cod = typeof premio === 'object' && premio ? premio : { monto_uyu: premio };
    const tope = MAX_TOTAL_DISCOUNT * h;
    const transf = transferencia ? TRANSFER_DISCOUNT * h : 0;
    const base = LIQUIDACION_PRECIO.discount * h;
    const bruto = cod.monto_uyu
        ? base + Number(cod.monto_uyu)
        : Math.min(Number(cod.discount_pct) / 100, MAX_TOTAL_DISCOUNT) * h;
    const sinTransf = Math.min(bruto, tope);
    const descuento = Math.min(bruto + transf, tope);
    const transferSumada = descuento > sinTransf + 1e-9;
    let reason = 'ok';
    let price = Math.ceil(h - descuento);
    if (price < PRICE_FLOOR_UYU) {
        if (h <= PRICE_FLOOR_UYU) return vacio('bajo_piso');
        price = PRICE_FLOOR_UYU;
        reason = 'recortado_por_piso';
    }
    return { ok: true, price, descuentoUyu: Math.round(h - price), totalPct: Math.round(((h - price) / h) * 100), transferSumada, reason };
}

export function mensajeCodigoWhatsapp(code) {
    return `Hola, tengo el código ${code} para este libro`;
}
