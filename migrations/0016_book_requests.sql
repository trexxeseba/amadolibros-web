-- PEDIDO-LIBRO-1: pedidos de búsqueda de libros enviados desde /pedir-libro.
-- El formulario no pide datos personales: el contacto sigue por WhatsApp, con
-- el código del pedido en el mensaje para que el equipo lo encuentre acá.
-- ip_hash es un SHA-256 diario (IP + fecha), solo para limitar abusos.
CREATE TABLE IF NOT EXISTS book_requests (
  id            TEXT PRIMARY KEY,
  public_code   TEXT NOT NULL UNIQUE,
  request_type  TEXT NOT NULL,
  query         TEXT NOT NULL,
  author_isbn   TEXT,
  format        TEXT,
  language      TEXT,
  budget_uyu    INTEGER,
  details       TEXT,
  source_url    TEXT,
  status        TEXT NOT NULL DEFAULT 'received'
                  CHECK (status IN ('received','in_progress','answered','closed')),
  ip_hash       TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_book_requests_created_at ON book_requests (created_at);
CREATE INDEX IF NOT EXISTS idx_book_requests_ip_hash ON book_requests (ip_hash, created_at);
