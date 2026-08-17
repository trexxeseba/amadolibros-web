import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

test('migración 0008 preserva órdenes y agrega atribución GA4 opcional', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../../migrations/0001_orders.sql', import.meta.url), 'utf8'));
  db.prepare(`
    INSERT INTO orders (
      id,public_code,idempotency_key,request_fingerprint,buyer_name,buyer_phone,
      delivery_type,products_total_uyu,pickup_discount_uyu,shipping_cost_uyu,
      payable_total_uyu,created_at,expires_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    'old-order','AL-OLD','idem-old','{}','Ana','099','pickup',1000,150,0,850,
    '2026-06-05T12:00:00Z','2026-06-05T13:00:00Z','2026-06-05T12:00:00Z',
  );
  db.exec(readFileSync(new URL('../../migrations/0008_orders_ga4_attribution.sql', import.meta.url), 'utf8'));

  const oldOrder = db.prepare(
    'SELECT ga_client_id,ga_session_id FROM orders WHERE id=?'
  ).get('old-order');
  assert.equal(oldOrder.ga_client_id, null);
  assert.equal(oldOrder.ga_session_id, null);
  db.prepare('UPDATE orders SET ga_client_id=?,ga_session_id=? WHERE id=?')
    .run('123.456', 1786921140, 'old-order');
  assert.deepEqual(
    { ...db.prepare('SELECT ga_client_id,ga_session_id FROM orders WHERE id=?').get('old-order') },
    { ga_client_id: '123.456', ga_session_id: 1786921140 },
  );
});
