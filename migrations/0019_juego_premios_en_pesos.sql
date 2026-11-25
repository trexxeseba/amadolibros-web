-- JUEGO-3: los premios de la Rueda y del Acertijo pasan a ser montos en pesos
-- ($150 a $450 de descuento). Los códigos ya emitidos con porcentaje siguen
-- siendo válidos: discount_pct queda como dato histórico y ahora es opcional.
-- SQLite no permite cambiar una restricción CHECK, así que se reconstruye la tabla.
DROP TABLE IF EXISTS juego_codigos_nueva;
CREATE TABLE juego_codigos_nueva (
  code          TEXT PRIMARY KEY,
  origen        TEXT NOT NULL CHECK (origen IN ('rueda','acertijo')),
  discount_pct  INTEGER CHECK (discount_pct BETWEEN 1 AND 25),
  monto_uyu     INTEGER CHECK (monto_uyu BETWEEN 1 AND 5000),
  regalo        TEXT,
  wa_hash       TEXT NOT NULL,
  dia           TEXT NOT NULL,
  ip_hash       TEXT,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  used_at       TEXT,
  CHECK (discount_pct IS NOT NULL OR monto_uyu IS NOT NULL)
);
INSERT INTO juego_codigos_nueva (code, origen, discount_pct, regalo, wa_hash, dia, ip_hash, created_at, expires_at, used_at)
  SELECT code, origen, discount_pct, regalo, wa_hash, dia, ip_hash, created_at, expires_at, used_at FROM juego_codigos;
DROP TABLE juego_codigos;
ALTER TABLE juego_codigos_nueva RENAME TO juego_codigos;

CREATE UNIQUE INDEX IF NOT EXISTS idx_juego_codigos_un_giro_diario
  ON juego_codigos (wa_hash, dia) WHERE origen = 'rueda';
CREATE UNIQUE INDEX IF NOT EXISTS idx_juego_codigos_un_acertijo_diario
  ON juego_codigos (wa_hash, dia) WHERE origen = 'acertijo';
CREATE INDEX IF NOT EXISTS idx_juego_codigos_ip ON juego_codigos (ip_hash, created_at);
