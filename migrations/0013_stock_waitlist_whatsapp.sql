-- Clientes que, ante un libro sin stock, dejan su WhatsApp en vez de un correo.
-- Tabla aparte: stock_waitlist exige email y el notificador automático sólo
-- envía correos. Estos contactos los atiende una persona (aviso interno por
-- correo con link a wa.me y resumen en el correo diario).
CREATE TABLE IF NOT EXISTS stock_waitlist_whatsapp (
  id                           TEXT PRIMARY KEY,
  product_id                   TEXT NOT NULL,
  product_title                TEXT NOT NULL,
  whatsapp                     TEXT NOT NULL,
  status                       TEXT NOT NULL DEFAULT 'waiting'
                                 CHECK (status IN ('waiting','contacted','cancelled')),
  source_url                   TEXT,
  internal_notification_status TEXT NOT NULL DEFAULT 'pending'
                                 CHECK (internal_notification_status IN ('pending','sent','failed','skipped')),
  created_at                   TEXT NOT NULL,
  updated_at                   TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_waitlist_whatsapp_waiting
  ON stock_waitlist_whatsapp (product_id, whatsapp)
  WHERE status = 'waiting';
