/**
 * Premios de La Rueda y El Acertijo usados al pagar en la web.
 *
 * El premio va a un solo ejemplar: el del carrito donde más descuenta (en la
 * práctica, el más caro). Se calcula siempre en el servidor con precioConPremio
 * sobre el precio habitual, igual que el canje por WhatsApp:
 * - descuento_uyu: lo que baja pagando con Mercado Pago (precio de liquidación → precio con premio);
 * - descuento_transfer_uyu: lo que baja además pagando por transferencia, frente al
 *   total por transferencia sin premio.
 * Un premio que no baja nada (libro de $1.000 o menos) no se aplica y el código
 * no se gasta.
 */
import { CODIGO_RE, normalizarCodigo, precioConPremio, umbralPremioEntero } from './juego.js';
import { transferProductsTotal } from './descuentos.js';

export const PREMIO_SELECT =
    'SELECT code, origen, discount_pct, monto_uyu, expires_at, used_at, order_id, reservado_hasta FROM juego_codigos WHERE code=?';

/** Un código de la base, listo para calcular. */
function premioDe(row) {
    return { monto_uyu: row.monto_uyu == null ? null : Number(row.monto_uyu), discount_pct: row.discount_pct == null ? null : Number(row.discount_pct) };
}

function sinUnEjemplar(snapshot, productId) {
    const out = [];
    for (const line of snapshot) {
        if (line.product_id !== productId) { out.push(line); continue; }
        const qty = Number(line.quantity) - 1;
        if (qty > 0) out.push({ ...line, quantity: qty, line_total_uyu: Number(line.unit_price_uyu) * qty });
    }
    return out;
}

/**
 * Calcula el premio sobre un carrito ya validado contra el catálogo.
 * snapshot: [{ product_id, title, unit_price_uyu, quantity, line_total_uyu, habitual_unit_uyu }]
 */
export function calcularPremioPedido(snapshot, row, now = new Date()) {
    const premio = premioDe(row);
    const umbral = premio.monto_uyu ? umbralPremioEntero(premio.monto_uyu) : null;
    const transferSinPremio = transferProductsTotal(snapshot, now);
    let mejor = null;
    for (const line of snapshot) {
        const unit = Number(line.unit_price_uyu);
        const habitual = Number(line.habitual_unit_uyu) > unit ? Number(line.habitual_unit_uyu) : unit;
        const tarjeta = precioConPremio(habitual, premio, { transferencia: false });
        const transf = precioConPremio(habitual, premio, { transferencia: true });
        if (!tarjeta.ok || !transf.ok) continue;
        const descuento = Math.max(0, unit - tarjeta.price);
        const transferConPremio = transferProductsTotal(sinUnEjemplar(snapshot, line.product_id), now) + transf.price;
        const descuentoTransfer = Math.max(0, transferSinPremio - transferConPremio);
        if (descuento <= 0 && descuentoTransfer <= 0) continue;
        const cand = { line, descuento, descuentoTransfer, precio: tarjeta.price };
        if (!mejor || descuento > mejor.descuento || (descuento === mejor.descuento && descuentoTransfer > mejor.descuentoTransfer)) mejor = cand;
    }
    if (!mejor) {
        return { aplicado: false, motivo: 'bajo_piso', monto_uyu: premio.monto_uyu, umbral_uyu: umbral, descuento_uyu: 0, descuento_transfer_uyu: 0 };
    }
    return {
        aplicado: true,
        motivo: 'ok',
        product_id: mejor.line.product_id,
        title: mejor.line.title,
        monto_uyu: premio.monto_uyu,
        umbral_uyu: umbral,
        descuento_uyu: mejor.descuento,
        descuento_transfer_uyu: mejor.descuentoTransfer,
        // Entero: el premio en pesos bajó todo lo que promete.
        entero: premio.monto_uyu ? mejor.descuento >= premio.monto_uyu - 1 : true,
    };
}

/** Estado del código para usarlo ahora. */
export function estadoPremio(row, ahoraIso) {
    if (!row) return 'inexistente';
    if (row.used_at) return 'usado';
    if (row.expires_at <= ahoraIso) return 'vencido';
    return 'vigente';
}

export const PREMIO_MENSAJES = Object.freeze({
    formato: 'El código de premio tiene la forma LIB-XXXXX.',
    inexistente: 'No encontramos ese código de premio. Revisá que esté bien escrito.',
    usado: 'Ese premio ya se usó en otra compra.',
    vencido: 'Ese premio ya venció. Podés girar la rueda de nuevo en la liquidación.',
    reservado: 'Ese premio está en otro pedido que se está pagando. Si ese pago no sigue, vuelve a estar disponible en una hora.',
});

/** Normaliza lo que manda el navegador; null si no mandó nada. */
export function codigoPremioDelBody(body) {
    const raw = typeof body?.premio_code === 'string' ? body.premio_code.trim() : '';
    if (!raw) return { code: null };
    const code = normalizarCodigo(raw);
    return code && CODIGO_RE.test(code) ? { code } : { code: null, error: 'formato' };
}

/** Texto para el cliente cuando el premio rinde menos o no entra. */
export function avisoPremio(calc) {
    if (!calc) return '';
    const pesos = n => '$' + new Intl.NumberFormat('es-UY', { maximumFractionDigits: 0 }).format(n);
    if (!calc.aplicado) {
        return calc.umbral_uyu
            ? `Tu premio queda guardado para un libro desde ${pesos(calc.umbral_uyu)}: en estos libros el precio ya está en el mínimo.`
            : 'Tu premio queda guardado para otro libro: en estos el precio ya está en el mínimo.';
    }
    if (!calc.entero && calc.umbral_uyu) {
        return `En este libro tu premio te descuenta ${pesos(calc.descuento_uyu)}. En un libro desde ${pesos(calc.umbral_uyu)} lo aprovechás entero.`;
    }
    return '';
}

/**
 * Marca el premio de un pedido como usado cuando el pago se aprueba (Mercado
 * Pago o transferencia confirmada). Guarda el canal, el libro y lo que descontó.
 * Se busca por el código del pedido, no por la reserva: si el cliente armó otro
 * pedido después, el premio igual queda usado por el que se pagó.
 */
export function marcarPremioUsadoStmt(db, orderId, usedAtIso, { transferencia = false } = {}) {
    return db.prepare(
        "UPDATE juego_codigos SET used_at = ?, order_id = ?, reservado_hasta = NULL, canal = 'web', " +
        'descuento_uyu = (SELECT CASE WHEN ? = 1 THEN premio_transfer_discount_uyu ELSE premio_discount_uyu END FROM orders WHERE id = ?), ' +
        'libro = (SELECT oi.title FROM orders o JOIN order_items oi ON oi.order_id = o.id AND oi.product_id = o.premio_product_id WHERE o.id = ?) ' +
        'WHERE code = (SELECT premio_code FROM orders WHERE id = ?) AND used_at IS NULL'
    ).bind(usedAtIso, orderId, transferencia ? 1 : 0, orderId, orderId, orderId);
}

/** Lo que el navegador recibe del premio de un pedido o de un carrito. */
export function premioPublico(code, calc) {
    return {
        code,
        aplicado: calc.aplicado,
        monto_uyu: calc.monto_uyu,
        umbral_uyu: calc.umbral_uyu,
        product_id: calc.product_id || null,
        title: calc.title || null,
        descuento_uyu: calc.descuento_uyu,
        descuento_transfer_uyu: calc.descuento_transfer_uyu,
        aviso: avisoPremio(calc),
    };
}
