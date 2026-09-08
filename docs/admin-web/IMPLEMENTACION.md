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
- Pruebas locales: 15/15 entre el panel y el diagnóstico; SQLite real en `query_only`, destinos separados, SQL de escritura rechazado, reportes GA4 de ambos períodos y ausencia de datos del negocio en el resultado. La ejecución remota siguiente sí confirma acceso a las fuentes.
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

### Historial del guardado remoto y compilación de Functions pendiente

La revisión automática rechazó inicialmente el push por autorización/confianza del destino no establecida. Antes de intentar nuevamente se verificaron la identidad autenticada, la propiedad del repositorio y permisos admin/push mediante el conector. El nuevo intento de git no pudo autenticar el shell; el conector autenticado guardó el árbol exacto de archivos probados (SHA 948e1becebef2fa1014881f01209d2072914b579), commit 2ff5967ed26e71f1b81020fb96d58ee3725b6602, sobre main 0ae0a50. Se creó sólo la rama de revisión. No hay PR ni merge a main, y no se desplegó la tienda. El bloqueo remoto quedó resuelto con evidencia nueva de confianza, sin modificar controles de aprobación.

La compilación específica de Pages Functions con Wrangler no pudo ejecutarse: el paquete no está instalado y la versión fijada `4.107.0` no está en caché offline. No se cambió una dependencia ni el workflow por este motivo. Los builds Astro y las pruebas arriba descritas sí tienen evidencia. La compilación/routing de Pages queda como gate del PR/Preview, antes de activar nada.

Como comprobación local adicional del módulo nuevo, esbuild ya instalado compiló `functions/admin.js` y sus dependencias a ESM para navegador (30,9 KB, exit 0). Esto valida el bundle sin dependencias Node; no sustituye la verificación de routing en Pages.

### Corrección del archivo de revisión — 2026-09-08

Seba mostró `BlobNotFound` en `web-sandbox.oaiusercontent.com/admin?view=productos&days=7`. La copia anterior conservaba enlaces de servidor y dependía de un script para interceptarlos. La evidencia confirma que esa intercepción no ocurrió; no prueba la causa exacta de que el script no se ejecutara.

El generador produce ahora un único HTML con doce vistas presentes, seis secciones por dos períodos. Cada navegación usa un fragmento `#productos-7` y CSS `:target`, con Resumen como vista por defecto. Cero scripts, cero formularios y cero rutas de servidor dentro del archivo. Si no se aplican estilos, los destinos igualmente existen y la navegación por anclas sigue siendo válida.

El archivo generado se entrega por separado como `AMADO-panel-revision-corregido.html`; el código generador queda versionado y su directorio de salida predeterminado (`artifacts/admin-web-review/`) se ignora en Git. Se retira el HTML generado antiguo para no ofrecer otra vez la versión defectuosa.

Validación focal de la corrección: regresión de enlaces (96 destinos válidos, doce vistas, identificadores únicos y ausencia de JavaScript), más las diez pruebas focales anteriores. No se declara prueba en el navegador del usuario ni conexión de datos reales. La aprobación pendiente para subir código a GitHub no fue concedida por esta captura y no se reintenta el envío.


### Resultado remoto confirmado — 2026-09-08 11:51 UTC

