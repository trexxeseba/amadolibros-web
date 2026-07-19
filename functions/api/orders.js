import { fetchCatalog } from '../_shared/catalog.js';
import {
  validateBody,
  calculateTotals,
  validateCartAgainstCatalog,
  generatePublicCode,
} from './_orders_logic.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'JSON inválido.' }, 400);
  }

  const validationError = validateBody(body);
  if (validationError) return json({ error: validationError }, 400);

  const catalog = await fetchCatalog(context);
  if (!catalog || !Array.isArray(catalog.items)) {
    return json({ error: 'Catálogo no disponible. Intentá de nuevo en unos segundos.' }, 503);
  }

  const catalogErrors = validateCartAgainstCatalog(body.items, catalog.items);
  if (catalogErrors.length > 0) {
    return json({ error: 'Carrito inválido.', details: catalogErrors }, 422);
  }

  const { subtotal, discount, shipping, total } = calculateTotals(body.items, body.delivery_type);

  const db = env.ORDERS_DB;

  // Generar public_code con reintento en colisión
  let publicCode = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generatePublicCode();
    const existing = await db.prepare('SELECT id FROM orders WHERE public_code = ?').bind(candidate).first();
    if (!existing) { publicCode = candidate; break; }
  }
  if (!publicCode) return json({ error: 'Error interno. Intentá de nuevo.' }, 500);

  // Insertar orden; la clave UNIQUE en idempotency_key maneja repeticiones
  let orderId;
  try {
    const result = await db.prepare(`
      INSERT INTO orders (
        idempotency_key, public_code, delivery_type, buyer_name, buyer_phone,
        delivery_address, delivery_barrio, delivery_departamento,
        delivery_date, delivery_time,
        subtotal_uyu, discount_uyu, shipping_uyu, total_uyu
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `).bind(
      body.idempotency_key,
      publicCode,
      body.delivery_type,
      body.buyer_name            || null,
      body.buyer_phone           || null,
      body.delivery_address      || null,
      body.delivery_barrio       || null,
      body.delivery_departamento || null,
      body.delivery_date         || null,
      body.delivery_time         || null,
      subtotal, discount, shipping, total
    ).first();
    orderId = result.id;
  } catch (insertErr) {
    if (String(insertErr).includes('UNIQUE constraint failed')) {
      const existing = await db.prepare(
        'SELECT id, public_code, total_uyu, status, created_at FROM orders WHERE idempotency_key = ?'
      ).bind(body.idempotency_key).first();
      if (existing) return json({ ...existing, already_exists: true }, 200);
    }
    console.error('[orders] insert error', insertErr);
    return json({ error: 'Error interno. Intentá de nuevo.' }, 500);
  }

  // Insertar items y evento de creación de forma atómica
  const itemStmts = body.items.map(it =>
    db.prepare(
      'INSERT INTO order_items (order_id, catalog_id, title, unit_price_uyu, quantity, subtotal_uyu) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(orderId, it.id, it.title, Math.round(it.price), it.quantity, Math.round(it.price * it.quantity))
  );
  const eventStmt = db.prepare(
    'INSERT INTO order_events (order_id, event_type, payload_json) VALUES (?, ?, ?)'
  ).bind(orderId, 'created', JSON.stringify({ delivery_type: body.delivery_type, subtotal, discount, shipping, total }));

  await db.batch([...itemStmts, eventStmt]);

  return json({ id: orderId, public_code: publicCode, total_uyu: total, status: 'pending' }, 201);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json;charset=UTF-8' },
  });
}
