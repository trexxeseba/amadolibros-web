export const RETIRO_DISCOUNT       = 150;
export const SHIPPING_COST         = 250;
export const FREE_SHIPPING_THRESHOLD = 2000;

export function validateBody(body) {
  if (!body || typeof body !== 'object') return 'Body inválido.';
  if (!body.idempotency_key || typeof body.idempotency_key !== 'string' || !body.idempotency_key.trim()) {
    return 'Falta idempotency_key.';
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return 'El carrito está vacío.';
  }
  if (!['pickup', 'shipping'].includes(body.delivery_type)) {
    return 'delivery_type inválido.';
  }
  if (body.delivery_type === 'shipping') {
    if (!body.delivery_address || !body.delivery_address.trim()) {
      return 'Falta la dirección de entrega.';
    }
    if (!body.delivery_departamento || !body.delivery_departamento.trim()) {
      return 'Falta el departamento.';
    }
  }
  for (const item of body.items) {
    if (!item.id || typeof item.id !== 'string') return 'Item con id inválido.';
    if (!Number.isFinite(item.price) || item.price <= 0) return 'Item con precio inválido.';
    if (!Number.isInteger(item.quantity) || item.quantity < 1) return 'Item con cantidad inválida.';
  }
  return null;
}

export function calculateTotals(items, deliveryType) {
  const subtotal = items.reduce((sum, it) => sum + it.price * it.quantity, 0);
  let discount = 0;
  let shipping = 0;
  if (deliveryType === 'pickup') {
    discount = Math.min(RETIRO_DISCOUNT, subtotal);
  } else {
    shipping = subtotal < FREE_SHIPPING_THRESHOLD ? SHIPPING_COST : 0;
  }
  const total = Math.max(0, subtotal - discount + shipping);
  return { subtotal, discount, shipping, total };
}

export function validateCartAgainstCatalog(cartItems, catalogItems) {
  const byId = {};
  for (const ci of catalogItems) byId[ci.id] = ci;
  const errors = [];
  for (const item of cartItems) {
    const cat = byId[item.id];
    if (!cat) {
      errors.push('Producto no encontrado: ' + item.id);
      continue;
    }
    if (Math.round(cat.price) !== Math.round(item.price)) {
      errors.push('Precio incorrecto para: ' + item.id);
    }
    const available = (cat.available_quantity != null) ? cat.available_quantity : (cat.stock ?? 0);
    if (item.quantity > available) {
      errors.push('Stock insuficiente para: ' + item.id);
    }
  }
  return errors;
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
