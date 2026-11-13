-- LIBRERO-1: asistente de «Ayudame a encontrarlo», que aparece cuando una
-- búsqueda del catálogo no da resultados.
--
-- librero_sessions   una por cada vez que alguien abre el asistente.
-- librero_events     lo que pasó dentro (qué se le mostró, qué tocó, si se fue).
-- librero_requests   el pedido armado para Amado, con el contacto que la persona
--                    quiso dejar. El mismo código (public_code) se copia también
--                    en book_requests para que el panel y el export actuales lo
--                    muestren sin cambios; el contacto vive solo acá.
--
-- ip_hash es un SHA-256 diario (IP + fecha), solo para limitar abusos.
CREATE TABLE IF NOT EXISTS librero_sessions (
  id             TEXT PRIMARY KEY,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  query          TEXT NOT NULL,
  candidate_ids  TEXT,
  catalog_ok     INTEGER NOT NULL DEFAULT 1,
  outcome        TEXT NOT NULL DEFAULT 'open'
                   CHECK (outcome IN ('open','clicked','request','left')),
  ip_hash        TEXT
);
CREATE INDEX IF NOT EXISTS idx_librero_sessions_created_at ON librero_sessions (created_at);
CREATE INDEX IF NOT EXISTS idx_librero_sessions_ip_hash ON librero_sessions (ip_hash, created_at);

CREATE TABLE IF NOT EXISTS librero_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  type        TEXT NOT NULL,
  payload     TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_librero_events_session ON librero_events (session_id, id);

CREATE TABLE IF NOT EXISTS librero_requests (
  id                      TEXT PRIMARY KEY,
  public_code             TEXT NOT NULL UNIQUE,
  session_id              TEXT NOT NULL,
  idempotency_key         TEXT NOT NULL UNIQUE,
  query                   TEXT NOT NULL,
  accepts_used            INTEGER,
  accepts_other_edition   INTEGER,
  language                TEXT,
  budget_uyu              INTEGER,
  urgency                 TEXT,
  notes                   TEXT,
  contact_kind            TEXT CHECK (contact_kind IS NULL OR contact_kind IN ('whatsapp','email')),
  contact_value           TEXT,
  contact_preferred_time  TEXT,
  consent_reply           INTEGER NOT NULL DEFAULT 0,
  summary                 TEXT NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'received'
                            CHECK (status IN ('received','in_progress','answered','closed')),
  created_at              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_librero_requests_created_at ON librero_requests (created_at);
