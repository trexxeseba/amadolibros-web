-- CUENTA-1: identificarse con Google es OPCIONAL y sólo sirve para traer los
-- datos que el propio cliente decidió guardar. La compra como invitado sigue
-- funcionando igual y nada de esto toca precios, stock, pagos ni pedidos.
--
-- Cuatro tablas separadas a propósito:
--
--   account_identities  quién es (proveedor + sub de Google). Existe desde el
--                       primer ingreso.
--   account_profiles    qué datos guardó. NO existe hasta que el cliente
--                       aprieta "guardar": nunca se importan direcciones de
--                       pedidos viejos, que pueden haber sido regalos.
--   account_sessions    la sesión abierta, con su token CSRF y su revocación.
--   auth_nonces         un solo uso por ingreso, contra repetición del token.
--
-- Nunca se guarda en claro ni la cookie de sesión ni el nonce: sólo su
-- SHA-256. Leer estas tablas no da credenciales usables.

CREATE TABLE IF NOT EXISTS account_identities (
  id          TEXT PRIMARY KEY,
  provider    TEXT NOT NULL CHECK (provider IN ('google')),
  subject     TEXT NOT NULL CHECK (length(trim(subject)) > 0),
  email       TEXT NOT NULL CHECK (length(trim(email)) > 0),
  created_at  TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

-- La identidad es proveedor + subject, NUNCA el correo: dos cuentas no se
-- unen por escribir el mismo email en el formulario.
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_identities_provider_subject
  ON account_identities (provider, subject);

CREATE TABLE IF NOT EXISTS account_profiles (
  identity_id  TEXT PRIMARY KEY REFERENCES account_identities(id) ON DELETE CASCADE,
  buyer_name   TEXT,
  buyer_phone  TEXT,
  address      TEXT,
  locality     TEXT,
  department   TEXT,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS account_sessions (
  session_hash TEXT PRIMARY KEY,
  identity_id  TEXT NOT NULL REFERENCES account_identities(id) ON DELETE CASCADE,
  csrf_hash    TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_account_sessions_identity ON account_sessions (identity_id);
CREATE INDEX IF NOT EXISTS idx_account_sessions_expires  ON account_sessions (expires_at);

CREATE TABLE IF NOT EXISTS auth_nonces (
  nonce_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_auth_nonces_expires ON auth_nonces (expires_at);
