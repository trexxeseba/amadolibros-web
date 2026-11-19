# Informe de promociones de Amado Vintage (solo lectura)

Mide, antes de armar cupones o promociones en Vintage (2341378249), cuánto descuento
aguanta cada libro sin bajar de su piso y qué campañas de Mercado Libre le cierran.
No escribe nada: solo `GET` a Mercado Libre y `SELECT` a D1. Antes de leer verifica con
`/users/me` que el token es de Vintage (mismo candado que Hermes).

- `src/logica.mjs`: cálculo puro (margen de maniobra, tramos, qué campañas entran). Con tests.
- `src/informe.mjs`: lectura. Reusa el token, el cliente y el piso de `precio-ganador/`
  (costo de SBS + margen mínimo 18 % + venta mínima).
- Workflow manual: `Vintage promos informe (solo lectura)`. El log lleva agregados; el
  detalle por libro queda en el archivo adjunto de la corrida (7 días).

## Cómo leerlo

- "Aguantan X %": libros cuyo precio con ese descuento sigue siendo mayor o igual al piso.
- "Entran": candidatas de una campaña cuyo precio final no pisa el piso. Conservador: no
  cuenta lo que pone Mercado Libre en las campañas compartidas.
- El costo sale de la lista nueva de SBS (`sbs_supplier_feeds` / `sbs_supplier_stock`), con
  la política aprobada (piso de margen 18 %, venta mínima de la política). Solo los libros de
  SBS (SKU `AMADO-AR-`) tienen costo; los de Arnoia y Hermes figuran "sin costo conocido".
- `precio-ganador/src/costos-vintage.mjs` todavía lee las tablas viejas (`ml_pub_feeds`):
  por eso este informe tiene su propio lector (`src/costos.mjs`).
- Una publicación con promoción a la vista (`original_price`) queda fuera de Precio
  Ganador: mientras dure la promo no compite por precio.
