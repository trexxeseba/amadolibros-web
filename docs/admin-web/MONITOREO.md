# Detección de fallas de Amado — decisión técnica y entrega preparada

Fecha: 2026-09-08. Encargo de Seba: priorizar fotos que no cargan, fallas de la web y procesos trancados; reportes directamente al backend. Revisión de arquitectura independiente realizada por un agente de IA con enfoque CTO, contrastada por el agente principal con el código y documentación oficial. No intervino un CTO humano ni se contactó a terceros.

## Decisión

Reutilizar las señales existentes y sumar **Checkly + Sentry**, conectados a un receptor pequeño de incidentes. Mantener el panel privado de consulta, protegido por Access. No migrar a WooCommerce, no construir otro backend general, no contratar cuatro plataformas para el mismo problema.

La elección es una recomendación preparada, no una integración activada. La búsqueda individual de Sentry y Checkly en el catálogo de plugins de esta sesión no devolvió resultados. Su conexión con Amado puede hacerse mediante SDK/API/webhooks y no depende de instalar un plugin de ChatGPT. No se crearon cuentas, suscripciones, tokens ni destinos de notificaciones personales.

## Particularidades verificadas en este repositorio

| Componente | Qué ya permite saber | Límite relevante |
| --- | --- | --- |
| Astro en Cloudflare Pages + Functions | HTTP, errores de servidor, catálogo, fichas y compra | Un HTTP 200 no prueba que el contenido o las imágenes estén bien. `/api/health` no consulta catálogo. |
| `/api/status` en `functions/api/[[route]].js` | R2 accesible, fechas de sync, error registrado, atraso >26 h y posible bloqueo >45 min | Hace HEAD al catálogo; no valida todas sus imágenes ni la compra. Puede responder 503 con diagnóstico útil. |
| Worker sync | Estado de catálogo en KV, cron y mantenimiento de portadas | `runSync` puede registrar éxito de catálogo aunque `syncCoverMirror` falle. El catch de mantenimiento de portadas no persiste su fallo. |
| Componentes de imágenes | Fallback al logo cuando falla la portada | Esa recuperación visual no deja un incidente. Hay que captar la falla original antes del fallback. |
| D1 de pedidos | Estados de pedidos y fallas de correo registradas | No escribir incidentes nuevos en esta base de negocio. Rechazo de pago no equivale a falla técnica. |
| GA4 | Visitas y eventos `checkout_error` | Datos con demora; el mismo evento incluye pedidos vencidos e intentos repetidos. No es vigilancia en tiempo real. |
| Auditoría de comercio en GitHub Actions | Comprobaciones programadas de fichas e imágenes | Reutilizar su resultado como evidencia; no sustituye vigilancia frecuente. |
| Healthchecks.io | Adaptador existente, `SYNC_HEALTHCHECK_URL` | Documentación local indica activación pendiente; secret remoto no verificado. `healthcheck.js` usa `redirect:'error'`, incompatible con workerd según reproducción A07. Preparar arreglo separado antes de confiar en ese heartbeat. |

