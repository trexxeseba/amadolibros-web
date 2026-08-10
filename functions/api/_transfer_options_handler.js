import { calculateTransferTotals, MAX_BODY_BYTES } from './_orders_logic.js';
import { resolveConfig } from './_env_config.js';
import { orderEmailService as defaultOrderEmailService } from './_order_email.js';

// Datos públicos de cobro, deliberadamente fuera del HTML estático. Se
// entregan únicamente después de autenticar una orden abierta con su código
// público + idempotency_key. Antes de producción Seba debe verificarlos en el
// canal bancario correspondiente.
export const TRANSFER_ACCOUNTS = Object.freeze([
  Object.freeze({
    id: 'brou',
    name: 'BROU',
    primary: true,
    holder: 'Victor Lopez Molea',
    account_label: 'Cuenta para transferencia',
    account_number: '00065582200001',
  }),
  Object.freeze({
    id: 'brou-cash',
    name: 'Abitab / RedPagos',
    primary: false,
    holder: 'Victor Lopez Molea',
    account_label: 'Caja de Ahorro BROU (formato anterior)',
    account_number: '1960816881',
  }),
  Object.freeze({
    id: 'itau',
    name: 'Itaú',
    primary: false,
    holder: 'Visconti Espinosa',
    account_label: 'Cuenta',
    account_number: '8969114',
  }),
  Object.freeze({
    id: 'oca-blue',
    name: 'OCA Blue',
    primary: false,
    holder: 'Lopez Molea',
    account_label: 'Transferencia o RedPagos',
    account_number: '2373466',
  }),
  Object.freeze({
    id: 'prex',
    name: 'Prex',
    primary: false,
    holder: 'Lopez Molea',
    account_label: 'Cuenta',
    account_number: '57211',
  }),
]);

export function createTransferOptionsHandler({
  getNow = () => new Date(),
  orderEmails = defaultOrderEmailService,
} = {}) {
  return async function onRequest(context) {
    const { request, env } = context;
    if (request.method !== 'POST') {
      return json({ error: 'Método no permitido.' }, 405, { Allow: 'POST' });
    }

    const contentType = request.headers.get('Content-Type') || '';
    if (!contentType.toLowerCase().includes('application/json')) {
      return json({ error: 'Content-Type debe ser application/json.' }, 415);
    }

    const config = resolveConfig(env);
    if (!config.ok) return json({ error: 'Servicio no disponible.' }, 503);
    if (!config.checkoutEnabled) {
      return json({
        error: 'Checkout no disponible en este momento.',
        code: 'checkout_temporarily_unavailable',
      }, 503);
    }
    if (!config.isAllowedRequestHost(new URL(request.url).hostname)) {
      return json({ error: 'Host no permitido.' }, 400);
    }

    const contentLength = Number.parseInt(request.headers.get('Content-Length') || '0', 10);
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      return json({ error: 'Body demasiado grande (máx. 32 KB).' }, 413);
    }

    let body;
    try {
      const text = await request.text();
      if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
        return json({ error: 'Body demasiado grande (máx. 32 KB).' }, 413);
      }
      body = JSON.parse(text);
    } catch {
      return json({ error: 'JSON inválido.' }, 400);
    }

    const publicCode = typeof body?.public_code === 'string' ? body.public_code.trim() : '';
    const idempotencyKey = typeof body?.idempotency_key === 'string' ? body.idempotency_key.trim() : '';
    if (!publicCode || publicCode.length > 20) {
      return json({ error: 'public_code requerido.' }, 400);
    }
    if (!idempotencyKey || idempotencyKey.length > 128) {
      return json({ error: 'idempotency_key requerido.' }, 400);
    }

    const db = env?.ORDERS_DB;
    if (!db) return json({ error: 'Servicio de órdenes no disponible.' }, 503);

    let order;
    try {
      order = await db.prepare(
        'SELECT id,public_code,status,payment_status,expires_at,buyer_name,buyer_phone,buyer_email,' +
        'delivery_type,address,locality,department,products_total_uyu,' +
        'pickup_discount_uyu,shipping_cost_uyu,payable_total_uyu,currency ' +
        'FROM orders WHERE public_code=? AND idempotency_key=?'
      ).bind(publicCode, idempotencyKey).first();
    } catch (error) {
      console.error('[transfer-options] order lookup error', safeErrorName(error));
      return json({ error: 'Servicio de órdenes no disponible.' }, 503);
    }

    if (!order) return json({ error: 'Pedido no encontrado.' }, 404);

    const now = getNow();
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      return json({ error: 'Error interno. Intentá de nuevo.' }, 500);
    }
    const expired = order.status === 'expired' || (
      order.status === 'open' &&
      typeof order.expires_at === 'string' &&
      Number.isFinite(Date.parse(order.expires_at)) &&
      Date.parse(order.expires_at) <= now.getTime()
    );
    if (expired) return json({ error: 'El pedido venció.', code: 'ORDER_EXPIRED' }, 410);
    if (order.status !== 'open' || order.payment_status === 'approved') {
      return json({ error: 'El pedido ya no admite este medio de pago.' }, 409);
    }

    const productsTotal = Number(order.products_total_uyu);
    const pickupDiscount = Number(order.pickup_discount_uyu);
    const shippingCost = Number(order.shipping_cost_uyu);
    const payableTotal = Number(order.payable_total_uyu);
    if (![productsTotal, pickupDiscount, shippingCost, payableTotal].every(Number.isInteger)) {
      return json({ error: 'Totales del pedido inválidos.' }, 500);
    }

    const { transferProductsTotal, transferDiscount, transferPayableTotal } =
      calculateTransferTotals({ productsTotal, pickupDiscount, shippingCost });

    const emailTask = Promise.resolve(orderEmails.sendTransferNotifications({
      db,
      env,
      order,
      payment: {
        method: 'bank_transfer',
        transfer_discount_uyu: transferDiscount,
        total_uyu: transferPayableTotal,
      },
      now,
    })).catch(error => {
      console.error('[transfer-options] email task error', safeErrorName(error));
    });
    if (typeof context.waitUntil === 'function') context.waitUntil(emailTask);
    else await emailTask;

    return json({
      payment: {
        method: 'bank_transfer',
        public_code: order.public_code,
        currency: order.currency,
        products_total_uyu: productsTotal,
        transfer_products_total_uyu: transferProductsTotal,
        transfer_discount_uyu: transferDiscount,
        pickup_discount_uyu: pickupDiscount,
        shipping_cost_uyu: shippingCost,
        list_total_uyu: payableTotal,
        transfer_total_uyu: transferPayableTotal,
        expires_at: order.expires_at,
      },
      accounts: TRANSFER_ACCOUNTS,
    });
  };
}

function safeErrorName(error) {
  return error && typeof error === 'object' && typeof error.name === 'string'
    ? error.name
    : 'Error';
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      ...extraHeaders,
    },
  });
}
