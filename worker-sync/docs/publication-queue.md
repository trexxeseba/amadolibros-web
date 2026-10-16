# Publicación interna de Amado en Mercado Libre

La cola vive en tablas `ml_pub_*` de D1. El Worker continúa cada minuto y GitHub
Actions funciona como control y respaldo. Cerrar ChatGPT no detiene un lote.
No se guardan catálogos de proveedores, costos, claves ni tokens en GitHub o R2
público. El token de Mercado Libre sigue usando el mecanismo OAuth existente.

## Flujo

1. Importar un snapshot completo del proveedor mediante `begin_feed`, lotes de
   `import_feed` y `commit_feed`. El commit exige el número de ISBN únicos esperado.
2. Crear un lote con `create_run`: toma la política de precios privada y comienza
   en `preflight`. Nunca publica durante esta etapa.
3. Recorrer íntegramente activas y pausadas de la cuenta. El índice incompleto o
   una respuesta parcial no se utilizan para afirmar que un ISBN está ausente.
4. Enriquecer por ISBN exacto, exigir portada verificada, categoría de libros,
   consulta de comisiones y `/items/validate`. El lote prepara hasta diez libros.
5. Revisar `preview` y la política del lote. Aprobar exclusivamente su
   `policy_hash`. `approve` habilita la continuidad sin aprobar políticas futuras.
6. La cola guarda cada resultado y continúa hasta agotar los pendientes. Los
   faltantes y los resultados ambiguos quedan identificados para revisión.

Un nuevo snapshot se adjunta con `attach_feed`. Se renueva el índice de Mercado
Libre y se recalculan las candidatas pendientes. Los ISBN ausentes del snapshot
nuevo no conservan el stock anterior. Los libros ya publicados no se duplican.
La actualización conserva los ISBN originales de la tanda: no agrega libros del
listado nuevo. Para trabajar de a 1.000 se crea un snapshot de 1.000 ISBN por tanda;
la siguiente tanda necesita su propio lote.
La cola se pausa cuando la fuente supera 24 horas; para varios días de trabajo
hay que proporcionar un listado actualizado cada día o conectar su descarga.

## Precios y publicación

La política conserva descuento del proveedor, ARS/UYU, USD/UYU, flete por kg,
gestión, margen sobre venta, comisión, envío, excedente mínimo, precio mínimo,
redondeo y disponibilidad. El aumento comercial adicional es cero salvo que se
establezca explícitamente. Se comprueban las comisiones efectivas antes del alta.
Un costo superior al previsto requiere revisar el precio; no se oculta el cargo.

Se crean publicaciones tradicionales con `catalog_listing=false`. User Products
usa `family_name` cuando el vendedor tiene `user_product_seller`; eso no activa
Catálogo.

### Catálogo obligatorio

La política admite `catalogListing: false` (predeterminado) o
`"required_only"`. El valor integra el `policy_hash`: habilitar Catálogo exige
un lote nuevo con esa política y una aprobación nueva de su hash; ninguna
aprobación anterior cubre altas de Catálogo. Con `required_only`:

- Si el producto exacto del ISBN declara `listing_strategy = catalog_required`,
  se prepara una publicación directa a Catálogo: el payload documentado
  (título, fotos, atributos, SKU) más `catalog_listing: true` y el
  `catalog_product_id` verificado. Se valida con `/items/validate` en preflight;
  si Mercado Libre rechaza esa forma, el código oficial queda en el diagnóstico
  del job como evidencia y el libro no se publica.
- El `catalog_product_id` tiene que ser el producto cuyo GTIN es el ISBN del
  proveedor, en dominio `MLU-BOOKS`, activo y sin variantes. Un producto con
  hijos se resuelve únicamente si exactamente un hijo tiene ese GTIN. Cualquier
  otra situación es revisión: `catalog_product_id_mismatch`,
  `catalog_product_inactive`, `catalog_product_children_unresolved`,
  `product_identity_mismatch`.
- Si Catálogo no es obligatorio (`catalog_optional` u otro), la publicación
  sigue siendo tradicional.

Sin `required_only`, un producto con Catálogo obligatorio sigue quedando en
`catalog_required_needs_review`. Un payload de Catálogo jamás se crea bajo una
política que no lo aprobó (`catalog_payload_not_approved`).

#### Preflight de Catálogo a partir de un lote existente

