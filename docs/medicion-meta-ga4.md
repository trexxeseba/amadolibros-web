# Medición de ventas: Meta (Pixel + API de conversiones) y GA4 de transferencias

Todo está **apagado en producción**. Este documento dice qué hay que cargar,
dónde, y en qué orden, para probarlo en Preview y después encenderlo.

Hay **dos lugares distintos** y no se configuran juntos:

| Componente | Proyecto en Cloudflare | Qué hace |
|---|---|---|
| **Pages** | `amadolibros-web` (Workers & Pages → amadolibros-web → Settings → Variables and Secrets) | Pixel en el navegador, banner de cookies, `/api/tracking/*`, webhook de Mercado Pago, panel. |
| **Worker** | `amadolibros-sync` (Workers & Pages → amadolibros-sync → Settings → Variables and Secrets) | Cron cada 5 minutos: reintenta compras de Meta y de GA4 que quedaron pendientes. |

> **Cargar credenciales en Pages no configura el Worker.** Si sólo se cargan en
> Pages, la compra sale una vez desde el webhook o el panel, pero los
> reintentos del cron no corren.

## Variables

### Pages, entorno **Preview** (pruebas)

En Preview sólo se usa un **Pixel de pruebas separado**. El Pixel y el token
productivos se ignoran aunque estén cargados.

| Nombre | Tipo | Valor |
|---|---|---|
| `META_TRACKING_ENABLED` | variable | `true` (ya está en `wrangler.toml`) |
| `META_TEST_PIXEL_ID` | variable | ID del Pixel de pruebas |
| `META_TEST_CAPI_TOKEN` | **secreto** | Token de la API de conversiones del Pixel de pruebas |
| `META_TEST_EVENT_CODE` | variable | Código de «Eventos de prueba» (Events Manager → Pixel de pruebas → Eventos de prueba). **Sin él, Preview no manda nada**, ni desde el navegador ni desde el servidor. |

### Pages, entorno **Production** (cuando se decida encender)

| Nombre | Tipo | Valor |
|---|---|---|
| `META_TRACKING_ENABLED` | variable | `true` para encender Meta |
| `META_PIXEL_ID` | variable | ID del Pixel productivo |
| `META_CAPI_TOKEN` | **secreto** | Token de la API de conversiones del Pixel productivo |
| `GA4_TRANSFER_PURCHASE_ENABLED` | variable | `true` para mandar a GA4 las ventas por transferencia (interruptor independiente de Meta) |

`GA4_MEASUREMENT_ID` y `GA4_API_SECRET` ya existen y no cambian.

### Worker `amadolibros-sync` (reintentos)

`APP_ENV = "production"` ya está en `worker-sync/wrangler.toml`.

| Nombre | Tipo | Valor |
|---|---|---|
| `META_TRACKING_ENABLED` | variable | `true` (igual que en Pages producción) |
| `META_PIXEL_ID` | variable | ID del Pixel productivo |
| `META_CAPI_TOKEN` | **secreto** | El mismo token que en Pages producción |
| `GA4_TRANSFER_PURCHASE_ENABLED` | variable | `true` si está encendido en Pages |

Las variables no secretas pueden ir en `worker-sync/wrangler.toml`; el token,
siempre como secreto (`npx wrangler secret put META_CAPI_TOKEN` dentro de
`worker-sync/`, o desde el panel de Cloudflare). **Nunca en el repo.**

## Orden para probar en Preview

1. Crear un Pixel de pruebas en Meta Events Manager, separado del productivo.
2. Cargar en Pages → Preview: `META_TEST_PIXEL_ID`, `META_TEST_CAPI_TOKEN`
   (secreto) y `META_TEST_EVENT_CODE`.
3. Volver a desplegar la vista previa del PR (un push o re-run del workflow).
4. Abrir la vista previa, aceptar el banner de cookies y recorrer:
   ficha → agregar al carrito → checkout → pago de prueba de Mercado Pago.
5. En Events Manager → Pixel de pruebas → Eventos de prueba deben aparecer
   PageView, ViewContent, AddToCart, InitiateCheckout y Purchase, cada uno
   **una vez** (navegador y servidor deduplicados por `event_id`).
6. Clic en WhatsApp → Contact.
7. Rechazar desde «Cookies» en el pie → no deben aparecer más eventos.

## Qué no cubre esto

- El límite de solicitudes de `/api/tracking/meta` es por isolate. Para
  producción conviene sumar una regla de rate limiting de Cloudflare sobre
  `/api/tracking/*`.
- El Pixel, por diseño de Meta, toma la URL de la página por su cuenta. Lo
  que manda el servidor sí sale sólo con `utm_*`, `fbclid` y `gclid`.
