# Merchant Center — reconciliación de ofertas por offer_id (solo lectura)

Extiende `scripts/commerce/merchant-readonly-audit.mjs` para reconciliar
ofertas por `offer_id` entre las fuentes de datos AUTOFEED y FILE de
Merchant Center, y para detectar precio o imagen ausente. Sigue siendo una
auditoría de solo lectura: todas las llamadas a Merchant API son GET y el
script no crea, corrige ni elimina productos ni fuentes.

## Qué endpoints se usan y por qué

La reconciliación reutiliza dos endpoints GET ya invocados por el script:

- `products.list` (`/products/v1/accounts/{id}/products`): devuelve la
  **vista fusionada** de cada oferta (una fila por combinación de
  `offerId` + `channel` + `feedLabel` + `contentLanguage`), incluyendo el
  `dataSource` que "ganó" para esa combinación.
- `dataSources.list` (`/datasources/v1/accounts/{id}/dataSources`): expone
  el campo `input` de cada fuente (por ejemplo `AUTOFEED`, `FILE`, `API`,
  `UI`) y su `type` (`primaryProductDataSource`, etc.).

El script une ambos por el nombre de recurso `product.dataSource` para
saber, por cada oferta devuelta por la API, a qué tipo de fuente quedó
asociada.

Además se parsea el feed público (`MERCHANT_PUBLIC_FEED_URL`) para extraer
`g:id`, `g:price` y `g:image_link` por `<item>`, como referencia adicional
independiente de la API (no como fuente primaria).

## Cómo se define el solapamiento AUTOFEED/FILE

Un `offer_id` se marca como **solapamiento confirmado** únicamente cuando
aparece en más de una fila de `products.list` (por ejemplo, con distinto
`channel`, `feedLabel` o `contentLanguage`) y esas filas se resuelven a
fuentes con `input` distinto que incluyen tanto `AUTOFEED` como `FILE`.

Dos totales similares (por ejemplo, conteos parecidos entre el feed y la
API) **no** se interpretan como evidencia de solapamiento — sólo la
coincidencia exacta de `offer_id` en filas de fuentes distintas cuenta como
solapamiento confirmado.

## Limitación conocida de la API

`products.list` sólo expone la fuente que resultó ganadora para cada
combinación de `offerId`/`channel`/`feedLabel`/`contentLanguage`; no lista
todas las fuentes que compitieron por esa combinación. Merchant API v1 no
ofrece, además, un endpoint GET de solo lectura para listar `productInputs`
individuales por fuente (esa API sólo admite `insert`/`delete`, no
`list`). Por lo tanto:

- El solapamiento reportado aquí es un **límite inferior**: puede haber
  más solapamiento real que el que esta auditoría puede demostrar con
  operaciones GET.
- La ausencia de solapamiento confirmado en una lectura **no prueba** que
  no exista — se documenta explícitamente como hipótesis/limitación, no
  como hecho.

## Precio e imagen ausente

- Precio: se considera ausente si `product.attributes.price` (o
  `product.price` como respaldo) no tiene un monto numérico mayor a cero.
- Imagen: se considera ausente si no hay `attributes.imageLink`, o si
  `productStatus.itemLevelIssues` incluye algún código o atributo que
  contenga "image" (por ejemplo `image_too_small`), lo que se trata como
  bloqueante aunque exista una URL de imagen.

Ningún valor de precio, stock, disponibilidad o GTIN se inventa o
completa: si la API no lo devuelve, se reporta como ausente.

## Snapshots históricos (47/18)

Los valores 47 (sin precio) y 18 (con imagen bloqueante), junto con la
sospecha de solapamiento AUTOFEED/FILE, son **referencias históricas**
incluidas en `offer-reconciliation.json` y en el resumen Markdown sólo
para comparar contra la lectura actual. El código nunca fuerza estos
números como resultado — se calculan siempre desde los datos devueltos
por la API en cada ejecución (ver los tests que verifican que no están
hardcodeados).

## Artefactos generados (`artifacts/merchant/`)

Además de los archivos ya existentes (`merchant-readonly-report.json`,
`report-summary.md`, `account-issues.json`, `data-sources.json`):

- `offer-reconciliation.json` — reporte completo de la reconciliación.
- `offer-reconciliation.csv` — una fila por oferta procesada.
- `missing-price.csv` — subconjunto sin precio utilizable.
- `missing-image.csv` — subconjunto sin imagen o con issues bloqueantes.
- `source-overlap.csv` — filas de las ofertas con solapamiento AUTOFEED/FILE confirmado.
- `offer-reconciliation-summary.md` — resumen legible con hechos,
  hipótesis y limitaciones.

Todos los CSV protegen contra CSV/formula injection: cualquier celda que
empiece con `=`, `+`, `-` o `@` se antepone con un apóstrofo (mismo patrón
que `scripts/seo/gsc-export.mjs`).
