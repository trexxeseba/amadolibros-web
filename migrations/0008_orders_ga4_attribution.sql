-- SERVER-SIDE-PURCHASE-MEASUREMENT: conserva la identidad anónima de GA4
-- vigente al crear la orden. No se guarda correo, teléfono, nombre ni otra
-- PII en estos campos. Las órdenes históricas permanecen válidas con NULL.
ALTER TABLE orders ADD COLUMN ga_client_id TEXT;
ALTER TABLE orders ADD COLUMN ga_session_id INTEGER;
