# Alarmas del cobro

Qué avisa cuando la web deja de poder cobrar, a quién, y qué queda fuera.

## Cómo funciona

Checkly (cuenta que ya existía, plan gratuito) corre dos controles cada 10 minutos
desde afuera de Cloudflare. Si un control falla dos veces seguidas (20 minutos),
manda un correo a las casillas de `SALES_NOTIFICATION_TO` de producción. Cuando
vuelve a andar, manda otro correo de recuperación.

Los controles se definen en `scripts/monitoring/checkly-cobro.mjs` y se aplican con
el workflow **Alarmas del cobro (Checkly)** (`.github/workflows/monitor-cobro.yml`):

| Acción | Qué hace |
| --- | --- |
| `estado` | Sólo lee: plan, controles, si fallan ahora, canales de aviso. |
| `aplicar` | Crea o actualiza los canales de correo y los controles. Corre solo al fusionar cambios de estas alarmas a `main`, después de esperar a que `/api/checkout-health` responda bien. |
| `simulacro` | Crea un control temporal que falla a propósito, lo recupera y lo borra. Sirve para comprobar que los dos correos llegan. Avisa sólo a la primera casilla. |

Además, la comprobación posterior a cada deploy (`scripts/smoke-production.js`)
lee `/api/checkout-health` y deja el deploy en rojo si alguna pieza del cobro está caída.

## Qué cubre el monitor

**Control 1 — `GET /api/checkout-health`.** Responde 200 sólo si todo esto está en pie:

| Pieza | Falla que detecta |
| --- | --- |
| `configuracion` | Falta o está mal `APP_ENV`, `MP_COLLECTOR_ID`, `CANONICAL_ORIGIN` o `ALLOWED_HOSTS`. |
| `cobros_encendidos` | `CHECKOUT_ENABLED` quedó apagado. |
| `base_de_pedidos` | La base de pedidos no está conectada, no responde o le falta una tabla. |
| `catalogo` | El catálogo que valida el carrito no se puede leer o está vacío. |
| `verificacion_anti_robots` | Falta la clave de Turnstile. |
| `mercado_pago` | La credencial de Mercado Pago falta, venció, fue revocada, es de otra cuenta, o Mercado Pago no responde. |
| `clave_de_avisos_de_pago` | Falta la clave con la que se validan los avisos de Mercado Pago. |
| `correo_de_avisos` | Falta la clave o la configuración del correo de avisos de venta. |

**Control 2 — aviso de Mercado Pago sin firma.** Manda un aviso sin firma a
`/api/webhooks/mercadopago` y espera el rechazo `401`. Detecta que la ruta de avisos
no esté publicada, que responda con error, o que haya quedado aceptando avisos sin firma.

**Controles de septiembre.** `/api/status` (sincronización del catálogo), `/catalogo`
y el recorrido de portadas ya existían, pero avisaban a un receptor que nadie mira.
`aplicar` les suma el correo.

Ningún control crea pedidos, pide un pago, manda datos de una persona ni escribe en la base.

## Qué NO cubre: hace falta una compra de prueba

El monitor comprueba que las piezas estén, no que una compra termine bien. Esto
sólo se ve comprando:

- Que el desafío anti-robots se resuelva en un navegador real y el pedido se cree.
- Que Mercado Pago muestre el importe correcto, las cuotas y los medios de pago esperados.
- Que el aviso firmado de un pago aprobado llegue y deje el pedido como pagado.
- Que salgan el correo al equipo y el correo al cliente, y que lleguen.
- Que la página de regreso muestre "Pago confirmado".
- Que la compra aparezca en GA4 y en Meta.
- El camino de transferencia completo, hasta marcarla recibida en el panel.
- Que la clave de avisos de pago sea la correcta (el monitor sólo ve que existe).
- Errores de pantalla del carrito en un celular o navegador puntual.

Cuándo hacer la compra de prueba: después de cambiar algo del carrito, de los
pedidos o de Mercado Pago, y al rotar una credencial.

## Qué más queda fuera

- **Demora del aviso:** hasta 20 minutos desde que empieza la falla, por las dos corridas seguidas.
- **Pagos que Mercado Pago cobró y la web no registró:** eso es conciliación, no disponibilidad.
- **Consulta a Mercado Pago guardada:** un resultado bueno vale 5 minutos y una falla 1 minuto, por entorno, cuenta y credencial (un resultado de una vista previa no sirve para producción; al cambiar la credencial se consulta de nuevo). Las llamadas simultáneas comparten una sola consulta. Tras corregir una credencial, el diagnóstico puede tardar hasta 1 minuto en volver a `ok`.
- **Freno de consultas entre procesos:** si KV no responde, el freno es por proceso de Cloudflare; procesos distintos pueden hacer una consulta cada uno por minuto.
- **Caída de Checkly:** si Checkly deja de correr, no avisa nadie. El workflow en `estado` muestra la última corrida de cada control.
- **Límites del plan gratuito:** si la cuenta se queda sin corridas, los controles se frenan. `estado` muestra el plan vigente.

## Si llega un correo de falla

1. Abrir <https://www.amadolibros.com/api/checkout-health>: dice qué pieza está en `falla`.
2. `mercado_pago`: revisar la credencial en Cloudflare Pages (Producción) y el estado de Mercado Pago.
3. `base_de_pedidos` o `catalogo`: revisar Cloudflare (D1, R2) y la última sincronización en `/api/status`.
4. Cualquier clave faltante: volver a cargarla en Cloudflare Pages y redesplegar.
5. Si la falla empezó justo después de un deploy: volver a la versión anterior (`docs/environments.md`).
