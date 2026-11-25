# Competencia: foto semanal de un vendedor

Qué vende un competidor de Mercado Libre cuando las herramientas de terceros (Administrado)
no lo toman por tener pocas ventas. Pensado para **HERMES_PROMOSML** (seller 471589392,
la cuenta de HERMESPROMOS): +50 mil publicaciones y poco más de 100 ventas.

## Qué deja ver Mercado Libre

Sondeo del 16/11/2026 con el token de Amado Vintage (`scripts/mercadolibre/sondeo-competidor.mjs`,
se repite con la acción `sondeo` del workflow):

| Ruta | Respuesta |
| --- | --- |
| `/sites/MLU/search` (por vendedor, apodo, categoría o texto) | 403 en todas las variantes |
| `/users/{id}/items/search` | 403 "Searching another user items is restricted" |
| `/items/{id}` y `/items?ids=` de publicaciones ajenas | 403 (el lote responde 200 con 403 adentro) |
| `/users/{id}` | OK, pero de un tercero sólo trae apodo, nivel y `transactions.total` (concretadas más canceladas); las concretadas y las ventas de 60 días vienen sólo para la cuenta propia |
| `/products/{id}/items` | OK: ofertas de cada producto de catálogo (lo usa la vigilancia del Worker) |
| `/questions/search?item=` | OK: preguntas de una publicación ajena, con fecha |

Por eso el catálogo completo del vendedor no se puede bajar por API. Lo que sí se mide:

1. **Cuánto vende.** El contador de operaciones de su ficha pública (`transactions.total`).
   Un pulso diario del workflow lo anota en `comp_vendedor_dias`; la diferencia entre fechas
   son sus operaciones (por día, por semana, entre fotos). El Worker guardaba
   `transactions.completed` en `comp_seller_days`, que para terceros viene vacío: por eso
   esa tabla tiene 20 días de nulos.
2. **Qué hace en nuestros libros.** Los productos de catálogo donde la vigilancia de
   competencia lo vio alguna vez (`comp_snapshots`) se vuelven a leer con
   `/products/{id}/items`: precio, puesto entre las ofertas, el más barato, nuestro precio,
   envío, cantidad si ML la informa y preguntas recibidas en la semana.
3. **Movimiento entre fotos**: desaparecida (sin stock o pausada), nueva, cambio de precio,
   bajó la cantidad.

## Cómo funciona

Workflow `Competencia catálogo (foto semanal)` (`.github/workflows/competencia-catalogo.yml`),
código en `scripts/mercadolibre/catalogo-competidor.mjs`. Domingos 03:10 de Montevideo toma
la foto y manda el informe; de lunes a sábado a la misma hora hace el pulso (una llamada,
sin mail). Tablas en D1: `comp_vendedor_fotos`, `comp_vendedor_items`,
`comp_vendedor_movimientos`, `comp_vendedor_dias` (se conservan las últimas 12 fotos por
vendedor; los días no se borran). El informe llega por mail con asunto
"Competencia ML: ...". En los logs de Actions van sólo conteos y códigos de error.

- Otro vendedor: `Run workflow` con su `seller_id`. Sólo sirve si la vigilancia del Worker
  lo vio en algún producto nuestro; si no, la foto trae la ficha y cero publicaciones.
- Sólo volver a mandar el informe: `Run workflow` con acción `informe`. Pulso suelto: acción `pulso`.
- Tests: `node --experimental-sqlite --test scripts/__tests__/catalogo-competidor.test.mjs`.

## Límites

- El catálogo completo (los +50 mil) sólo se ve desde el navegador:
  `https://listado.mercadolibre.com.uy/_CustId_471589392`, filtrable por categoría. No se
  automatiza: desde servidores Mercado Libre responde con un muro de verificación.
- `available_quantity` casi nunca viene en las ofertas de catálogo de terceros; el movimiento
  se apoya sobre todo en desapariciones, altas y precios.
- El mismo importador puede tener otras cuentas; sólo se mira la indicada.
