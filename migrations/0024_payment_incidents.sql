-- Incidentes de pago: cobros de Mercado Pago que no se pudieron asignar a un
-- pedido (importe distinto, pedido inexistente, otra orden de pago), cobros
-- repetidos sobre un pedido ya pagado y devoluciones o contracargos.
--
-- Anotar un incidente nunca cambia un pedido. La tabla no guarda datos del
-- comprador: sólo el id del pago, el código del pedido y los importes.
-- El id es "mp:<pago>:<motivo>": un mismo problema se anota una sola vez
-- aunque Mercado Pago repita el aviso o lo encuentre también la conciliación.

CREATE TABLE IF NOT EXISTS payment_incidents (
  id               TEXT    PRIMARY KEY,
  payment_id       TEXT    NOT NULL,
  reason           TEXT    NOT NULL,
  public_code      TEXT,
  order_id         TEXT,
  mp_status        TEXT,
  mp_amount_uyu    REAL,
  order_amount_uyu INTEGER,
  source           TEXT    NOT NULL,
  created_at       TEXT    NOT NULL,
  notified_at      TEXT,
  resolved_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_payment_incidents_created_at ON payment_incidents (created_at);
CREATE INDEX IF NOT EXISTS idx_payment_incidents_payment_id ON payment_incidents (payment_id);

-- Turno de la conciliación de pagos. Una fila por entorno y cuenta de Mercado
-- Pago. Tomar el turno es una sola sentencia condicional: si dos llamados
-- llegan a la vez, la base deja pasar uno solo. Guarda además el resultado de
-- la última corrida (sólo cantidades).
CREATE TABLE IF NOT EXISTS payment_reconcile_runs (
  scope        TEXT PRIMARY KEY,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  status       TEXT NOT NULL,
  summary_json TEXT
);
