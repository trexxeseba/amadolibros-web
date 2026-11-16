# Competencia: foto semanal del catálogo de un vendedor

Qué vende un competidor de Mercado Libre cuando las herramientas de terceros (Administrado)
no lo toman por tener pocas ventas. Pensado para **HERMES_PROMOSML** (seller 471589392,
cuenta de HERMESPROMOS): +50 mil publicaciones y poco más de 100 ventas, así que lo
revelador no es su catálogo sino qué se mueve de una semana a la otra.

## Qué hace

Workflow `Competencia catálogo (foto semanal)` (`.github/workflows/competencia-catalogo.yml`),
domingos 03:10 de Montevideo, código en `scripts/mercadolibre/catalogo-competidor.mjs`.

1. Lee `/sites/MLU/search?seller_id=...` con el token de Amado Vintage (sólo lectura, el
   mismo que usa el vigía). La búsqueda no deja pasar el offset 1000, así que el catálogo se
   parte en tramos: primero por categoría, después por rangos de precio y, si hace falta,
   partiendo el rango al medio hasta que cada tramo entre en 1.050 resultados.
2. Guarda la foto en D1 (`comp_catalogo_fotos`, `comp_catalogo_tramos`, `comp_catalogo_items`).
   Si la corrida se corta, la siguiente sigue la misma foto por los tramos pendientes
   (hasta 96 horas después).
3. Con dos fotos completas calcula el movimiento y lo guarda en `comp_catalogo_movimientos`:
   - **vendido**: la cantidad disponible bajó (venta probable; la API ya no informa vendidos de terceros);
   - **desaparecido**: estaba y ya no se lista (agotado o dado de baja);
   - **nuevo** y **precio**.
4. Manda el informe por mail a Seba (asunto "Competencia ML: ..."), con las ventas probables
   primero y, al final, qué publica por categoría. La primera foto sólo avisa que el
   movimiento sale en la próxima.

Se conservan las últimas 6 fotos completas por vendedor. En los logs de Actions van sólo
conteos y códigos de error; títulos y precios del vendedor quedan en D1 y en el mail.

## Cómo usarlo

- Otro vendedor: `Run workflow` con su `seller_id`.
- Sólo volver a mandar el informe de las fotos que ya hay: `Run workflow` con acción `informe`.
- A mano: `node scripts/mercadolibre/catalogo-competidor.mjs --seller 471589392 --max-minutes 150`
  con los secretos de Cloudflare y Resend en el entorno.
- Tests: `node --experimental-sqlite --test scripts/__tests__/catalogo-competidor.test.mjs`.

## Límites conocidos

- Un tramo con más de 1.050 publicaciones al mismo precio dentro de una categoría queda
  **parcial** (el informe lo avisa). Para HERMES no debería pasar.
- `available_quantity` puede venir vacío en algunas publicaciones; esas sólo cuentan como
  desaparecidas o nuevas, no como vendidas.
- El mismo vendedor puede tener otras cuentas; sólo se mira la indicada.
