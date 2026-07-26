export const RETIRO_DISCOUNT         = 150;
export const SHIPPING_COST           = 250;
export const FREE_SHIPPING_THRESHOLD = 2000;
export const EXPIRY_MINUTES          = 60;
export const MAX_BODY_BYTES          = 32 * 1024;
export const MAX_ITEMS               = 20;
export const MAX_QUANTITY_PER_ITEM   = 99;
export const MAX_IDEMPOTENCY_KEY_LEN = 128;
export const MAX_PRODUCT_ID_LEN      = 120;
export const MAX_NAME_LEN            = 120;
export const MAX_PHONE_LEN           = 40;
export const MAX_ADDRESS_LEN         = 200;
export const MAX_LOCALITY_LEN        = 120;
export const MAX_DEPARTMENT_LEN      = 80;
export const MAX_NOTES_LEN           = 500;
export const BUSINESS_TIME_ZONE      = 'America/Montevideo';

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidDateString(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

function isValidTimeString(value) {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) return false;
  const [hour, minute] = value.split(':').map(Number);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

// Fecha y horario de entrega solo aplican al envío dentro de Montevideo
// (cadete propio, franja coordinada) — el interior se coordina con la
// agencia de envíos según destino, sin franja fija (2-K-C). Comparación
// normalizada (trim + minúsculas) para no depender de cómo llegue el string.
export function isMontevideoDepartment(department) {
  return typeof department === 'string' && department.trim().toLowerCase() === 'montevideo';
}

export function validateBody(body) {
  if (!isRecord(body)) return 'Body inválido.';

  if (!isNonEmptyString(body.idempotency_key)) return 'Falta idempotency_key.';
  if (body.idempotency_key.trim().length > MAX_IDEMPOTENCY_KEY_LEN) {
    return 'idempotency_key demasiado largo.';
  }

  if (!Array.isArray(body.items) || body.items.length === 0) return 'El carrito está vacío.';
  if (body.items.length > MAX_ITEMS) return 'Demasiados productos (máx. ' + MAX_ITEMS + ').';

  for (const item of body.items) {
    if (!isRecord(item)) return 'Item inválido.';
    if (!isNonEmptyString(item.product_id)) return 'product_id inválido.';
    if (item.product_id.trim().length > MAX_PRODUCT_ID_LEN) return 'product_id demasiado largo.';
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_QUANTITY_PER_ITEM) {
      return 'Cantidad inválida.';
    }
  }

  if (!['pickup', 'shipping'].includes(body.delivery_type)) return 'delivery_type inválido.';

  if (!isRecord(body.buyer)) return 'Falta buyer.';
  if (!isNonEmptyString(body.buyer.name)) return 'Nombre del comprador requerido.';
  if (body.buyer.name.trim().length > MAX_NAME_LEN) return 'Nombre demasiado largo.';
  if (!isNonEmptyString(body.buyer.phone)) return 'Teléfono del comprador requerido.';
  if (body.buyer.phone.trim().length > MAX_PHONE_LEN) return 'Teléfono demasiado largo.';

  if (body.delivery_type === 'shipping') {
    if (!isRecord(body.shipping)) return 'Falta shipping.';
    const shipping = body.shipping;

    if (!isNonEmptyString(shipping.address)) return 'Dirección requerida.';
    if (shipping.address.trim().length > MAX_ADDRESS_LEN) return 'Dirección demasiado larga.';

    if (!isNonEmptyString(shipping.locality)) return 'Localidad requerida.';
    if (shipping.locality.trim().length > MAX_LOCALITY_LEN) return 'Localidad demasiado larga.';

    if (!isNonEmptyString(shipping.department)) return 'Departamento requerido.';
    if (shipping.department.trim().length > MAX_DEPARTMENT_LEN) return 'Departamento demasiado largo.';

    if (isMontevideoDepartment(shipping.department)) {
      if (!isValidDateString(shipping.requested_date)) return 'Fecha inválida (formato YYYY-MM-DD).';
      if (!isValidTimeString(shipping.requested_from)) return 'Hora desde inválida (formato HH:MM).';
      if (!isValidTimeString(shipping.requested_to)) return 'Hora hasta inválida (formato HH:MM).';
    }

    if (shipping.notes !== undefined && shipping.notes !== null) {
      if (typeof shipping.notes !== 'string') return 'Notas inválidas.';
      if (shipping.notes.trim().length > MAX_NOTES_LEN) return 'Notas demasiado largas.';
    }
  }

  return null;
}

