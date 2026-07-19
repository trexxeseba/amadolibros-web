PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS orders (
  id                        TEXT    PRIMARY KEY,
  public_code               TEXT    UNIQUE NOT NULL,
  idempotency_key           TEXT    UNIQUE NOT NULL,
  request_fingerprint       TEXT    NOT NULL,
  status                    TEXT    NOT NULL DEFAULT 'open'
                              CHECK (status IN ('open','paid','cancelled','expired','fulfilled')),
  payment_status            TEXT    NOT NULL DEFAULT 'not_started'
                              CHECK (payment_status IN ('not_started','pending','approved','rejected','refunded','cancelled')),
  buyer_name                TEXT    NOT NULL CHECK (length(trim(buyer_name)) > 0),
  buyer_phone               TEXT    NOT NULL CHECK (length(trim(buyer_phone)) > 0),
  delivery_type             TEXT    NOT NULL CHECK (delivery_type IN ('pickup','shipping')),
  address                   TEXT,
  locality                  TEXT,
  department                TEXT,
  requested_delivery_date   TEXT,
  requested_delivery_from   TEXT,
  requested_delivery_to     TEXT,
  delivery_notes            TEXT,
  products_total_uyu        INTEGER NOT NULL CHECK (products_total_uyu >= 0),
  pickup_discount_uyu       INTEGER NOT NULL DEFAULT 0 CHECK (pickup_discount_uyu BETWEEN 0 AND 150),
  shipping_cost_uyu         INTEGER NOT NULL DEFAULT 0 CHECK (shipping_cost_uyu IN (0,250)),
  payable_total_uyu         INTEGER NOT NULL CHECK (payable_total_uyu >= 0),
  currency                  TEXT    NOT NULL DEFAULT 'UYU' CHECK (currency = 'UYU'),
  payment_provider          TEXT,
  payment_preference_id     TEXT,
  payment_id                TEXT,
  created_at                TEXT    NOT NULL,
  expires_at                TEXT    NOT NULL,
  updated_at                TEXT    NOT NULL,
  paid_at                   TEXT,
  fulfilled_at              TEXT,
  cancelled_at              TEXT,
  CHECK (payable_total_uyu = products_total_uyu - pickup_discount_uyu + shipping_cost_uyu),
  CHECK (
    (delivery_type = 'pickup' AND shipping_cost_uyu = 0)
    OR
    (delivery_type = 'shipping' AND pickup_discount_uyu = 0)
  ),
  CHECK (
    delivery_type = 'pickup'
    OR (
      address IS NOT NULL AND length(trim(address)) > 0
      AND locality IS NOT NULL AND length(trim(locality)) > 0
      AND department IS NOT NULL AND length(trim(department)) > 0
      AND requested_delivery_date IS NOT NULL AND length(trim(requested_delivery_date)) > 0
      AND requested_delivery_from IS NOT NULL AND length(trim(requested_delivery_from)) > 0
      AND requested_delivery_to IS NOT NULL AND length(trim(requested_delivery_to)) > 0
    )
  )
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
  line_total_uyu              INTEGER NOT NULL CHECK (line_total_uyu = unit_price_uyu * quantity),
  image_url                   TEXT,
  observed_available_quantity INTEGER CHECK (observed_available_quantity IS NULL OR observed_available_quantity >= 0),
  created_at                  TEXT    NOT NULL,
  UNIQUE (order_id, product_id)
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
