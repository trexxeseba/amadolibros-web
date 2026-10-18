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

El runner registra cada intento automático en `sbs_supplier_events`, con hora,
fecha real y código de fallo. El panel Vintage muestra por separado esa última
descarga y la última carga manual. Los diagnósticos se limitan a 100 registros y
no incluyen catálogos, costos, direcciones privadas ni credenciales.

## Carga manual para el piloto

En `/panel/meli-vintage-piloto`, elegir el informe completo de stock `.xlsx` y
pulsar **Cargar Excel y actualizar estos 5 ISBN**. El lector corre en un Web Worker
del navegador, con fflate 0.8.3 servido desde el propio dominio y su licencia MIT.
No usa CDN, evalúa fórmulas ni transmite el archivo completo. Extrae exclusivamente
los cinco ISBN que muestra el piloto, sus datos y la fecha interna del proveedor.
El servidor verifica sesión del panel, origen, cinco ISBN exactos, disponibilidad,
vigencia y versión de la muestra. Las listas PVP no sustituyen un Excel de stock.

La proyección de cinco filas tiene un ID independiente del snapshot automático
completo. Solo se actualiza el lote Vintage no aprobado y sin recibos de creación.
Una reserva y una transacción impiden cargas simultáneas o carreras con aprobación.
El resto de candidatas queda fuera del piloto, sin reemplazos automáticos.

Si costo, peso o metadatos cambian, se borran los payloads anteriores y se validan
de nuevo los mismos cinco antes de mostrar aprobación. Si los datos coinciden,
se preservan los payloads y precios revisados. Cargar no publica ni aprueba.
La fecha vencida se muestra como **stock vencido**, aunque el lote estuviera ready.

Después de publicar, el botón **Verificar publicaciones creadas en Mercado Libre**
realiza hasta cinco GET autenticados con Vintage y comprueba seller, ISBN/SKU,
precio, moneda, cantidad, disponibilidad y estado. No modifica los ítems. Un
resultado no comprobado o discordante se muestra para revisión, nunca como éxito.
La aprobación de los cinco precios continúa exclusivamente en el panel.

El 17/10/2026 el enlace público seguía entregando un archivo con fecha interna
25/08/2026 y Last-Modified 25/08/2026. Configurar el job no actualiza ese objeto
en los servidores de SBS: hasta que su fuente entregue stock vigente, el resultado
correcto es `supplier_stock_stale_or_future`, no una importación exitosa.

No se reemplazan las credenciales de ninguna cuenta y no se modifica el lote
Vintage ya revisado ni las publicaciones de Amado Libros.
