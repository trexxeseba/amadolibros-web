# Precios Amado

Analiza la competencia de las publicaciones activas de Amado Libros en Mercado
Libre Uruguay, avisa cuando perdemos la oferta destacada de catálogo frente a un
vendedor más barato **que declara plazo de preparación**, y detecta libros donde
la entrega inmediata justifica revisar el precio.

**Sólo lee.** No cambia precios ni crea, cierra, pausa o desvincula publicaciones.
No usa IA ni scraping: sólo la API oficial de Mercado Libre.

## Cómo corre

- GitHub Actions, workflow `Precios Amado` (`.github/workflows/precios-amado.yml`):
  08:40, 13:10 y 18:40 de Montevideo. También se lanza a mano (`workflow_dispatch`,
  con `limit` y `sin_correo` opcionales).
- Correo a sebastian@amadolibros.com por Resend (mismo remitente verificado que
  los informes): **resumen** en la primera corrida del día; en las otras, correo
  sólo si aparece un caso nuevo o cambia uno existente (precio, ganador, pasar de
  inmediato a pedido). El cuerpo trae los primeros casos de cada sección y el
  reporte completo va **adjunto** (Gmail corta los correos de más de ~100 KB). Un
  caso que cambia sólo porque un dato no se pudo leer no dispara correo.
- Si el listado de publicaciones vuelve incompleto, o el token falla, no se manda
  resumen ni se guardan avisos.
- Reporte y estado en el bucket **privado** de R2 `amadolibros-reports`:
  - `precios-amado/ultimo.html` y `precios-amado/reportes/<fecha>-<run>.html`
  - `precios-amado/state.tgz` — historial de precios, avisos ya mandados, métricas
  - `precios-amado/config.json` — opcional, techos comerciales (ver abajo)
  - Si no se puede leer el estado (error de R2, no "no existe"), la corrida se corta
    antes de pisarlo con uno vacío.
  - Las pruebas que corren al hacer push en la rama usan `precios-amado-pruebas/`.
- Los logs de Actions son públicos (repo público): el script imprime sólo conteos.

En la PC también corre (`node precios-amado/src/run.mjs --limit 300 --sin-correo`),
con estado en `%USERPROFILE%\.amado-precios` y el token de aplicación. Con
`--limit`, `--sin-correo` o `--solo-catalogo` la corrida es de **prueba**: arma el
reporte pero no guarda historial ni avisos.

## Token de Mercado Libre

| Fuente | Dónde | Qué puede |
| --- | --- | --- |
| `worker` (Actions) | `ml_oauth` en D1 del Worker de sync, leída por la API de Cloudflare | Todo lo que usa la herramienta |
| `app` (PC) | `~/.amado-precios/credentials.json` o `ML_PRECIOS_APP_ID` / `ML_PRECIOS_CLIENT_SECRET`. App de `mlu-monitor/.env` (`ML_CLIENT_ID`, `ML_CLIENT_SECRET`); su refresh token está vencido, se usa `client_credentials` | Lo mismo: publicaciones, fichas, `price_to_win`, `shipping_options` |

Los dos dan `/users/me` = 440298103 (AMADOLIBROS COMUY). Ninguno lee `/items/{id}`
ni `/items/bulk` de otros vendedores (403), ni `/sites/MLU/search` (403).

El token del Worker **nunca se renueva desde acá**: el refresh token es rotativo y
de un solo uso, y lo administra `worker-sync/meli-auth.js` con lock en D1. Si está
por vencer, el script espera (hasta 7 minutos, una sola espera compartida) a que el
Worker lo renueve; si no aparece, la corrida termina con error y sin reporte.

## Qué se compara

- Mismo libro = misma ficha de catálogo (`catalog_product_id`). Las publicaciones
  sin ficha se buscan por ISBN en `/products/search` y la ficha tiene que declarar
  el mismo ISBN (ISBN-10 e ISBN-13 normalizados). La búsqueda general
  `/sites/MLU/search` responde 403 para esta cuenta.
- Se excluyen nuestras publicaciones, los usados frente a un nuevo, los
  internacionales y otra moneda. Una oferta con condición desconocida cuenta como
  competidor y deja el caso sin cerrar. Ofertas sin precio válido se descartan.
- Plazo: `/items/{id}/shipping_options?city_to=<Cordón, Montevideo>`, opción
  recomendada por ML. `estimated_delivery_time.date` es la **llegada estimada** a
  ese destino (cambia según dónde esté el comprador); la **preparación** se lee así:
  - `schedule` con número → preparación = schedule (horas). La documentación no lo
    describe; un vendedor a pedido trae, por ejemplo, 552 h.
  - `schedule` null y `handling` ≤ 24 h → sin preparación. Es exactamente lo que
    devuelven nuestras publicaciones, inmediatas comprobadas (grupo control: 60 de
    60 el 03/11/2026, siempre schedule null y handling 0 o 24).
  - Cualquier otra cosa → desconocido, nunca "inmediata".
  - Las ofertas Full con preparación se cuentan aparte (`full_con_plazo` en las
    métricas): sería señal de que la lectura está mal.
  - Por qué no `sale_terms`: el listado de la ficha no trae `MANUFACTURING_TIME`
    (0 de 1.490 ofertas de terceros el 03/11/2026) y `/items/bulk` de terceros
    responde 403 con los dos tokens disponibles.
  - Por ficha se consulta de la oferta más barata a la más cara y se corta en la
    primera comparable (misma condición que la nuestra) sin preparación. El
    ganador de la ficha se consulta siempre.
  - Sin opciones de envío o sin respuesta: plazo desconocido, nunca "inmediata".

