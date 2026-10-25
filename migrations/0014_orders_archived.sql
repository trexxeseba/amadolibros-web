-- PANEL-ACCIONES: archivar un pedido lo saca de las listas del panel sin
-- borrarlo. Las ventas, el historial y la contabilidad quedan intactos; un
-- pedido archivado se puede desarchivar desde su ficha.
ALTER TABLE orders ADD COLUMN archived_at TEXT;
CREATE INDEX IF NOT EXISTS idx_orders_archived_at ON orders (archived_at);
