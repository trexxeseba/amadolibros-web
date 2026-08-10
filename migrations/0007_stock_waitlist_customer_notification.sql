-- STOCK-AVISO-2: estado durable del correo automático al cliente.
ALTER TABLE stock_waitlist ADD COLUMN customer_notification_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (customer_notification_status IN ('pending','sending','sent','failed','skipped'));
ALTER TABLE stock_waitlist ADD COLUMN customer_notification_id TEXT;
ALTER TABLE stock_waitlist ADD COLUMN customer_notification_error TEXT;
ALTER TABLE stock_waitlist ADD COLUMN customer_notification_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stock_waitlist ADD COLUMN last_notification_attempt_at TEXT;

CREATE INDEX IF NOT EXISTS idx_stock_waitlist_customer_pending
  ON stock_waitlist (status, customer_notification_status, created_at);
