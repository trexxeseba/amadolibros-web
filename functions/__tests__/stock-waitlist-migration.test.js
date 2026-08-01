import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const migration = readFileSync(
  path.join(ROOT, 'migrations', '0003_stock_waitlist.sql'),
  'utf8',
);

test('STOCK-1 crea una tabla independiente sin alterar tablas de pedidos', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS stock_waitlist/);
  assert.match(migration, /product_id\s+TEXT NOT NULL/);
  assert.match(migration, /email\s+TEXT NOT NULL COLLATE NOCASE/);
  assert.match(migration, /internal_notification_status/);
  assert.match(migration, /WHERE status = 'waiting'/);
  assert.doesNotMatch(migration, /ALTER TABLE\s+(orders|order_items|order_events)/i);
  assert.doesNotMatch(migration, /DROP TABLE/i);
  assert.doesNotMatch(migration, /REFERENCES\s+(orders|order_items|order_events)/i);
});
