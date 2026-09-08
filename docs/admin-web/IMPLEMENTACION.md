# ADMIN-WEB-01 — primera entrega de consulta

## Decisión autorizada

Seba confirmó el 2026-09-07 un panel exclusivamente para amadolibros.com: visitas, productos, recorrido de compra, qué se trancó, pedidos, funcionamiento y gestión de banners/contenido. Solicitó avanzar con una ejecución que pudiera revisar y en la que pudiera confiar.

Esta primera entrega implementa la consulta. La edición de banners/contenido y las conexiones productivas son entregas posteriores del mismo alcance. No se reemplaza la web ni se instala WooCommerce. No es un gestor multicanal ni está centrado en Gaby y Lola.

## Protección concreta

- Base de trabajo: main `d380374775db7b5d2ef80b09ae97351ccdcd88f9`, confirmado con GitHub y `git fetch origin main` antes de crear la rama.
- Ruta nueva `/admin`, sin modificar la home, checkout, productos públicos ni sincronizador.
- Desactivada por defecto: `ADMIN_WEB_ENABLED` ausente produce 404. No se añade este flag a wrangler ni a ningún workflow.
- Requiere hostname exacto configurado, HTTPS, APP_ENV válido, JWT firmado por Cloudflare Access, emisor y audiencia correctos, token vigente y correo incluido en una lista explícita. No se confía en un header de email ni en una sesión de comprador.
- HTML y JSON exigen la misma autorización. Todas las respuestas son privadas, sin caché y no indexables.
- GET/HEAD exclusivamente. No se escriben pedidos, pagos, catálogo, KV ni D1. No se envían correos ni se crean compras de prueba.
- No se devuelven nombres, emails, teléfonos, direcciones, claves de pedido ni payloads internos. El listado usa código público, estado, pago, entrega y fecha.
- No se crea un login propio de contraseñas ni se porta el PR #328.

## Fuente y significado de cada dato

| Vista | Fuente | Alcance / limitación |
| --- | --- | --- |
| Visitas | Snapshot agregado de GA4 propiedad `543434807`, hostName limitado a los dos dominios de la web | Períodos cerrados 7/30 días hasta ayer, zona America/Montevideo; no tiempo real. Sin conexión, sin datos. |
| Actividad de compra | Eventos GA4 view_item, add_to_cart, begin_checkout, add_shipping_info, add_payment_info, purchase | Conteos de eventos, no personas enlazadas en un embudo. No se calcula una tasa de abandono inventada. |
| Errores de checkout | Evento existente checkout_error | Sólo errores registrados y recibidos; todavía no incluye desglose por código/paso. Cero no demuestra ausencia de fallas. |
| Pedidos | Tabla existente orders, consultas SELECT acotadas | Pedidos creados en período; estado al consultar. Máximo 50 registros. Pago rechazado no se etiqueta como error técnico. Importes y conciliación quedan fuera de esta primera entrega. |
| Correos | order_events de emails de cliente, transferencia e internos | Aceptado por proveedor no equivale a recibido. Sin evento no prueba éxito. |
| Productos | Catálogo público R2 que consume la web | Consulta/búsqueda/paginación; stock y precio según fuente; publicaciones, no ISBN únicos. |
| Actualización | meta.json público del catálogo | Alerta >26 h. Una actualización vieja no demuestra un proceso trancado. No consulta KV de diagnóstico compartido. |

## Conexión GA4 preparada, todavía no activada

Ya existe `.github/workflows/ga4-export.yml` con Workload Identity Federation y scope analytics.readonly. `scripts/admin-web-ga4-export.mjs` acepta el token temporal de esa conexión y genera dos snapshots privados. No crea credenciales ni usa una API key de medición como credencial de lectura. No se cambia el workflow existente.

El exportador verifica headers de respuesta, zona horaria, hostnames solicitados, conteos enteros y metadatos de muestreo/umbrales. Rechaza un informe limitado en lugar de presentarlo como completo. No copia parámetros de URL ni datos personales de pedidos. Produce archivos locales; no publica en Cloudflare.