`clone_preflight_catalog` (sólo con `SYNC_SECRET`, nunca por el sobre firmado
de Operaciones; `action=clone_preflight_catalog` del workflow con `run_id` =
lote fuente y `preflight_limit` 1-20) toma hasta N ISBN que el lote fuente dejó
en `review` con `catalog_required_needs_review`, clona su `policy_json` campo
por campo cambiando únicamente `catalogListing: "required_only"` y crea un lote
nuevo sobre el mismo snapshot, en `preflight`, sin aprobar, con `daily_cap` y
`preflight_limit` iguales a N. El id del lote nuevo es determinístico (fuente +
hash + N): repetir la solicitud devuelve el mismo lote sin duplicarlo. La acción
sólo corre ticks de preflight (búsquedas GET, comisiones y `/items/validate`);
jamás `POST /items`. Los rechazos de `/items/validate` quedan en `review` con los
códigos oficiales. El lote fuente no se escribe: la respuesta incluye
`source_run_intact` comparando política, hash, aprobación y conteos antes y
después. Publicar lo validado exige, como siempre, `approve` humano del
`policy_hash` nuevo.
Con `feed_id` opcional (input `feed_id` del workflow) el lote nuevo usa ese feed
fresco en lugar del feed del lote fuente, con un máximo de 5 ISBN (default 5).
El feed debe ser fresco (24 h); si sigue en `importing` se cierra sólo si tiene
exactamente `expected_rows` filas (si no, `feed_count_mismatch`). Cada ISBN
seleccionado debe existir en ese feed con stock positivo o no se crea nada
(`fresh_feed_missing_stock`). El feed entra en el id determinístico del lote.
Con `availability_days` opcional (input `availability_days` del workflow, 1-60)
la política clonada lleva ese `availabilityDays` en lugar del del lote fuente,
de modo que el payload manda `MANUFACTURING_TIME = N días` y el `policy_hash`
(y la aprobación humana) cubre exactamente esos días. El lote fuente no cambia.
`shipping_diagnostic` (sólo con `SYNC_SECRET`; `action=shipping_diagnostic` del
workflow, opcionalmente con `run_id`, `item_id` de una publicación propia e
`item_price`) es un diagnóstico de sólo lectura: GET a `/users/me`,
`/users/{id}/shipping_preferences`, `/categories/MLU1196/shipping_preferences`,
el ítem de referencia y la cotización de envío gratis ME2 con las medidas
estimadas. No escribe en D1, no valida ni crea ítems, y quita datos personales
y de ubicación de la respuesta. Devuelve además `current_payload` con el
`shipping` y la disponibilidad de stock (`MANUFACTURING_TIME`) que manda hoy el
payload para compararlos con la cuenta.
El primer alta ofrece una unidad: `+2` del proveedor es disponibilidad positiva,
no una cantidad exacta ni stock propio para entrega inmediata.
Las nuevas ofertas usan SKU `AMADO-AR-ISBN` y quedan fuera del catálogo web de
stock propio: el sync no debe anunciar entrega inmediata para estos libros.

El límite diario es un techo configurable de hasta 10.000 intentos, contado por
día de Montevideo. No garantiza que Mercado Libre autorice ese volumen para esta
aplicación. Se respeta HTTP 429 y se difieren los reintentos.

## Idempotencia y recuperación

La base asigna una concesión exclusiva por lote. Cada ISBN tiene una reserva
única para la cuenta antes del POST de alta. Una respuesta perdida (timeout de
30 segundos, transporte cortado, JSON inválido) no dispara otro POST: se busca
el SKU estable y se conserva el estado `uncertain` cuando todavía no se puede
demostrar qué ocurrió. La conciliación se repite con espera creciente (10
minutos, 20, 40… hasta 6 horas) incluso cuando el lote ya terminó en
`complete_with_review`: el cron la retoma solo y pasa el lote a `complete`
cuando no queda nada por conciliar. Un SKU que nunca aparece sigue `uncertain`
y se resuelve a mano. Los recibos publicados sobreviven a reinicios. Los
errores transitorios anteriores al alta se reintentan con espera.

`attach_feed` espera hasta 25 segundos a que el tick libere la concesión y el
script de control reintenta `run_busy` durante varios minutos: un lote ocupado
no pierde el snapshot diario.

## Autorización de Mercado Libre

La única fuente de verdad del OAuth es la tabla D1 `ml_oauth` (binding
`ORDERS_DB`, compartido por el Worker y las Functions de Pages). Guarda el
access token con el vencimiento real que devuelve Mercado Libre (`expires_in`),
el refresh token rotativo y un lock. Sólo se renueva cuando faltan menos de
cinco minutos para vencer; dos procesos nunca renuevan a la vez porque el lock
es un UPDATE condicional en D1; el reemplazo del refresh token es atómico y
condicionado al token exacto que se usó. No existe ningún refresh token en
variables de entorno: el webhook de Pages usa el mismo módulo.

Bootstrap: si `ml_oauth` está vacía, la primera llamada siembra el refresh
token desde la clave KV `auth:refresh_token` del esquema anterior, una sola
vez. Después KV no se lee ni se escribe. Si el refresh token se invalida
(`auth_invalid_grant`) hace falta reautorizar la aplicación y cargar el nuevo
token en `ml_oauth`; los lotes quedan en `auth_error` sin mandar libros a
revisión. Los fallos transitorios de renovación (`auth_upstream_*`,
`auth_transport`, `auth_lock_busy`) difieren el libro y se reintentan.

