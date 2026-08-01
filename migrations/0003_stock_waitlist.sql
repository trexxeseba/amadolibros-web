-- STOCK-1: lista de espera independiente de pedidos y pagos.
-- Esta tabla no referencia orders, order_items ni order_events.

CREATE TABLE IF NOT EXISTS stock_waitlist (
  id                           TEXT PRIMARY KEY,
  product_id                   TEXT NOT NULL,
  product_title                TEXT NOT NULL,
  email                        TEXT NOT NULL COLLATE NOCASE,
  status                       TEXT NOT NULL DEFAULT 'waiting'
                                 CHECK (status IN ('waiting','notified','cancelled')),
  source_url                   TEXT,
  internal_notification_status TEXT NOT NULL DEFAULT 'pending'
                                 CHECK (internal_notification_status IN ('pending','sent','failed','skipped')),
  internal_notification_id     TEXT,
  internal_notification_error  TEXT,
  created_at                   TEXT NOT NULL,
  updated_at                   TEXT NOT NULL,
  restocked_at                 TEXT,
  notified_at                  TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_waitlist_waiting_email_product
  ON stock_waitlist (product_id, lower(email))
  WHERE status = 'waiting';

CREATE INDEX IF NOT EXISTS idx_stock_waitlist_status_created
  ON stock_waitlist (status, created_at);
