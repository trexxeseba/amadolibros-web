# Medición para Google Ads

Estado al 5/11/2026. Qué evento mide qué, qué acción de Google Ads le corresponde y qué falta configurar del lado de Ads y GA4. Los nombres de los eventos no cambian: el único cambio de medición de la liquidación fue sumar parámetros a `whatsapp_click`.

## Eventos del sitio

| Evento GA4 | Cuándo se dispara | Parámetros |
|---|---|---|
| `whatsapp_click` | Clic en cualquier enlace a WhatsApp (escucha global en `analytics-events.js`). | `page_type`, `cta_location`, `topic`, `product_id`, `libro_id`, `origen`, `ruta`, `availability_type` |
| `book_request_submitted` | Solo cuando el servidor confirmó el pedido de `/pedir-libro` (`POST /api/book-request` respondió 201). No se dispara al tocar el botón. | `request_type`, `request_code` |

GA4 solo mide en `amadolibros.com` y `www.amadolibros.com`. En otros dominios (previews, pruebas) los eventos no se envían.

### Dónde se dispara `whatsapp_click` y con qué parámetros

| Página | Botón | `cta_location` | `topic` | `product_id` / `libro_id` |
|---|---|---|---|---|
| `/liquidacion` | "Lo quiero" de cada libro | `liquidacion_card` | tema del libro | id MLU del libro |
| `/liquidacion` | Recomendación por WhatsApp (cabecera) | `liquidacion_hero` | (vacío) | (vacío) |
| `/libros-agotados-importados-uruguay` | "Pedir búsqueda por WhatsApp" | `agotados_hero` | `libros_agotados_importados` | (vacío) |
| `/libros-agotados-importados-uruguay` | "Consultar por WhatsApp" | `agotados_cierre` | `libros_agotados_importados` | (vacío) |
| `/pedir-libro` | Envío del formulario | `book_request_form` | tipo de pedido | (vacío) |
| Ficha de libro | Cualquier enlace a WhatsApp | según el botón | (vacío) | id MLU de la ficha |

El id MLU y el tema salen de los atributos `data-mlu` y `data-topic` del botón. Un id que no tenga formato MLU no se envía.

## Acciones de conversión en Google Ads

Cuenta: Cuenta de Google Ads de Amado Libros (715-685-8182). Lectura del 5/11/2026, últimos 30 días.

| Evento | Acción en Ads | Estado |
|---|---|---|
| `whatsapp_click` | "AMADO LIBROS - WEB ACTUAL 6/2026 - NO BORRAR (web) whatsapp_click" (categoría Contacto) | Habilitada y recibe datos: 36 conversiones registradas. **No es principal**: el contador de conversiones principal marca 0, así que las ofertas no pueden optimizarse por ella. |
| `book_request_submitted` | No existe en la cuenta | Sin datos. Falta importarla desde GA4. |

## Qué falta configurar

Los nombres de los menús de Google Ads y GA4 pueden variar según la versión de la interfaz.

1. **Google Ads: marcar `whatsapp_click` como acción principal.** Objetivos y conversiones, Conversiones, Resumen, abrir la acción, "Configuración", "Objetivo y acción" y dejarla como principal.
2. **GA4: marcar `book_request_submitted` como evento clave.** Administrar, Eventos, activar "Marcar como evento clave". El evento aparece en la lista recién después de dispararse una vez en producción.
3. **Google Ads: importar `book_request_submitted` desde GA4.** Objetivos y conversiones, Nueva acción de conversión, Importar, Propiedades de Google Analytics 4.
4. **Evitar conversiones duplicadas.** El formulario de `/pedir-libro` dispara los dos eventos para un mismo pedido (primero `book_request_submitted`, después `whatsapp_click` al abrir WhatsApp). Si las dos acciones son principales, ese pedido cuenta dos veces. Recomendación: dejar `whatsapp_click` como principal y `book_request_submitted` como secundaria, o contar una sola por clic.
5. **Campaña "Liquidación | Búsqueda UY".** No figura en el reporte de los últimos 30 días. Confirmar que existe y mantenerla en pausa hasta completar los puntos 1 a 3.

## Cómo verificar

- En producción, abrir `/liquidacion`, tocar un "Lo quiero" y mirar en GA4, Informes, Tiempo real (o DebugView) que llegue `whatsapp_click` con `cta_location=liquidacion_card`, el `product_id` del libro y el `topic`.
- Enviar un pedido de prueba en `/pedir-libro` y ver que llegue `book_request_submitted` con un `request_code` que empieza con `PL-`.
- Si se corta el servidor de pedidos, el cliente igual llega a WhatsApp, pero no se cuenta `book_request_submitted`.

## URLs para los anuncios

- `https://www.amadolibros.com/liquidacion`
- `https://www.amadolibros.com/liquidacion?tema=<tema>`, por ejemplo `?tema=psicologia`, `?tema=literatura-ficcion`, `?tema=infantil-juvenil`, `?tema=esoterismo-tarot`, `?tema=educacion`, `?tema=desarrollo-personal`. Si un tema no tiene libros en la liquidación, la página redirige a `/liquidacion`.
- `https://www.amadolibros.com/libros-agotados-importados-uruguay`

El sitio conserva `gclid`, `gbraid`, `wbraid` y los parámetros `utm_*` en la medición.
