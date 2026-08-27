-- RADAR-AMADO-1: alertas operativas derivadas del catálogo de Mercado Libre
-- y de stock_waitlist. Sólo lectura + análisis — esta tabla nunca dispara
-- cambios automáticos de precio ni de estado de publicación.
--
-- La clave primaria es determinística (alert_type + item_id) para que cada
-- corrida del cron actualice la misma fila en vez de crear una alerta nueva
-- por día. Si la condición que la generó desaparece, la fila pasa a
-- status='resolved' sin borrarse; si vuelve a aparecer, se reabre
-- conservando first_seen_at original.
CREATE TABLE IF NOT EXISTS radar_alerts (
  id                TEXT PRIMARY KEY,
  alert_type        TEXT NOT NULL CHECK (alert_type IN (
                       'REPOSICION_URGENTE',
                       'AGOTADO',
                       'PUBLICACION_PAUSADA',
                       'CORREGIR_ISBN',
                       'CLIENTES_ESPERANDO'
                     )),
  item_id           TEXT NOT NULL,
  isbn              TEXT,
  title             TEXT NOT NULL,
  severity          TEXT NOT NULL CHECK (severity IN ('low','medium','high')),
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  score             INTEGER,
  score_version     TEXT,
  reasons_json      TEXT NOT NULL,
  metrics_json      TEXT NOT NULL,
  first_seen_at     TEXT NOT NULL,
  last_seen_at      TEXT NOT NULL,
  resolved_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_radar_alerts_status_severity
  ON radar_alerts (status, severity);

CREATE INDEX IF NOT EXISTS idx_radar_alerts_item
  ON radar_alerts (item_id);
