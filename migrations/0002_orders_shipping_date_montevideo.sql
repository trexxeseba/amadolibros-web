-- 2-K-C: fecha y horario de entrega (requested_delivery_date/from/to) solo
-- aplican al envío dentro de Montevideo (cadete propio, franja coordinada).
-- El interior se coordina con la agencia de envíos según destino, sin
-- franja fija — esos tres campos deben poder quedar NULL para
-- delivery_type = 'shipping' cuando department no es Montevideo.
--
-- SQLite no permite alterar un CHECK existente con ALTER TABLE: se
-- reconstruye la tabla `orders`. Probado localmente: `PRAGMA foreign_keys
-- = OFF` no evita que un DROP TABLE orders dispare ON DELETE CASCADE sobre
-- order_items/order_events en D1 (el pragma no persiste de forma
-- confiable entre statements). Para no arriesgar datos, se reconstruyen
-- las tres tablas en tablas *_new, se copian los datos, y solo se
-- eliminan las tablas viejas (order_items/order_events primero, orders al
-- final) una vez que las copias nuevas ya existen — así una posible
-- cascada sobre las tablas viejas nunca puede borrar datos que ya no
-- están solamente ahí.

CREATE TABLE orders_new (
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
      AND (
        lower(trim(department)) <> 'montevideo'
        OR (
          requested_delivery_date IS NOT NULL AND length(trim(requested_delivery_date)) > 0
          AND requested_delivery_from IS NOT NULL AND length(trim(requested_delivery_from)) > 0
          AND requested_delivery_to IS NOT NULL AND length(trim(requested_delivery_to)) > 0
        )
      )
    )
  )
);

INSERT INTO orders_new (
  id, public_code, idempotency_key, request_fingerprint, status, payment_status,
  buyer_name, buyer_phone, delivery_type,
  address, locality, department,
  requested_delivery_date, requested_delivery_from, requested_delivery_to,
  delivery_notes,
  products_total_uyu, pickup_discount_uyu, shipping_cost_uyu, payable_total_uyu,
  currency, payment_provider, payment_preference_id, payment_id,
  created_at, expires_at, updated_at, paid_at, fulfilled_at, cancelled_at
)
SELECT
  id, public_code, idempotency_key, request_fingerprint, status, payment_status,
  buyer_name, buyer_phone, delivery_type,
  address, locality, department,
  requested_delivery_date, requested_delivery_from, requested_delivery_to,
  delivery_notes,
  products_total_uyu, pickup_discount_uyu, shipping_cost_uyu, payable_total_uyu,
  currency, payment_provider, payment_preference_id, payment_id,
  created_at, expires_at, updated_at, paid_at, fulfilled_at, cancelled_at
FROM orders;

-- order_items y order_events no cambian de esquema — se recrean idénticos,
-- apuntando a orders_new, para poder eliminar las tablas viejas sin dejar
-- una ventana donde una fila dependa de una tabla a punto de borrarse.
CREATE TABLE order_items_new (
  id                          TEXT    PRIMARY KEY,
  order_id                    TEXT    NOT NULL REFERENCES orders_new(id) ON DELETE CASCADE,
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

INSERT INTO order_items_new (
  id, order_id, product_id, title, quantity, unit_price_uyu, line_total_uyu,
  image_url, observed_available_quantity, created_at
)
SELECT
  id, order_id, product_id, title, quantity, unit_price_uyu, line_total_uyu,
  image_url, observed_available_quantity, created_at
FROM order_items;

CREATE TABLE order_events_new (
  id           TEXT    PRIMARY KEY,
  order_id     TEXT    NOT NULL REFERENCES orders_new(id) ON DELETE CASCADE,
  event_type   TEXT    NOT NULL,
  payload_json TEXT,
  created_at   TEXT    NOT NULL
);

INSERT INTO order_events_new (id, order_id, event_type, payload_json, created_at)
SELECT id, order_id, event_type, payload_json, created_at
FROM order_events;

-- Se eliminan las tablas viejas: primero las hijas, luego el padre. Para
-- cuando se llega a "DROP TABLE orders", order_items/order_events (viejas)
-- ya no existen, así que no hay nada que una cascada pueda seguir borrando.
DROP TABLE order_items;
DROP TABLE order_events;
DROP TABLE orders;

ALTER TABLE orders_new       RENAME TO orders;
ALTER TABLE order_items_new  RENAME TO order_items;
ALTER TABLE order_events_new RENAME TO order_events;

CREATE INDEX IF NOT EXISTS idx_orders_status         ON orders (status);
CREATE INDEX IF NOT EXISTS idx_orders_payment_status ON orders (payment_status);
CREATE INDEX IF NOT EXISTS idx_orders_expires_at     ON orders (expires_at);
CREATE INDEX IF NOT EXISTS idx_order_items_order_id  ON order_items (order_id);
CREATE INDEX IF NOT EXISTS idx_order_events_order_id ON order_events (order_id);
