-- JUEGO-1: códigos de descuento que entrega La Rueda del Librero (y, más adelante,
-- El Acertijo). El premio lo decide siempre el servidor.
-- Del número de WhatsApp se guarda solo un hash (con el día), nunca el número.
-- ip_hash es un SHA-256 diario (IP + fecha), solo para limitar abusos.
CREATE TABLE IF NOT EXISTS juego_codigos (
  code          TEXT PRIMARY KEY,
  origen        TEXT NOT NULL CHECK (origen IN ('rueda','acertijo')),
  discount_pct  INTEGER NOT NULL CHECK (discount_pct BETWEEN 1 AND 25),
  regalo        TEXT,
  wa_hash       TEXT NOT NULL,
  dia           TEXT NOT NULL,
  ip_hash       TEXT,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  used_at       TEXT
);

-- Un giro de la Rueda por día y por número.
CREATE UNIQUE INDEX IF NOT EXISTS idx_juego_codigos_un_giro_diario
  ON juego_codigos (wa_hash, dia) WHERE origen = 'rueda';
CREATE INDEX IF NOT EXISTS idx_juego_codigos_ip ON juego_codigos (ip_hash, created_at);
