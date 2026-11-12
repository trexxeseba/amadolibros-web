-- JUEGO-4: el premio de la Rueda o del Acertijo usado al pagar en la web.
-- payable_total_uyu ya lo descuenta (productos − retiro − premio + envío).
-- Pagando por transferencia se descuenta premio_transfer_discount_uyu en lugar
-- de premio_discount_uyu. premio_product_id es el libro al que se aplicó.
ALTER TABLE orders ADD COLUMN premio_code TEXT;
ALTER TABLE orders ADD COLUMN premio_product_id TEXT;
ALTER TABLE orders ADD COLUMN premio_discount_uyu INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN premio_transfer_discount_uyu INTEGER NOT NULL DEFAULT 0;
