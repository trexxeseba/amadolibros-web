-- JUEGO-4: los códigos se usan al pagar en la web o por WhatsApp.
-- order_id / reservado_hasta: el pedido que lo tiene reservado mientras se paga
-- (la reserva vence con el pedido). canal: 'web' o 'whatsapp'. libro y
-- descuento_uyu: en qué libro se usó y cuánto descontó.
ALTER TABLE juego_codigos ADD COLUMN order_id TEXT;
ALTER TABLE juego_codigos ADD COLUMN reservado_hasta TEXT;
ALTER TABLE juego_codigos ADD COLUMN canal TEXT;
ALTER TABLE juego_codigos ADD COLUMN libro TEXT;
ALTER TABLE juego_codigos ADD COLUMN descuento_uyu INTEGER;
CREATE INDEX IF NOT EXISTS idx_juego_codigos_order ON juego_codigos (order_id);
CREATE INDEX IF NOT EXISTS idx_juego_codigos_used ON juego_codigos (used_at);
