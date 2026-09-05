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

## Cómo se define la señal de posible solapamiento AUTOFEED/FILE

**`products.list` no permite confirmar solapamiento**: cada producto
procesado expone una única fuente (`dataSource`) resultante, no todas las
fuentes que compitieron por ese `offer_id`. Por eso, cuando un mismo
`offer_id` aparece en más de una fila de `products.list` (por ejemplo, con
distinto `channel`, `feedLabel` o `contentLanguage`) y esas filas se
resuelven a fuentes con `input` distinto que incluyen tanto `AUTOFEED` como
`FILE`, esto se reporta como **`overlapSignals`** — una señal a investigar
manualmente en Merchant Center — nunca como "solapamiento confirmado". El
JSON, el CSV y el Markdown usan siempre el término "señal" y listan las
combinaciones completas (`channel`/`feedLabel`/`contentLanguage`) de cada
entrada involucrada para facilitar la investigación manual.

Dos totales similares (por ejemplo, conteos parecidos entre el feed y la
API) **no** se interpretan como evidencia de solapamiento — sólo la
coincidencia exacta de `offer_id` en filas de fuentes distintas genera una
señal, y aun así queda etiquetada como no confirmada.

## Limitación conocida de la API

`products.list` sólo expone la fuente que resultó ganadora para cada
combinación de `offerId`/`channel`/`feedLabel`/`contentLanguage`; no lista
todas las fuentes que compitieron por esa combinación. Merchant API v1 no
ofrece, además, un endpoint GET de solo lectura para listar `productInputs`
individuales por fuente (esa API sólo admite `insert`/`delete`, no
`list`). Por lo tanto:

- La señal de solapamiento reportada aquí es un **límite inferior**: puede
  haber más solapamiento real que el que esta auditoría puede demostrar
  con operaciones GET, y ninguna lectura puede "confirmarlo" sin acceso a
  los inputs individuales por fuente.
- La ausencia de señales en una lectura **no prueba** que no exista
  solapamiento — se documenta explícitamente como hipótesis/limitación,
  no como hecho.

## Precio e imagen ausente, bloqueada o con advertencia

Merchant API v1 devuelve los atributos procesados de cada producto bajo
**`product.productAttributes`** (no bajo `product.attributes`, que no
existe en la respuesta real — ese fue el bug que en una corrida real infló
`missingPriceCount`/`missingImageCount` a la totalidad del catálogo, porque
el código leía un campo inexistente y todo se contaba como ausente).

- **Precio ausente**: `productAttributes.price` (o `product.price` como
  respaldo) no tiene un `amountMicros` numérico mayor a cero **y** una
  moneda (`currencyCode`) no vacía. Un monto sin moneda se considera no
  utilizable.
- **Imagen ausente**: no hay `productAttributes.imageLink`.
- **Imagen bloqueada**: hay `imageLink`, pero `productStatus.itemLevelIssues`
  incluye un issue relacionado con imagen (código o atributo que contiene
  "image") con severidad `DISAPPROVED`.
- **Advertencia de imagen (no bloqueante)**: hay `imageLink` y un issue de
  imagen con severidad `NOT_IMPACTED` o `DEMOTED`. Se reporta por separado
  (`imageWarnings` en el JSON, columna `image_status = advertencia` en el
  CSV) y **no** se cuenta como imagen ausente ni bloqueada, ni entra en
  `missing-image.csv`.

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

- `offer-reconciliation.json` — reporte completo de la reconciliación
  (incluye `overlapSignalCount`/`overlapSignals`, `missingPriceCount`,
  `missingImageCount`, `imageWarningCount`).
- `offer-reconciliation.csv` — una fila por oferta procesada, con columnas
  `image_status` (`ausente`/`bloqueada`/`advertencia`/`ok`),
  `image_blocking_issue_codes` e `image_warning_issue_codes` separadas.
- `missing-price.csv` — subconjunto sin precio utilizable.
- `missing-image.csv` — subconjunto con imagen **ausente o bloqueada**
  únicamente; las advertencias no bloqueantes quedan fuera de este archivo.
- `source-overlap.csv` — filas de las ofertas con señal de posible
  solapamiento AUTOFEED/FILE (no confirmada), con `channel`/`feedLabel`/
  `contentLanguage` de cada entrada para investigar manualmente.
- `offer-reconciliation-summary.md` — resumen legible con hechos,
  hipótesis y limitaciones.

El workflow `.github/workflows/merchant-readonly-audit.yml` valida, en el
paso "Validate offer reconciliation artifacts", que los seis artefactos
existan y no estén vacíos, que las filas de cada CSV coincidan
exactamente con los conteos del JSON, que ningún subconjunto
(`missingPriceCount`, `missingImageCount`, `imageWarningCount`,
`uniqueOffers`) supere el total de filas, y que el reporte nunca contenga
la frase "solapamiento confirmado".

Todos los CSV protegen contra CSV/formula injection: cualquier celda que
empiece con `=`, `+`, `-` o `@` se antepone con un apóstrofo (mismo patrón
que `scripts/seo/gsc-export.mjs`).