El lector requiere binding nuevo y exclusivo `ADMIN_WEB_ANALYTICS_KV`, separado por entorno además de prefijo `production:`/`preview:`. No se reutiliza el namespace `AMADO_KV` compartido. Claves: `<entorno>:ga4:web:v1:7d` y `...:30d`. El escritor durable y su calendario deben implementarse/verificarse en el siguiente lote; no están activos. Nunca subir estos informes a GitHub público ni servirlos desde public/dist.

### Comprobación de conexiones — 2026-09-08

Seba pidió iniciar la conexión y luego informó que no puede instalar Cloudflare. El plugin no es requisito del runtime: se prepara una comprobación de las credenciales que ya usa este repositorio en GitHub Actions, sin extraerlas a la conversación ni crear otras.

- Google Drive: lectura confirmada del archivo GA4 CONTROL correspondiente a la propiedad esperada. Sus tablas están fechadas el 4 de septiembre. Falta evidencia de fechas exactas del período y filtro de hostname; no se inyectan en el panel como métricas vigentes. Hay otra copia vacía que no se usa. El documento se conserva intacto.
- GSC Wizard: acceso bloqueado por suscripción. HYPD: trial vencido y ninguna propiedad GA4 accesible. No se contrata ni modifica un plan.
- `.github/workflows/admin-web-connections.yml`: sólo en `codex/admin-web-observability`, al cambiar los archivos del diagnóstico o por dispatch manual en esa rama. Tres jobs independientes verifican GA4 7/30 días, lectores existentes D1 de Preview/Production y catálogo/metadatos públicos. GA4 reutiliza WIF con scope `analytics.readonly`; D1 reutiliza los secrets existentes. No se modifican IAM, Access, bindings o datos, y no hay deploy, cron ni subida de artifacts.
- `scripts/admin-web-connections.mjs`: consultas D1 exclusivamente SELECT, rechazo de múltiples sentencias o escrituras, URLs fijas y sin redirects. Las métricas y filas sólo viven en memoria: la salida pública contiene nombres de comprobaciones y estados, nunca informes, pedidos ni credenciales. Una fuente sin acceso produce `unavailable`, no cero.
- Pruebas locales: 15/15 entre el panel y el diagnóstico; SQLite real en `query_only`, destinos separados, SQL de escritura rechazado, reportes GA4 de ambos períodos y ausencia de datos del negocio en el resultado. Todavía no prueba acceso remoto.
- Identidad GitHub comprobada por conector: usuario autenticado y propietario `trexxeseba`, ID `214743208`; repositorio `1129825598`, público, permiso admin/push. Esta evidencia nueva establece el destino de confianza tras el bloqueo automático anterior. Main actualizado `0ae0a50` incorporado a esta rama; conflicto documental resuelto preservando ambos registros.

Referencia de la consulta de sólo lectura: [Cloudflare D1 Query](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/). El POST transporta SQL SELECT; no indica una escritura de base de datos.

## Activación posterior, sobre resultado aprobado

1. Verificar si ya existe una aplicación Access apta; crear/configurar una dedicada para `/admin` en el entorno de prueba si hace falta. Usar audiencia y acceso separados de producción. Comprobar política de sesión y correos autorizados.
2. Configurar `ADMIN_WEB_HOST`, `ADMIN_WEB_ACCESS_TEAM` (hostname `<equipo>.cloudflareaccess.com` sin esquema), `ADMIN_WEB_ACCESS_AUD`, `ADMIN_WEB_ALLOWED_EMAILS`; activar `ADMIN_WEB_ENABLED=true` únicamente en la versión privada aprobada.
3. Verificar binding D1 de Preview con datos de prueba y GA4 con un informe agregado autorizado. Comprobar que ningún estado de prueba se presenta como producción.
4. Ejecutar prueba humana de navegación y acceso denegado; contrastar GA4 contra la propiedad con el mismo período/filtro y pedidos contra D1 sin cambios.
5. Presentar evidencia y versión a Seba. Sólo entonces decidir merge/activación productiva. Una fusión por sí sola mantendría el panel apagado sin variables; no se autoriza ni se ejecuta en este lote.

Desactivar `ADMIN_WEB_ENABLED` cierra el panel; no es necesario revertir pedidos, catálogo ni contenido porque este lote no los escribe. La activación/desactivación y su propagación deben comprobarse, no prometerse instantáneas.

## Fuentes técnicas

- Cloudflare Access, validación JWT: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
- Google Analytics Data API, batchRunReports: https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/batchRunReports

