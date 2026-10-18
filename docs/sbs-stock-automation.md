# Actualización del stock SBS para Vintage

El workflow `SBS stock refresh (no publication writes)` descarga el enlace público
entregado por SBS a las 02:17 y 14:17 de Uruguay. GitHub puede retrasar los cron;
la fecha interna del proveedor, no el horario de descarga, determina la vigencia.
También admite ejecución manual sobre main. Una modificación del workflow en
main ejecuta una comprobación inicial.

Fuente predeterminada:
https://sbs-distribuidora-lista.s3.sa-east-1.amazonaws.com/Listado+completo+de+libros.xlsx

`SUPPLIER_FEED_URL` permite reemplazarla con otra URL HTTPS configurada como
secreto de production. No se registran la URL configurada ni su autorización.
`SUPPLIER_WEIGHT_UNIT` conserva la unidad del proveedor (kg por defecto).

## Validación e ingestión

- Se procesa el archivo completo, sin limitarlo a 1.000 o 20.000 filas.
- Se requieren fecha interna, ISBN, título, precio, disponibilidad y peso.
  Las listas PVP de precios no sustituyen un informe de stock.
- El parser acepta fechas como 25/8/2026 y 17/10/2026. Se conservan sus fechas
  reales. Se excluyen ISBN, precios y pesos inválidos y ISBN duplicados.
- Se rechazan fechas de más de 24 horas, futuras o anteriores al último stock
  confirmado. Un archivo idéntico usa el mismo ID SHA-256 y no se duplica.
- La carga se hace por lotes idempotentes de 200 filas. Solo un conteo completo
  permite confirmar el snapshot. Los snapshots ready son inmutables.
- Las tablas sbs_supplier_feeds/sbs_supplier_stock son independientes de
  ml_pub_feeds/ml_pub_stock: la actualización no activa el stock sync de Libros.
  Vintage consulta ambas fuentes en lectura para conservar pilotos anteriores.

El runner solo llama al endpoint autenticado `/publisher/sbs-stock`. Este
endpoint no dispone de acciones para adjuntar, aprobar, validar o publicar lotes,
ni importa clientes de Mercado Libre. No se generan lotes de 10.000 en este flujo.
La cola de publicaciones existente conserva sus ticks de cada diez minutos;
solo se retira su antigua descarga diaria SBS.

## Fallos visibles

La ejecución falla explícitamente si la descarga o validación no funciona. El
resumen de GitHub muestra el motivo y la fecha del proveedor sin exponer libros,
precios ni credenciales. No se guardan catálogos en logs, artefactos o Git.
El último snapshot completo permanece intacto; su vigencia sigue venciendo
normalmente y no se prolonga al descargarlo otra vez.

El 17/10/2026 el enlace público seguía entregando un archivo con fecha interna
25/08/2026 y Last-Modified 25/08/2026. Configurar el job no actualiza ese objeto
en los servidores de SBS: hasta que su fuente entregue stock vigente, el resultado
correcto es `supplier_stock_stale_or_future`, no una importación exitosa.

No se reemplazan las credenciales de ninguna cuenta y no se modifica el lote
Vintage ya revisado ni las publicaciones de Amado Libros.
