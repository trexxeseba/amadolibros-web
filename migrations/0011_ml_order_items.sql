-- RADAR DATA 2 (#276): ventas reales de Mercado Libre por publicación.
--
-- Fuente: API oficial de órdenes del seller. Esta tabla NO contiene PII de
-- compradores: no se guardan buyer, teléfono, email ni dirección.
--
-- Una fila representa un item_id dentro de una order_id. El upsert es
-- idempotente por (order_id, item_id), de modo que una orden actualizada puede
-- reobservarse sin duplicar ventas.
CREATE TABLE IF NOT EXISTS ml_order_items (
  order_id          TEXT    NOT NULL,
  item_id           TEXT    NOT NULL,
  quantity          INTEGER NOT NULL CHECK (quantity > 0),
  unit_price        REAL    NOT NULL CHECK (unit_price >= 0),
  gross_price       REAL,
  currency_id       TEXT,
  order_status      TEXT    NOT NULL,
  date_created      TEXT    NOT NULL,
  date_closed       TEXT,
  date_last_updated TEXT,
  commercial_date   TEXT    NOT NULL,
  observed_at       TEXT    NOT NULL,
  PRIMARY KEY (order_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_ml_order_items_item_date
  ON ml_order_items (item_id, commercial_date);
CREATE INDEX IF NOT EXISTS idx_ml_order_items_status_date
  ON ml_order_items (order_status, commercial_date);

-- Cobertura de la ingesta. Permite distinguir "0 ventas" de "todavía no
-- observamos completamente esa ventana". Un único row id=1 describe el
-- backfill/mantenimiento más reciente.
CREATE TABLE IF NOT EXISTS ml_sales_sync_state (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  coverage_from     TEXT,
  coverage_to       TEXT,
  last_sync_at      TEXT    NOT NULL,
  last_status       TEXT    NOT NULL,
  last_order_count  INTEGER NOT NULL DEFAULT 0,
  last_item_rows    INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT
);