[Run 34222874855](https://github.com/trexxeseba/amadolibros-web/actions/runs/34222874855), commit `2ff5967`, tres jobs completados con éxito. Se leyeron también sus logs para verificar cada estado:

| Comprobación | Resultado |
| --- | --- |
| GA4, 7 días cerrados, sólo web | ok |
| GA4, 30 días cerrados, sólo web | ok |
| Lectores de pedidos y correos, D1 Preview | ok |
| Lectores de pedidos y correos, D1 Production | ok |
| Catálogo que consume la web | ok |
| Fecha de actualización del catálogo | ok |

Esto demuestra que las credenciales existentes permiten las lecturas necesarias, sin instalar Cloudflare en ChatGPT. No demuestra acceso al panel ni actualización automática: aún falta crear/verificar almacenamiento privado del snapshot, su escritor/calendario, el binding del panel y Cloudflare Access. No se archivaron ni publicaron métricas o pedidos del diagnóstico. Cero escrituras de negocio, cero cambios de IAM/Access y cero deploys en este lote.


## Continuación: persistencia y revisión privada conectada

Autorizada por Seba al pedir seguir adelante después de verificar las conexiones. La lectura de Access, organización, namespaces y subdominio Workers devolvió HTTP 200 en [run 34278982091](https://github.com/trexxeseba/amadolibros-web/actions/runs/34278982091). Main 1aaaba8 incorporado antes de este lote.

- Snapshot v2: ambos períodos se guardan en una única clave `preview:ga4:web:v2`, dentro del namespace exclusivo `amadolibros-admin-analytics-preview`. Todos los informes se validan antes de escribir y se verifica la lectura posterior. Un error de GA4 conserva el último valor; el lector rechaza períodos incorrectos o datos incompletos. Se serializan sólo campos del contrato, sin tokens, queries ni PII.
- Worker nuevo `amadolibros-admin-preview`, separado de Pages y del sincronizador. Ruta `/admin`; URLs de versión desactivadas, sin custom routes y sin cron en el Worker. Sólo este Worker recibe bindings de consulta a pedidos productivos y al KV propio. La interfaz indica revisión con datos reales; `APP_ENV=preview` identifica el alojamiento y `ADMIN_WEB_DATA_ENV=production` identifica el origen de pedidos.
- Access nuevo limitado al hostname exacto del Worker y al correo del titular verificado en GitHub. Se usa un proveedor de identidad existente. Una aplicación encontrada con otro nombre/dominio o una política distinta de la lista explícita se rechaza, sin modificarla. No se cambian otras políticas ni se crea un proveedor de identidad.
- El workflow de revisión prueba el código, actualiza GA4, prepara Access, despliega sólo el Worker dedicado y verifica que HTML/JSON y una cabecera de identidad falsa se redirijan al login privado. No ejecuta la publicación de la tienda.
- Actualización horaria preparada en `.github/workflows/admin-web-refresh.yml`, minuto 17. Comparte exclusión con el despliegue para impedir escrituras concurrentes. Sólo actualiza un namespace ya existente; no crea recursos ni despliega. **El calendario no corre desde esta rama: requiere que el workflow aprobado llegue a main.**
- Validación local: 21/21 pruebas focales; bundle ESM del Worker de 32.800 bytes; YAML de ambos workflows parseado. Pruebas de almacenamiento completo, períodos, rechazo de namespace compartido, conservación ante fallas, política del titular y rutas anónimas.
- Aún se debe verificar el despliegue remoto y el primer ingreso real del titular. La validación de login del workflow no suplanta a Seba ni solicita códigos de acceso.

Fuentes técnicas: [Cloudflare Access para Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/), [crear namespace KV](https://developers.cloudflare.com/api/resources/kv/subresources/namespaces/methods/create/), [guardar un valor KV](https://developers.cloudflare.com/api/resources/kv/subresources/namespaces/subresources/values/methods/update/).


### Entrega privada verificada

- URL: https://amadolibros-admin-preview.undiaes.workers.dev/admin.
- [Run 34280416597](https://github.com/trexxeseba/amadolibros-web/actions/runs/34280416597), código `81f9c37`, resultado **success**. Pruebas 22/22; snapshot actualizado y releído 2026-09-08 21:24:36 UTC; Access del titular verificado; Worker desplegado, versión `aee64b61-6129-4745-afac-3b3531f069bf`; tres comprobaciones reales de login aprobadas, sin autenticar a Seba.
- [CI 34280483216](https://github.com/trexxeseba/amadolibros-web/actions/runs/34280483216): 1.680 tests, cero fallos, dos builds, `Validación completa OK`.
- Fallo histórico: run 34279948776 publicó correctamente pero su comprobación inmediata obtuvo 404. Una lectura posterior devolvió 302 al dominio de Access; la regresión limita los reintentos a ese 404, nunca tolera 200 ni un redirect ajeno. La siguiente ejecución privada pasó completa.
- [PR #335](https://github.com/trexxeseba/amadolibros-web/pull/335) en borrador. El calendario horario aún no está activo: requiere incorporar el workflow a main. El merge también dispara el despliegue habitual de la tienda y queda pendiente de aprobación explícita de Seba y los controles del PR. El primer ingreso del titular debe confirmarlo él; no se le solicitan ni se interceptan códigos OTP.
- La compilación/routing del Worker separado quedó verificada por Wrangler 4.107.0 en el run exitoso. Los límites anteriores de compilación local de Wrangler ya no bloquean esta revisión privada.
# Incidencia de ingreso — 2026-09-08

Seba mostró el 403 generado por `/admin`. La captura no distingue sesión
ausente, claims incompatibles o fallo de firma/certificados. El login anónimo
redirige correctamente y las claves públicas de Access responden HTTP 200.
La validación original con una identidad sintética válida también pasa en
workerd; no se atribuye la incidencia a una causa exacta sin esa evidencia.

Se añade la cookie `CF_Authorization` como transporte alternativo únicamente
cuando falta `Cf-Access-Jwt-Assertion`. Ambas vías verifican el JWT completo.
Una cabecera inválida nunca se rescata con la cookie; cookies duplicadas se
rechazan. No se modifica la política, la audiencia ni la lista de titulares.
Cloudflare documenta ambos transportes en [Validar JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).

La respuesta de rechazo ofrece reingreso y una referencia cerrada: A01
configuración, A02 token ausente/ambiguo, A03 formato/algoritmo, A04
emisor/audiencia, A05 vigencia, A06 identidad, A07 certificados, A08 firma.
No se exponen ni registran valores de tokens, claims, cookies o datos del
negocio. HTML y JSON siguen rechazándose antes de consultar las fuentes.

Validación: 24 pruebas focalizadas y 9 escenarios en workerd mediante
`scripts/admin-web-runtime-check.mjs`, con claves e identidades sintéticas.
El ensayo se ejecuta localmente y antes de cada publicación privada; no
publica un acceso de prueba ni amplía los permisos. Ajuste publicado en el
mismo enlace: commit `d56c04d`, [run 34282206299](https://github.com/trexxeseba/amadolibros-web/actions/runs/34282206299)
**success**, versión Worker `9cbf9402-6649-4224-9668-9c174747aede`. Los 24
tests, 9 escenarios y 3 verificaciones privadas pasaron en Actions. GA4
actualizado y releído a las 21:44:17 UTC. Pendiente: reintento de Seba con su
sesión real. No se fusionó main ni se activó el calendario horario.
