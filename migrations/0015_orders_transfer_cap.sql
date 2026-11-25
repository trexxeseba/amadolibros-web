-- TOPE-25: total de libros pagando por transferencia, calculado al crear el
-- pedido con el tope de 25 % sobre el precio habitual (functions/_shared/descuentos.js).
-- NULL en los pedidos anteriores: el handler de transferencia vuelve al
-- cálculo de siempre (products_total_uyu * 0.88).
ALTER TABLE orders ADD COLUMN transfer_products_total_uyu INTEGER;
