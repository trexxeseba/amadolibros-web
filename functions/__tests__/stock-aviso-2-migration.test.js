import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const migration = readFileSync(path.join(ROOT, 'migrations/0007_stock_waitlist_customer_notification.sql'), 'utf8');

test('stock-aviso-2: migración agrega outbox sin tocar pedidos', () => {
  assert.match(migration, /customer_notification_status/);
  assert.match(migration, /customer_notification_id/);
  assert.match(migration, /last_notification_attempt_at/);
  assert.doesNotMatch(migration, /ALTER TABLE\s+(orders|order_items|order_events)/i);
  assert.doesNotMatch(migration, /DROP TABLE/i);
});
