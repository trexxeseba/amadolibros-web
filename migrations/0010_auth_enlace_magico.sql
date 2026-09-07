-- LOGIN-1: ingreso por enlace mágico, sólo para que el comprador vea sus
-- pedidos. No toca el checkout ni la tabla `orders`.
--
-- Los tokens y las sesiones viven en D1 y no en KV a propósito: un token de
-- ingreso tiene que ser de UN SOLO USO, y eso exige una escritura atómica
-- (`UPDATE ... WHERE used_at IS NULL` mirando cuántas filas cambiaron). KV es
-- de consistencia eventual y no da esa garantía; se usa sólo para los
-- contadores de límite de envío, donde una cuenta aproximada alcanza.
--
-- Nunca se guarda el token ni el id de sesión en claro: sólo su SHA-256. Si
-- alguien llegara a leer estas tablas, no obtiene credenciales usables.

CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash  TEXT    PRIMARY KEY,
  email       TEXT    NOT NULL CHECK (length(trim(email)) > 0),
  created_at  TEXT    NOT NULL,
  expires_at  TEXT    NOT NULL,
  used_at     TEXT,
  request_ip  TEXT
);

-- Para el barrido de vencidos.
CREATE INDEX IF NOT EXISTS idx_auth_tokens_expires_at ON auth_tokens (expires_at);

CREATE TABLE IF NOT EXISTS auth_sessions (
  session_hash TEXT    PRIMARY KEY,
  email        TEXT    NOT NULL CHECK (length(trim(email)) > 0),
  created_at   TEXT    NOT NULL,
  expires_at   TEXT    NOT NULL,
  revoked_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at ON auth_sessions (expires_at);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_email      ON auth_sessions (email);

-- "Mis pedidos" busca por correo del comprador. La columna existe desde
-- 0006 pero nunca se indexó: sin esto cada consulta recorre la tabla entera.
CREATE INDEX IF NOT EXISTS idx_orders_buyer_email ON orders (buyer_email);