## Stock posterior a la publicación

Cada cinco minutos (`ML_STOCK_SYNC_MODE` distinto de `disabled`) el Worker
compara las altas de la cola (recibos `published`, SKU `AMADO-AR-ISBN`) con el
snapshot más reciente del proveedor:

- ISBN con stock: estado deseado `active`.
- ISBN ausente o sin stock: se registra la primera ausencia; se pausa recién
  cuando la ausencia persiste más de `ML_STOCK_SYNC_GRACE_HOURS` (20) entre
  snapshots frescos. Un snapshot vencido (más de 24 horas) o inexistente no
  hace nada. Un snapshot que dejaría sin stock a más de
  `ML_STOCK_SYNC_MAX_MISSING_PCT` de las altas se considera incompleto: no
  avanza ausencias ni pausa.
- Reactivación (`pause_and_reactivate`): sólo para pausas hechas por esta
  sincronización o por agotamiento (cantidad 0); una pausa manual con stock no
  se toca (`paused_externally`).
- Nunca se cierra una publicación. Antes de cada PUT se lee el estado real en
  `/items/bulk`; se verifica el SKU y el vendedor; un ítem `closed` o
  `under_review` se deja como está. Lo aplicado queda registrado en
  `ml_pub_stock_sync` y la corrida es idempotente. HTTP 429 difiere el resto.

`GET /publisher/stock-sync` (con `SYNC_SECRET`) muestra conteos y errores;
`POST /publisher/stock-sync` ejecuta una pasada acotada con el modo configurado.
`report` permite revisar el estado deseado antes de habilitar las pausas.

`complete` significa que no quedan pendientes. `complete_with_review` indica
que además hay libros con problemas o resultados por conciliar. Las cantidades
por estado permiten distinguir publicados, duplicados, sin stock y revisión.

## Control

- API administrativa: POST `/publisher/command` con el `SYNC_SECRET` existente.
  El cuerpo es `{ "action": "status", "args": { "run_id": "UUID" } }`.
- Amado Operaciones: POST `/operations/publication`, firma corta con hash del
  cuerpo, cuenta fija y nonce persistente. El permiso de lectura previo no sirve
  como autorización de estas operaciones.
- Acciones: `begin_feed`, `import_feed`, `commit_feed`, `create_run`, `attach_feed`,
  `status`, `tick`, `preview`, `pause`, `approve`.
- GitHub Actions: `Mercado Libre publication queue`. Siempre ofrece control
  manual desde main y un respaldo cada diez minutos. Se deshabilita con la
  variable `ML_PUBLISHER_AUTOMATION_ENABLED=false`; el cron del Worker es independiente.
- Parada global: `ML_PUBLISHER_MODE=disabled`; una pausa individual usa `pause`.

El script `scripts/mercadolibre/publisher-control.mjs` lee `SYNC_SECRET` del
entorno. Para importar recibe un JSON privado en `PUBLISHER_FEED_FILE`, con
`source_date`, `rows`, `policy` y opcionalmente `daily_cap`. Nunca subir ese JSON
al repositorio ni a los artefactos públicos de Actions.

La acción `refresh` descarga el Excel a diario a las 04:30 UTC desde el secreto
`SUPPLIER_FEED_URL`. Si exige un header de autorización, se configura únicamente
como `SUPPLIER_FEED_AUTHORIZATION`. Sin esa URL, la tarea informa que falta la
fuente; no inventa disponibilidad. `SUPPLIER_WEIGHT_UNIT` admite `kg` o `g`.
La fecha se extrae del propio Excel, no de la hora de descarga. El contenido
privado se borra del runner al terminar y nunca se adjunta a los logs.

## Documentación oficial revisada

- [Ítems y búsquedas](https://developers.mercadolibre.com.uy/es_ar/desarrollos-inmobiliarios/items-y-busquedas): migración del multiget a `/items/bulk` antes del 25/10/2026. El sync del catálogo, el lector de Operaciones y la cola ya usan `/items/bulk` y aceptan `status_code` + `body`.
- [Publicación en Catálogo](https://developers.mercadolibre.com.uy/es_ar/publicacion-en-catalogo): publicación directa con `catalog_product_id` y `catalog_listing: true`.
- [Búsqueda de productos](https://developers.mercadolibre.com.uy/en_us/items-and-searches/products-search).
- [Costos de publicación](https://developers.mercadolibre.com.uy/en_us/items-and-searches/fees-for-listing).
- [Validador](https://developers.mercadolibre.com.uy/es_co/validador-de-publicaciones).
- [User Products](https://developers.mercadolibre.com.uy/productos-recibe-notificaciones/user-products).
- [D1 y transacciones por batch](https://developers.cloudflare.com/d1/worker-api/d1-database/).