Estados por publicación: `sin_competidores`, `solo_con_plazo`,
`con_sin_plazo_declarado`, `plazo_no_verificado`, `insuficiente` (consulta fallida
o incompleta). Un error de consulta nunca produce una oportunidad.

## Alerta de catálogo

Según las reglas de catálogo de ML (developers.mercadolibre.com.ar/competencia-en-catalogo),
una oferta con plazo de preparación **no le gana** a una con stock inmediato de
igual reputación. Por eso "perdemos frente a un competidor con plazo" debería ser
raro, y cuando pasa la causa no es el precio: el aviso muestra el motivo de ML
(reputación, etc.) y, si no hay, propone consultar a soporte. Exige que nuestra
publicación sea inmediata comprobada (sin plazo propio y con stock).

Estados separados: compartimos el primer lugar (`sharing_first_place`, no es
perder), no competimos por un motivo de la cuenta (`listed`), ganamos de forma
frágil (`temporarily_*`), perdemos con o sin plazo del ganador. Si la destacada es
otra publicación nuestra, no hay aviso.

## Oportunidades de subida

- Sólo activas, con stock, inmediatas comprobadas, y de catálogo sólo si
  `price_to_win` confirma que ganamos (un error no cuenta como "ganamos").
- Una por ficha (la de catálogo y su tradicional gemela son el mismo libro); si
  la de catálogo no gana, la gemela tampoco es oportunidad.
- **Referencia observada**: el competidor a pedido más barato; o, si hay
  inmediatos ajenos y **todos** cobran más que nosotros, el inmediato más barato.
- **Sugerido**: esa referencia, sólo si está por encima de nuestro precio y la
  respaldan dos vendedores distintos o un techo propio (acotada por el techo). No
  hay topes ni porcentajes inventados: la diferencia se muestra en $ y en %, y una
  referencia de un solo vendedor (p. ej. $ 42.900 contra nuestros $ 4.700) queda
  "para revisar". Sin referencia: "oportunidad para revisar", sin importe.
- Si ya cobramos más que todos los a pedido, no es oportunidad: se cuenta aparte.
- "Sin competidores" es en la ficha de catálogo: las publicaciones de terceros
  fuera de catálogo no se pueden ver (búsqueda cerrada).
- **Máximo observado**: dato histórico desde el inicio del seguimiento, no un techo.
- Techos comerciales: `config.json` en R2 → `{ "techos": { "MLU123": 1500 } }`.

## Catálogo: qué verificamos (03/11/2026)

- `MLU-BOOKS` está en `/catalog/dumps/domains/MLU/catalog_required` desde el
  21/07/2023: en Uruguay, Libros tiene catálogo obligatorio.
- Cada publicación de catálogo nuestra tiene una tradicional vinculada por
  `item_relations` con `stock_relation: 1` (stock compartido, mismo precio).
  `catalog_listing_eligibility`: la de catálogo `COMPETING`, la tradicional
  `ALREADY_OPTED_IN`.
- La estrategia es por ficha: `/products/{id}` → `settings.listing_strategy`
  (`catalog_required` en las fichas revisadas). Se lee en los casos para decidir.
- Salir del catálogo: la documentación permite pausar o cerrar la publicación de
  catálogo y la tradicional sigue activa (developers.mercadolibre.com.ar/en_us/catalog-listing),
  pero en un dominio obligatorio ML puede volver a asociarla (optin automático) o
  moderar. No comprobado para MLU: no se recomienda sin probarlo en un caso.
- Crear otra tradicional: no como solución general (moderación por optin,
  duplicado, sin historial).
- Palancas reales: las mejoras que `price_to_win` marca como `opportunity` (y que
  el ganador tiene), precio, y soporte cuando ML no explica el resultado.
- Se avisan las gemelas con precio o plazo distinto (deberían estar sincronizadas)
  y las publicaciones con tag `catalog_forewarning`.
- Falta comprobar: cuánta exposición tiene la tradicional gemela en listados
  cuando perdemos la ficha (no se puede medir por API sin búsqueda).

## Costo

- GitHub Actions: repo público → minutos de runners estándar sin costo.
- R2: estado de pocos cientos de KB y un HTML por corrida; muy por debajo de los
  10 GB gratuitos. Operaciones: 6 por corrida.
- Resend: ya contratado/configurado; 1 a 3 correos por día.
- Cloudflare D1: 1 lectura por corrida (más si espera la renovación).
- Sin IA en la ejecución.

## Tests

`node --test precios-amado/test/*.test.mjs`
