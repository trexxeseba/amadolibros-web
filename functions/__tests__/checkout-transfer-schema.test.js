import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

function migration(name) {
  return readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
}

const productionDeploy = readFileSync(
  new URL('../../.github/workflows/deploy.yml', import.meta.url),
  'utf8',
);

function seedOrder(db) {
  db.prepare(`
    INSERT INTO orders (
      id, public_code, idempotency_key, request_fingerprint, status, payment_status,
      buyer_name, buyer_phone, delivery_type, address, locality, department,
      requested_delivery_date, requested_delivery_from, requested_delivery_to,
      products_total_uyu, pickup_discount_uyu, shipping_cost_uyu, payable_total_uyu,
      currency, created_at, expires_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    'order-old', 'AL-OLD', 'idem-old', '{}', 'open', 'not_started',
    'Ana', '099000000', 'shipping', 'Calle 1', 'Centro', 'Montevideo',
    '2026-08-10', '10:00', '12:00',
    1000, 0, 250, 1250, 'UYU',
    '2026-08-09T12:00:00.000Z', '2026-08-09T13:00:00.000Z', '2026-08-09T12:00:00.000Z',
  );
  db.prepare(`
    INSERT INTO order_items (
      id, order_id, product_id, title, quantity, unit_price_uyu,
      line_total_uyu, observed_available_quantity, created_at
    ) VALUES (?,?,?,?,?,?,?,?,?)
  `).run('item-old', 'order-old', 'book-1', 'Libro', 1, 1000, 1000, 1, '2026-08-09T12:00:00.000Z');
  db.prepare('INSERT INTO order_events (id,order_id,event_type,payload_json,created_at) VALUES (?,?,?,?,?)')
    .run('event-old', 'order-old', 'created', '{}', '2026-08-09T12:00:00.000Z');
}

test('migración 0005 preserva pedidos y permite coordinar fecha por WhatsApp', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(migration('0001_orders.sql'));
  db.exec(migration('0002_orders_shipping_date_montevideo.sql'));
  seedOrder(db);

  db.exec(migration('0005_orders_delivery_coordination.sql'));

  assert.equal(db.prepare('SELECT count(*) AS n FROM orders').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM order_items').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM order_events').get().n, 1);

  assert.doesNotThrow(() => {
    db.prepare(`
      INSERT INTO orders (
        id, public_code, idempotency_key, request_fingerprint,
        buyer_name, buyer_phone, delivery_type, address, locality, department,
        products_total_uyu, pickup_discount_uyu, shipping_cost_uyu, payable_total_uyu,
        created_at, expires_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      'order-new', 'AL-NEW', 'idem-new', '{}',
      'Carlos', '098000000', 'shipping', 'Calle 2', 'Cordón', 'Montevideo',
      2000, 0, 0, 2000,
      '2026-08-09T12:00:00.000Z', '2026-08-09T13:00:00.000Z', '2026-08-09T12:00:00.000Z',
    );
  });

  assert.throws(() => {
    db.prepare(`
      INSERT INTO orders (
        id, public_code, idempotency_key, request_fingerprint,
        buyer_name, buyer_phone, delivery_type, address, locality, department,
        products_total_uyu, pickup_discount_uyu, shipping_cost_uyu, payable_total_uyu,
        created_at, expires_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      'order-bad', 'AL-BAD', 'idem-bad', '{}',
      'Sin localidad', '097000000', 'shipping', 'Calle 3', null, 'Montevideo',
      2000, 0, 0, 2000,
      '2026-08-09T12:00:00.000Z', '2026-08-09T13:00:00.000Z', '2026-08-09T12:00:00.000Z',
    );
  });
});

test('deploy productivo aplica migraciones D1 antes de publicar Pages', () => {
  const migrationStep = productionDeploy.indexOf('d1 migrations apply');
  const pagesDeployStep = productionDeploy.indexOf('pages deploy ./astro-front/dist');

  assert.notEqual(migrationStep, -1, 'el deploy debe aplicar migraciones D1');
  assert.notEqual(pagesDeployStep, -1, 'el deploy debe publicar Pages');
  assert.ok(migrationStep < pagesDeployStep, 'D1 debe migrarse antes de publicar el frontend');
  assert.match(productionDeploy, /amadolibros-orders-production --remote/);
});