Los logs de Pages Functions documentados por Cloudflare son streaming y **no se guardan**. No asumir que configurar observabilidad en un Worker configura también Pages. [Documentación de Pages](https://developers.cloudflare.com/pages/functions/debugging-and-logging/).

## Plataformas y conexión directa

| Plataforma | Función propuesta | Cómo llega al panel | Coste / restricción verificada |
| --- | --- | --- | --- |
| Checkly — recomendada primero | Disponibilidad, contenido de API, navegación real Playwright, portadas visibles, latidos del cron | Webhook de falla/recuperación; HMAC SHA-256 en `x-checkly-signature` | Hobby $0: 10 monitores, 1.000 ejecuciones de navegador/mes, webhooks. Starter desde US$24/mes facturado anualmente, 3.000 ejecuciones. Frecuencia y ubicaciones consumen cuota. |
| Sentry — complemento | Errores JavaScript y servidor Pages/Workers; eventos explícitos de fotos | Integración interna: issue/alert webhooks y cambios de estado; API para conciliación si el plan la habilita | Developer gratis captura errores; página de precios reserva API/integraciones para Team, anunciado desde US$26/mes. Verificar modalidad y entitlement exacto antes de activar la conexión; no prometer webhooks gratuitos. |
| Better Stack — alternativa | Disponibilidad y heartbeat con gestión de incidentes | Webhooks de incidentes/monitores | Tiene plan gratuito; confirmar habilitación del webhook de salida en la cuenta/plan elegido. Alternativa a Checkly si se prioriza uptime; la evidencia revisada no sustituye una prueba de imágenes en navegador. |
| Cloudflare existente | Señales del origen y excepciones | `/api/status` ahora; captura de servidor en fase siguiente | Aprovecha recursos existentes; no vigila una caída completa del propio proveedor desde afuera. |

Fuentes consultadas el 2026-09-08: [Checkly precios](https://www.checklyhq.com/pricing/), [Checkly webhooks y firma](https://www.checklyhq.com/docs/integrations/alerts/webhooks/), [Sentry para Cloudflare](https://docs.sentry.io/platforms/javascript/guides/cloudflare/), [Sentry precios](https://sentry.io/pricing/), [Sentry webhooks](https://docs.sentry.io/integrations/integration-platform/webhooks/), [Better Stack precios](https://betterstack.com/pricing), [Better Stack webhooks](https://betterstack.com/docs/uptime/webhooks/). Precios base, sujetos a límites, impuestos y modalidad; no se hizo una compra.

Piloto propuesto de Checkly: una comprobación de navegador cada hora en una ubicación rotativa, más uptime cada 2 minutos y heartbeat de sync. Una ejecución horaria durante 30 días implica unas 720 ejecuciones de navegador antes de reintentos; dejar margen y mantener el recorrido corto. Cada cinco minutos serían 8.640 ejecuciones/mes antes de extras. Las suites Playwright pueden facturar más de una ejecución por duración: confirmar el tipo de check y cuota antes de activar. Empezar con muestras y ampliar según evidencia; no afirmar cobertura total del catálogo.

## Cómo detectar una foto rota de verdad

1. Registrar `error` de recursos en captura antes del fallback, con `currentSrc`, producto MLU y ruta pública sin parámetros.
2. Detectar imágenes que terminan con `naturalWidth === 0`; una URL 200 puede contener un archivo inválido o un logo de sustitución.
3. Medir demora sólo cuando la imagen está visible y debería cargarse. La carga diferida fuera de pantalla no es una falla.
4. Separar error original, imagen demorada y recuperación por fallback. El logo no significa que la portada original se recuperó.
5. En navegador externo, abrir home y una ficha real, comprobar catálogo con productos, recorrer imágenes visibles y verificar decodificación y ausencia de fallback inesperado. Incluir banner principal.
6. Pruebas de compra limitadas a navegación/validación inocua. No crear pedidos reales, iniciar pagos ni enviar formularios automáticamente.

Sin nombres, correos, direcciones, texto de formularios, cookies, tokens ni cuerpos de pedidos. Inicialmente sin Session Replay y sin trazar todas las visitas. Los reportes del navegador son señales no confiables hasta contrastarlas; origen permitido no equivale a autenticación y nunca debe haber un secret del receptor en el cliente.

## Receptor mínimo propuesto

Worker dedicado de ingestión + D1 separado para incidentes; panel con consultas de lectura. Endpoint de webhook fuera del hostname de Access del panel. No añadir un bypass a `/admin` ni debilitar su autenticación.

- Adaptadores separados por proveedor, validando firma sobre bytes originales con su secret; errores de firma fallan cerrados.
- Máximo de cuerpo y eventos, límites de frecuencia, rechazo de entornos desconocidos y descarte de campos extra.
- Identificador de entrega para deduplicar, timestamp verificado, ventana de antigüedad compatible con reintentos del proveedor. No aceptar que un aviso viejo reabra un incidente recuperado más tarde.
- Campos normalizados: proveedor, entorno, id de incidente/entrega, tipo, componente, ruta saneada, producto opcional, estado, primera/última detección, última verificación y evidencia técnica segura.
- Estados: reportado, confirmado, intermitente, demorado, recuperado, sin datos. “Resuelto” manualmente en Sentry no demuestra recuperación técnica: mostrar diferencia o confirmar con una comprobación nueva.
- Tabla de entregas con clave única y tabla de incidentes; actualización atómica, historial acotado, retención inicial propuesta de 30 días. Ingestión no depende de leer o escribir pedidos.
- Secret de cada proveedor sólo en servidor. Logs sin payloads crudos. Control de conexión con último aviso/latido y cuota: silencio no significa salud.

Checkly plantilla mínima propuesta (no activa): `provider=checkly`, `checkId={{CHECK_ID}}`, `deliveryId={{CHECK_RESULT_ID}}:{{ALERT_TYPE}}`, `state={{ALERT_TYPE}}`, `occurredAt={{STARTED_AT}}`, `region={{REGION}}`. Asociar ID de check a componente/ruta mediante configuración del servidor, en vez de confiar en texto arbitrario del proveedor. Falla y recuperación actualizan el mismo incidente; usar la firma documentada, no la URL como secret.

## Entrega preparada en este lote

- `readWebHealth()` consulta la URL productiva fija, con timeout y redirects rechazados. Acepta 503 diagnóstico, valida esquema/fecha/entorno, normaliza sólo campos permitidos y no convierte fallas de consulta en verde.
- Resumen y Funcionamiento muestran **Problemas de la web** antes de los números, con fecha, detalle del sync y cobertura explícita. Fotos, banners y vigilante externo figuran pendientes de conexión.
- Se conserva el enriquecimiento autorizado: comparación de períodos, visitas diarias y fichas más vistas.
- Incidencias de checkout ya no se presentan todas como fallas técnicas confirmadas.
- 31 pruebas focalizadas locales correctas. La prueba workerd fue ampliada a 16 escenarios, incluyendo 503 y redirects del diagnóstico; pendiente ejecución remota de este lote. El workflow privado verifica la fuente real antes de actualizar/presentar la nueva versión.

## Criterios antes de activar vigilancia completa

1. Conectar cuenta del proveedor elegido y verificar en su plan webhooks, retención y cuota. No se necesita contratar para seguir preparando código.
2. Preparar y probar receptor aislado con firma válida/inválida, duplicado, evento antiguo y recuperación. Un evento controlado debe aparecer y luego recuperarse en el panel.
3. Añadir sensor de imágenes y captura de servidor en Preview; inyectar portada rota, portada lenta y error API controlado. Verificar fallback, lazy loading y ausencia de datos personales.
4. Validar una comprobación real del proveedor externo y su entrega al receptor. El monitor debe detectar falla aunque nadie visite la tienda.
5. Presentar versión concreta para aprobar instrumentación productiva y arreglo del heartbeat/sync. El merge de la rama y la publicación de la tienda siguen pendientes; la revisión privada aislada sí está autorizada.

La actualización horaria de Analytics sigue preparada pero inactiva hasta el merge aprobado. No confundirla con un monitor continuo de errores.
