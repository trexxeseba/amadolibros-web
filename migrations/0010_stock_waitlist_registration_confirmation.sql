-- STOCK-AVISO-2: confirmación inmediata al cliente al registrar su solicitud
-- de aviso de stock. Estado propio y separado de internal_notification_status
-- (aviso interno al equipo, 0003) y de customer_notification_status (aviso de
-- reposición al cliente, 0007) — nunca reutilizar ninguna de esas dos.
ALTER TABLE stock_waitlist ADD COLUMN registration_confirmation_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (registration_confirmation_status IN ('pending','sent','failed','skipped'));
ALTER TABLE stock_waitlist ADD COLUMN registration_confirmation_id TEXT;
ALTER TABLE stock_waitlist ADD COLUMN registration_confirmation_error TEXT;
