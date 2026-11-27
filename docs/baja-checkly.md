# Baja operativa de Checkly — 26/11/2026

Seba confirmó que activó el control de cobro en UptimeRobot y pidió dar de baja
Checkly. El alta gratuita de UptimeRobot se solicitó para
`https://www.amadolibros.com/api/checkout-health`; la cuenta ya recibía informes
de la portada y `/api/status`. La activación de UptimeRobot está confirmada por
el titular, no por una lectura autenticada del dashboard desde esta sesión.

## Qué hace la baja

- Apaga (`activated: false`) y silencia (`muted: true`) los seis controles
  identificados de Amado, incluida la antigua prueba de entrega al backend.
- Desuscribe los avisos de esos controles (`alertChannelSubscriptions: []`).
- Conserva controles, definición de las pruebas e historial. No elimina la cuenta ni datos.
- Verifica cada control después de modificarlo y vuelve a leer el inventario.
- El workflow `monitor-cobro.yml` deja de activar controles al desplegar.
- La CLI histórica rechaza `aplicar` y `simulacro`; `estado` sigue siendo de lectura.
- Se genera `artifacts/checkly-retired/report.json` con fecha, plan y estados,
  sin credenciales ni destinatarios. Solo ese resultado confirma la baja real.

El script utiliza la clave existente en GitHub, sin leerla ni mostrarla. La baja
solo permite modificar los IDs y nombres revisados; si aparece otro control
activo de Amado, se detiene antes de escribir para revisar su alcance.

## Cobertura después del cambio

UptimeRobot comprueba disponibilidad. `/api/status` devuelve un fallo HTTP si
el catálogo o su sincronización no están saludables; `/api/checkout-health`
comprueba configuración, base de pedidos, catálogo y servicios necesarios para
cobrar. Un HTTP correcto no demuestra una compra completa.

El recorrido de navegador de Checkly deja de ejecutarse. El workflow existente
`full-commerce-audit.yml` conserva las revisiones de imágenes y fichas después
de despliegues y semanalmente. No equivale a vigilancia continua del navegador
ni reemplaza la prueba en producción del rechazo de avisos sin firma.

La baja operativa no elimina una cuenta ni modifica su facturación. El plan
actual se informa en el resultado; no se debe afirmar que se canceló una
suscripción paga basándose únicamente en haber apagado los controles.
