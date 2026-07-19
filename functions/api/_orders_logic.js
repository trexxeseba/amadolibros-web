export const RETIRO_DISCOUNT         = 150;
export const SHIPPING_COST           = 250;
export const FREE_SHIPPING_THRESHOLD = 2000;
export const EXPIRY_MINUTES          = 60;
export const MAX_BODY_BYTES          = 32 * 1024;
export const MAX_ITEMS               = 20;
export const MAX_NAME_LEN            = 120;
export const MAX_PHONE_LEN           = 40;
export const MAX_ADDRESS_LEN         = 200;
export const MAX_NOTES_LEN           = 500;

export function validateBody(body) {
  if (!body || typeof body !== 'object') return 'Body inválido.';

  if (typeof body.idempotency_key !== 'string' || !body.idempotency_key.trim()) {
    return 'Falta idempotency_key.';
  }

  if (!Array.isArray(body.items) || body.items.length === 0) return 'El carrito está vacío.';
  if (body.items.length > MAX_ITEMS) return 'Demasiados productos (máx. ' + MAX_ITEMS + ').';

  for (const it of body.items) {
    if (!it.product_id || typeof it.product_id !== 'string' || !it.product_id.trim()) {
      return 'product_id inválido.';
    }
    if (!Number.isInteger(it.quantity) || it.quantity < 1) {
      return 'Cantidad inválida.';
    }
  }

  if (!['pickup', 'shipping'].includes(body.delivery_type)) {
    return 'delivery_type inválido.';
  }

  if (!body.buyer || typeof body.buyer !== 'object') return 'Falta buyer.';
  const name  = (body.buyer.name  || '').trim();
  const phone = (body.buyer.phone || '').trim();
  if (!name)  return 'Nombre del comprador requerido.';
  if (name.length > MAX_NAME_LEN)  return 'Nombre demasiado largo.';
  if (!phone) return 'Teléfono del comprador requerido.';
  if (phone.length > MAX_PHONE_LEN) return 'Teléfono demasiado largo.';

  if (body.delivery_type === 'shipping') {
    if (!body.shipping || typeof body.shipping !== 'object') return 'Falta shipping.';
    const s = body.shipping;
    if (!s.address  || !s.address.trim())  return 'Dirección requerida.';
    if (s.address.length > MAX_ADDRESS_LEN) return 'Dirección demasiado larga.';
    if (!s.locality  || !s.locality.trim())  return 'Localidad requerida.';
    if (!s.department || !s.department.trim()) return 'Departamento requerido.';
    if (!s.requested_date || !/^\d{4}-\d{2}-\d{2}$/.test(s.requested_date)) {
      return 'Fecha inválida (formato YYYY-MM-DD).';
    }
    if (!s.requested_from || !/^\d{2}:\d{2}$/.test(s.requested_from)) {
      return 'Hora desde inválida (formato HH:MM).';
    }
    if (!s.requested_to || !/^\d{2}:\d{2}$/.test(s.requested_to)) {
      return 'Hora hasta inválida (formato HH:MM).';
    }
    if (s.notes && s.notes.length > MAX_NOTES_LEN) return 'Notas demasiado largas.';
  }

  return null;
}

export function validateShippingDate(requested_date, requested_from, requested_to, now) {
  const todayStr = now.toISOString().slice(0, 10);
  if (requested_date < todayStr) return 'La fecha solicitada ya pasó.';
  if (requested_to <= requested_from) {
    return 'La hora de fin debe ser posterior a la hora de inicio.';
  }
  return null;
}

export function consolidateItems(items) {
  const map = new Map();
  for (const it of items) {
    const pid = it.product_id.trim();
    if (map.has(pid)) {
      map.get(pid).quantity += it.quantity;
    } else {
      map.set(pid, { product_id: pid, quantity: it.quantity });
    }
  }
  return Array.from(map.values()).sort((a, b) => a.product_id.localeCompare(b.product_id));
}

export function buildSnapshot(consolidatedItems, catalogItems) {
  const byId = {};
  for (const ci of catalogItems) byId[ci.id] = ci;

  const errors  = [];
  const snapshot = [];

  for (const item of consolidatedItems) {
    const cat = byId[item.product_id];
    if (!cat) {
      errors.push('Producto no encontrado: ' + item.product_id);
      continue;
    }
    if (cat.status && cat.status !== 'active') {
      errors.push('Producto no disponible: ' + item.product_id);
      continue;
    }
    const available = cat.available_quantity ?? 0;
    if (item.quantity > available) {
      errors.push(
        'Stock insuficiente para: ' + item.product_id +
        ' (disponible: ' + available + ')'
      );
      continue;
    }
    const unitPrice = Math.round(cat.price);
    snapshot.push({
      product_id:                  item.product_id,
      title:                       cat.title || '',
      unit_price_uyu:              unitPrice,
      quantity:                    item.quantity,
      line_total_uyu:              unitPrice * item.quantity,
      image_url:                   cat.thumbnail || (cat.pictures?.[0]?.url) || null,
      observed_available_quantity: available,
    });
  }

  return { errors, snapshot };
}

export function calculateTotals(snapshotItems, deliveryType) {
  const productsTotal = snapshotItems.reduce((s, it) => s + it.line_total_uyu, 0);
  let pickupDiscount = 0;
  let shippingCost   = 0;
  if (deliveryType === 'pickup') {
    pickupDiscount = Math.min(RETIRO_DISCOUNT, productsTotal);
  } else {
    shippingCost = productsTotal < FREE_SHIPPING_THRESHOLD ? SHIPPING_COST : 0;
  }
  const payableTotal = Math.max(0, productsTotal - pickupDiscount + shippingCost);
  return { productsTotal, pickupDiscount, shippingCost, payableTotal };
}

export function generateFingerprint(body, consolidatedItems) {
  const obj = {
    items:         consolidatedItems,
    delivery_type: body.delivery_type,
    buyer: {
      name:  (body.buyer?.name  || '').trim(),
      phone: (body.buyer?.phone || '').trim(),
    },
  };
  if (body.delivery_type === 'shipping' && body.shipping) {
    const s = body.shipping;
    obj.shipping = {
      address:        (s.address    || '').trim(),
      locality:       (s.locality   || '').trim(),
      department:     (s.department || '').trim(),
      requested_date: s.requested_date || '',
      requested_from: s.requested_from || '',
      requested_to:   s.requested_to   || '',
    };
  }
  return JSON.stringify(obj);
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generatePublicCode(now = new Date()) {
  const yy = String(now.getUTCFullYear()).slice(2);
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  let suffix = '';
  for (let i = 0; i < 6; i++) suffix += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return `AL-${yy}${mm}${dd}-${suffix}`;
}