## Estado de aceptación

Implementación inicial en rama. No desplegado, no operativo todavía.

Validación local al cierre del 2026-09-08:

- 10 pruebas focales aprobadas: firma RSA real en tests de Access, autorización, método sólo lectura, aislamiento, períodos Uruguay, consultas sobre SQLite en `query_only`, ausencia de PII, validación de snapshots GA4, paginación y escape de HTML.
- `scripts/validate-ci.sh`: el registro termina en `Validación completa OK`. Suites: 123 + 63 + 1.169 + 30 + 272 = **1.657 aprobadas, 0 fallos**. Build checkout OFF y ON completados y sus guardas aprobadas. La envoltura de la sesión reportó cancelación de aprobación de red al recoger el proceso; se conserva como evidencia el log completo con ese resultado final, sin atribuirle un exit code no recibido.
- `node scripts/admin-web-review.mjs` terminó con exit 0. La red de esta sesión no permitió consultar catálogo/meta en vivo: la vista previa muestra ese estado sin números inventados. No se diagnostica una caída del sitio a partir de esta limitación local.
- `git diff --check`: sin errores de whitespace.
- Vista de revisión original: `docs/admin-web/AMADO-panel-revision.html`. Su navegación no se probó en navegador y falló en el visor del usuario; ver corrección posterior. No era una instalación activa ni una conexión productiva.

Pendiente para el siguiente lote: comprobar Access existente/configurarlo en Preview, conectar exportación y publicación durable GA4, contrastar conteos reales, probar navegador y autorizar publicación. Verificar específicamente que los eventos server-side de compra tengan hostName: el filtro exclusivo de la web excluye eventos sin ese dato. La gestión de banners y contenido está registrada para una entrega posterior y no tiene controles de edición en esta versión.

### Guardado remoto y compilación de Functions pendientes

La revisión automática rechazó `git push -u origin codex/admin-web-observability`: indicó que subiría código a GitHub y que faltaba autorización explícita para ese destino / establecer la confianza del repositorio. No se eludió el bloqueo, no se reintentó por otro conector y no se abrió un PR. El commit y la vista de revisión quedan preparados localmente para que Seba pueda aprobar el envío concreto a `trexxeseba/amadolibros-web`, sin merge ni publicación de la tienda.

La compilación específica de Pages Functions con Wrangler no pudo ejecutarse: el paquete no está instalado y la versión fijada `4.107.0` no está en caché offline. No se cambió una dependencia ni el workflow por este motivo. Los builds Astro y las pruebas arriba descritas sí tienen evidencia. La compilación/routing de Pages queda como gate del PR/Preview, antes de activar nada.

Como comprobación local adicional del módulo nuevo, esbuild ya instalado compiló `functions/admin.js` y sus dependencias a ESM para navegador (30,9 KB, exit 0). Esto valida el bundle sin dependencias Node; no sustituye la verificación de routing en Pages.

### Corrección del archivo de revisión — 2026-09-08

Seba mostró `BlobNotFound` en `web-sandbox.oaiusercontent.com/admin?view=productos&days=7`. La copia anterior conservaba enlaces de servidor y dependía de un script para interceptarlos. La evidencia confirma que esa intercepción no ocurrió; no prueba la causa exacta de que el script no se ejecutara.

El generador produce ahora un único HTML con doce vistas presentes, seis secciones por dos períodos. Cada navegación usa un fragmento `#productos-7` y CSS `:target`, con Resumen como vista por defecto. Cero scripts, cero formularios y cero rutas de servidor dentro del archivo. Si no se aplican estilos, los destinos igualmente existen y la navegación por anclas sigue siendo válida.

El archivo generado se entrega por separado como `AMADO-panel-revision-corregido.html`; el código generador queda versionado y su directorio de salida predeterminado (`artifacts/admin-web-review/`) se ignora en Git. Se retira el HTML generado antiguo para no ofrecer otra vez la versión defectuosa.

Validación focal de la corrección: regresión de enlaces (96 destinos válidos, doce vistas, identificadores únicos y ausencia de JavaScript), más las diez pruebas focales anteriores. No se declara prueba en el navegador del usuario ni conexión de datos reales. La aprobación pendiente para subir código a GitHub no fue concedida por esta captura y no se reintenta el envío.
