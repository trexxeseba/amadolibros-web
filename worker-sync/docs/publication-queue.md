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
Catálogo. Si Mercado Libre exige Catálogo para el producto, queda para revisión.
El primer alta ofrece una unidad: `+2` del proveedor es disponibilidad positiva,
no una cantidad exacta ni stock propio para entrega inmediata.

El límite diario es un techo configurable de hasta 10.000 intentos, contado por
día de Montevideo. No garantiza que Mercado Libre autorice ese volumen para esta
aplicación. Se respeta HTTP 429 y se difieren los reintentos.

## Idempotencia y recuperación

La base asigna una concesión exclusiva por lote. Cada ISBN tiene una reserva
única para la cuenta antes del POST de alta. Una respuesta perdida no dispara
otro POST: se busca el SKU estable y se conserva el estado `uncertain` cuando
todavía no se puede demostrar qué ocurrió. Los recibos publicados sobreviven a
reinicios. Los errores transitorios anteriores al alta se reintentan con espera.

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

- [Ítems y búsquedas](https://developers.mercadolibre.com.uy/es_ar/desarrollos-inmobiliarios/items-y-busquedas): migración del multiget a `/items/bulk` antes del 25/10/2026.
- [Búsqueda de productos](https://developers.mercadolibre.com.uy/en_us/items-and-searches/products-search).
- [Costos de publicación](https://developers.mercadolibre.com.uy/en_us/items-and-searches/fees-for-listing).
- [Validador](https://developers.mercadolibre.com.uy/es_co/validador-de-publicaciones).
- [User Products](https://developers.mercadolibre.com.uy/productos-recibe-notificaciones/user-products).
- [D1 y transacciones por batch](https://developers.cloudflare.com/d1/worker-api/d1-database/).
