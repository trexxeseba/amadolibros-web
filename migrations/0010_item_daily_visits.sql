-- RADAR DATA 1 (issue #275): serie diaria de visitas por publicación de
-- Mercado Libre. Guardamos un número compacto por día — nunca 7/30/90 ya
-- sumados — y derivamos esas ventanas por query (ver worker-sync/visits-store.js).
--
-- Clave primaria (item_id, visit_date): upsert idempotente. Un mismo día
-- puede reprocesarse varias veces (ML documenta hasta 48h de demora en
-- consolidar el conteo) sin crear filas duplicadas — la última escritura
-- gana y `observed_at` deja rastro de cuándo se escribió por última vez.
--
-- Ausencia de fila = dato no observado, nunca 0 inventado. Si Mercado Libre
-- no devuelve un item_id en la respuesta de /items/visits para un día dado,
-- no se escribe fila para ese día — no se asume que tuvo cero visitas.
CREATE TABLE IF NOT EXISTS item_daily_visits (
  item_id     TEXT NOT NULL,
  visit_date  TEXT NOT NULL, -- 'YYYY-MM-DD', día calendario que reporta Mercado Libre
  visits      INTEGER NOT NULL CHECK (visits >= 0),
  source      TEXT NOT NULL, -- procedencia: qué endpoint/función escribió esta fila
  observed_at TEXT NOT NULL, -- ISO timestamp de cuándo la escribimos (auditoría)
  PRIMARY KEY (item_id, visit_date)
);

CREATE INDEX IF NOT EXISTS idx_item_daily_visits_date ON item_daily_visits (visit_date);
