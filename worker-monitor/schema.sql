-- Base exclusiva de monitoreo. Preparada; no ejecutar en ORDERS_DB.
CREATE TABLE IF NOT EXISTS monitor_events (
  delivery_id TEXT PRIMARY KEY,
  check_id TEXT NOT NULL,
  environment TEXT NOT NULL CHECK(environment IN ('preview', 'production')),
  component TEXT NOT NULL,
  page_path TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('confirmed', 'degraded', 'recovered')),
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  payload_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS monitor_events_check_time ON monitor_events(environment, check_id, occurred_at);
