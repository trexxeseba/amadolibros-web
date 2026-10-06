-- INFORME-ANALITICO: lo que realmente se cobró. Mercado Pago cobra
-- payable_total_uyu; una transferencia cobra el total con el 12 % de
-- descuento en libros, que hasta ahora no quedaba en ningún lado. Los
-- pedidos históricos quedan en NULL: el informe declara "sin dato" en vez de
-- inventar el monto.
ALTER TABLE orders ADD COLUMN paid_amount_uyu INTEGER CHECK (paid_amount_uyu IS NULL OR paid_amount_uyu >= 0);