export function dateInTimeZone(now, timeZone = BUSINESS_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function validateShippingDate(requestedDate, requestedFrom, requestedTo, now) {
  const today = dateInTimeZone(now);
  if (requestedDate < today) return 'La fecha solicitada ya pasó.';
  if (requestedTo <= requestedFrom) return 'La hora de fin debe ser posterior a la hora de inicio.';
  return null;
}

export function consolidateItems(items) {
  const byProduct = new Map();
  for (const item of items) {
    const productId = item.product_id.trim();
    if (byProduct.has(productId)) {
      byProduct.get(productId).quantity += item.quantity;
    } else {
      byProduct.set(productId, { product_id: productId, quantity: item.quantity });
    }
  }
  return Array.from(byProduct.values()).sort((a, b) => a.product_id.localeCompare(b.product_id));
}

export function buildSnapshot(consolidatedItems, catalogItems) {
  const byId = new Map();
  for (const catalogItem of catalogItems) {
    if (isRecord(catalogItem) && typeof catalogItem.id === 'string') {
      byId.set(catalogItem.id, catalogItem);
    }
  }

  const errors = [];
  const snapshot = [];

  for (const item of consolidatedItems) {
    const catalogItem = byId.get(item.product_id);
    if (!catalogItem) {
      errors.push('Producto no encontrado: ' + item.product_id);
      continue;
    }
    if (catalogItem.status && catalogItem.status !== 'active') {
      errors.push('Producto no disponible: ' + item.product_id);
      continue;
    }

    const available = Number(catalogItem.available_quantity);
    if (!Number.isInteger(available) || available < 0) {
      errors.push('Stock inválido para: ' + item.product_id);
      continue;
    }
    if (item.quantity > available) {
      errors.push(
        'Stock insuficiente para: ' + item.product_id +
        ' (disponible: ' + available + ')'
      );
      continue;
    }

    const rawPrice = Number(catalogItem.price);
    if (!Number.isFinite(rawPrice) || rawPrice <= 0) {
      errors.push('Precio inválido para: ' + item.product_id);
      continue;
    }

    const unitPrice = Math.round(rawPrice);
    const title = typeof catalogItem.title === 'string' ? catalogItem.title : '';
    const imageUrl = typeof catalogItem.thumbnail === 'string'
      ? catalogItem.thumbnail
      : (typeof catalogItem.pictures?.[0]?.url === 'string' ? catalogItem.pictures[0].url : null);

    snapshot.push({
      product_id: item.product_id,
      title,
      unit_price_uyu: unitPrice,
      quantity: item.quantity,
      line_total_uyu: unitPrice * item.quantity,
      image_url: imageUrl,
      observed_available_quantity: available,
    });
  }

  return { errors, snapshot };
}

export function calculateTotals(snapshotItems, deliveryType) {
  const productsTotal = snapshotItems.reduce((sum, item) => sum + item.line_total_uyu, 0);
  let pickupDiscount = 0;
  let shippingCost = 0;

  if (deliveryType === 'pickup') {
    pickupDiscount = Math.min(RETIRO_DISCOUNT, productsTotal);
  } else {
    shippingCost = productsTotal < FREE_SHIPPING_THRESHOLD ? SHIPPING_COST : 0;
  }

  const payableTotal = Math.max(0, productsTotal - pickupDiscount + shippingCost);
  return { productsTotal, pickupDiscount, shippingCost, payableTotal };
}

export function generateFingerprint(body, consolidatedItems) {
  const fingerprint = {
    items: consolidatedItems,
    delivery_type: body.delivery_type,
    buyer: {
      name: body.buyer.name.trim(),
      phone: body.buyer.phone.trim(),
    },
  };

  if (body.delivery_type === 'shipping') {
    const montevideo = isMontevideoDepartment(body.shipping.department);
    fingerprint.shipping = {
      address: body.shipping.address.trim(),
      locality: body.shipping.locality.trim(),
      department: body.shipping.department.trim(),
      // Fuera de Montevideo estos campos no aplican — se fija null acá para
      // que el fingerprint sea consistente con lo que realmente se persiste.
      requested_date: montevideo ? body.shipping.requested_date : null,
      requested_from: montevideo ? body.shipping.requested_from : null,
      requested_to: montevideo ? body.shipping.requested_to : null,
      notes: typeof body.shipping.notes === 'string' ? body.shipping.notes.trim() : '',
    };
  }

  return JSON.stringify(fingerprint);
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generatePublicCode(now = new Date()) {
  const localDate = dateInTimeZone(now).replaceAll('-', '').slice(2);
  let suffix = '';
  for (let index = 0; index < 6; index++) {
    suffix += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return `AL-${localDate}-${suffix}`;
}
