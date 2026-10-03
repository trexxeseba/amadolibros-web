-- INFORME-ANALITICO: resumen de lo que cambió en cada sync del catálogo
-- activo (altas, bajas, cambios de precio y de stock). Antes catalog.json se
-- sobrescribía sin dejar rastro. Una fila por corrida; los ejemplos van en
-- JSON acotado para que la fila no crezca con el catálogo.
CREATE TABLE IF NOT EXISTS catalog_sync_log (
  id                 TEXT    PRIMARY KEY,
  synced_at          TEXT    NOT NULL,
  total_items        INTEGER NOT NULL CHECK (total_items >= 0),
  available_items    INTEGER NOT NULL CHECK (available_items >= 0),
  previous_total     INTEGER,
  added              INTEGER NOT NULL DEFAULT 0,
  removed            INTEGER NOT NULL DEFAULT 0,
  price_up           INTEGER NOT NULL DEFAULT 0,
  price_down         INTEGER NOT NULL DEFAULT 0,
  out_of_stock       INTEGER NOT NULL DEFAULT 0,
  back_in_stock      INTEGER NOT NULL DEFAULT 0,
  baseline           INTEGER NOT NULL DEFAULT 0 CHECK (baseline IN (0,1)),
  samples_json       TEXT
);
CREATE INDEX IF NOT EXISTS idx_catalog_sync_log_synced_at ON catalog_sync_log (synced_at);
