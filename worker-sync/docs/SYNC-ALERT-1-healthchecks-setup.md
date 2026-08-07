# SYNC-ALERT-1 — configuración pendiente de Healthchecks.io

Esta guía documenta la activación posterior. El lote de código no crea la
cuenta, no configura destinatarios, no carga secretos y no envía pings reales.

## Check

- Nombre: `Amado Libros — Sync catálogo ML`
- Tipo: cron
- Expresión: `15 7 * * *`
- Zona horaria: UTC
- Equivalencia en Uruguay: 04:15
- Grace time: 25 minutos
- Notificación: correo
- Aviso de recuperación: activado
- Recordatorio periódico mientras permanezca caído: activarlo si el plan lo permite

## Secreto de Cloudflare

Guardar la Ping URL base generada por Healthchecks.io como secreto del Worker:

`SYNC_HEALTHCHECK_URL`

La URL debe usar HTTPS y el host `hc-ping.com`. No debe copiarse a
`wrangler.toml`, archivos de documentación, fixtures, commits ni logs.

## Prueba controlada posterior al deploy

1. Confirmar recepción de una señal de inicio.
2. Confirmar recepción de una señal de éxito.
3. Ejecutar una prueba de fallo controlada sin publicar catálogo.
4. Confirmar el aviso de fallo por correo.
5. Ejecutar una recuperación manual y confirmar el aviso de recuperación.
6. Verificar el siguiente cron de las 04:15 sin intervención manual.
