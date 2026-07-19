-- Migration 0001: tablas de órdenes para amadolibros.com
-- Aplicar con: wrangler d1 execute ORDERS_DB --file migrations/0001_orders.sql

CREATE TABLE IF NOT EXISTS orders (
  id                        TEXT    PRIMARY KEY,
  public_code               TEXT    UNIQUE NOT NULL,
  idempotency_key           TEXT    UNIQUE NOT NULL,
  request_fingerprint       TEXT    NOT NULL,
  status                    TEXT    NOT NULL DEFAULT 'open'
                              CHECK (status IN ('open','paid','cancelled','expired','fulfilled')),
  payment_status            TEXT    NOT NULL DEFAULT 'not_started'
                              CHECK (payment_status IN ('not_started','pending','approved','rejected','refunded','cancelled')),
  buyer_name                TEXT    NOT NULL,
  buyer_phone               TEXT    NOT NULL,
  delivery_type             TEXT    NOT NULL CHECK (delivery_type IN ('pickup','shipping')),
  address                   TEXT,
  locality                  TEXT,
  department                TEXT,
  requested_delivery_date   TEXT,
  requested_delivery_from   TEXT,
  requested_delivery_to     TEXT,
  delivery_notes            TEXT,
  products_total_uyu        INTEGER NOT NULL CHECK (products_total_uyu >= 0),
  pickup_discount_uyu       INTEGER NOT NULL DEFAULT 0 CHECK (pickup_discount_uyu >= 0),
  shipping_cost_uyu         INTEGER NOT NULL DEFAULT 0 CHECK (shipping_cost_uyu >= 0),
  payable_total_uyu         INTEGER NOT NULL CHECK (payable_total_uyu >= 0),
  currency                  TEXT    NOT NULL DEFAULT 'UYU',
  payment_provider          TEXT,
  payment_preference_id     TEXT,
  payment_id                TEXT,
  created_at                TEXT    NOT NULL,
  expires_at                TEXT    NOT NULL,
  updated_at                TEXT    NOT NULL,
  paid_at                   TEXT,
  fulfilled_at              TEXT,
  cancelled_at              TEXT
);

CREATE INDEX IF NOT EXISTS idx_orders_status         ON orders (status);
CREATE INDEX IF NOT EXISTS idx_orders_payment_status ON orders (payment_status);
CREATE INDEX IF NOT EXISTS idx_orders_expires_at     ON orders (expires_at);

CREATE TABLE IF NOT EXISTS order_items (
  id                          TEXT    PRIMARY KEY,
  order_id                    TEXT    NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id                  TEXT    NOT NULL,
  title                       TEXT    NOT NULL,
  quantity                    INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_uyu              INTEGER NOT NULL CHECK (unit_price_uyu > 0),
  line_total_uyu              INTEGER NOT NULL CHECK (line_total_uyu > 0),
  image_url                   TEXT,
  observed_available_quantity INTEGER,
  created_at                  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items (order_id);

CREATE TABLE IF NOT EXISTS order_events (
  id           TEXT    PRIMARY KEY,
  order_id     TEXT    NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  event_type   TEXT    NOT NULL,
  payload_json TEXT,
  created_at   TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_order_events_order_id ON order_events (order_id);
