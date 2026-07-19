-- Migration 0001: tablas de órdenes para amadolibros.com
-- Aplicar con: wrangler d1 execute ORDERS_DB --file migrations/0001_orders.sql

CREATE TABLE IF NOT EXISTS orders (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key       TEXT    NOT NULL,
  public_code           TEXT    NOT NULL,
  delivery_type         TEXT    NOT NULL CHECK (delivery_type IN ('pickup', 'shipping')),
  buyer_name            TEXT,
  buyer_phone           TEXT,
  delivery_address      TEXT,
  delivery_barrio       TEXT,
  delivery_departamento TEXT,
  delivery_date         TEXT,
  delivery_time         TEXT,
  subtotal_uyu          INTEGER NOT NULL CHECK (subtotal_uyu >= 0),
  discount_uyu          INTEGER NOT NULL DEFAULT 0 CHECK (discount_uyu >= 0),
  shipping_uyu          INTEGER NOT NULL DEFAULT 0 CHECK (shipping_uyu >= 0),
  total_uyu             INTEGER NOT NULL CHECK (total_uyu >= 0),
  status                TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'cancelled')),
  created_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_idempotency ON orders (idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_public_code ON orders (public_code);
CREATE        INDEX IF NOT EXISTS idx_orders_created_at  ON orders (created_at);

CREATE TABLE IF NOT EXISTS order_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id       INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  catalog_id     TEXT    NOT NULL,
  title          TEXT    NOT NULL,
  unit_price_uyu INTEGER NOT NULL CHECK (unit_price_uyu > 0),
  quantity       INTEGER NOT NULL CHECK (quantity > 0),
  subtotal_uyu   INTEGER NOT NULL CHECK (subtotal_uyu > 0)
);

CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items (order_id);

CREATE TABLE IF NOT EXISTS order_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id     INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  event_type   TEXT    NOT NULL,
  payload_json TEXT,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_order_events_order_id ON order_events (order_id);
