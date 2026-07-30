# Notificaciones por email

## EMAIL-1 — aviso interno de venta web

Cuando el webhook de Mercado Pago valida un pago `approved` en Producción:

1. el pedido se marca primero como `paid/approved` en D1;
2. se registra un evento `sale_notification` en `order_events`;
3. se envía el aviso interno mediante Resend;
4. el evento queda en `sent` o `failed`.

El correo incluye código de pedido, comprador, teléfono, libros, importe,
identificador de pago y datos de entrega.

El envío usa dos barreras contra duplicados:

- un evento único en D1 por pedido (`sale-email:<order_id>`);
- el header `Idempotency-Key` de Resend (`sale-notification/<order_id>`).

Un fallo de correo nunca revierte ni degrada un pago aprobado. Los fallos
transitorios de Resend (HTTP 429/5xx o timeout) se reintentan hasta tres veces.
Si no se recuperan, D1 conserva `status: failed` para que un webhook posterior
pueda volver a intentarlo.

Preview no envía correos internos.

## Configuración requerida

Antes de mergear/desplegar EMAIL-1, configurar en Cloudflare Pages,
exclusivamente en el ambiente Production:

| Variable | Tipo | Uso |
|---|---|---|
| `RESEND_API_KEY` | Secret | API key de Resend con permiso de envío |
| `SALES_NOTIFICATION_FROM` | Variable | Remitente en un dominio verificado, por ejemplo `Amado Libros <ventas@amadolibros.com>` |
| `SALES_NOTIFICATION_TO` | Variable | Destino interno; acepta varios correos separados por coma |

No escribir la API key en `wrangler.toml`, GitHub, logs, tests ni documentación.

El dominio usado en `SALES_NOTIFICATION_FROM` debe estar verificado en Resend.
Si falta cualquiera de las tres variables, el pago sigue funcionando pero el
correo se omite y se registra un warning sin exponer secretos.

## Validación segura

Las pruebas usan un `fetch` simulado. No llaman a Resend, Mercado Pago, D1
remoto ni Cloudflare.

Antes de habilitar en Producción:

1. confirmar las tres variables en Cloudflare Pages Production;
2. desplegar primero a Preview no dispara emails por diseño;
3. hacer una venta real controlada;
4. verificar el correo recibido y el evento `sale_notification` en D1;
5. repetir el webhook y confirmar que no llega un segundo correo.
