# Publicador Vintage: diagnóstico y entrega para revisión

Fecha: 18/10/2026, America/Montevideo. Base revisada: PR #458,
`da6fdf7150b1ead722fd03b9f87d61bef4048dd5`. Rama de trabajo independiente:
`codex/vintage-catalog-telemetry`. No se modificó la carpeta del proceso activo,
no se reinició el publicador y no se fusionaron #458 ni #459.

## 1. Qué puede confirmarse

- Chrome mostraba la cuenta **Amado Libros**, `amadolibro@gmail.com`, al abrir
  el menú de cuenta de Publicaciones. No era la cuenta Vintage del piloto Excel.
- Cloudflare permitió entrar mediante la sesión existente. En `amadolibros-sync`
  → Observabilidad aparecía **“Workers Observability está desactivado”**. En su
  información general, registros y trazas figuraban deshabilitados.
- La implementación de producción de Pages `amadolibros-web`, commit `f852251`,
  ofrecía **“Registros en tiempo real”** y **“Iniciar flujos de registros”**,
  sin un selector de historial para esos horarios. No se inició un flujo nuevo.
- El código de `functions/api/webhooks/mercadolibre.js` en ese commit no consulta
  `/products/*`: el evento de ítem se registra y se difiere al Worker; órdenes
  consulta `/orders/{id}`. Esto describe esa ruta de código, no una medición
  temporal de todos los servicios de la cuenta.

**Resultado del cruce histórico: no se puede determinar.** No es correcto afirmar
“SÍ coincide” ni “NO coincide” a partir de cron configurados o ausencia de logs.
No se activó observabilidad ni se alteró el Worker de Libros para esta revisión.

| Hora Uruguay 18/10 | Fecha y hora UTC | Endpoint informado por el operador | Cruce con llamadas del Worker |
|---|---|---|---|
| ~19:08 | 18/10 ~22:08Z | No registrado | No verificable con el historial disponible |
| 19:56:57 | 18/10 22:56:57Z | GET /products/search | No verificable con el historial disponible |
| 20:30:15 | 18/10 23:30:15Z | GET /products/search | No verificable con el historial disponible |
| 20:44:39 | 18/10 23:44:39Z | GET /products/search | No verificable con el historial disponible |
| 21:36:01 | 19/10 00:36:01Z | GET /products/search | No verificable con el historial disponible |

Los cuatro registros con endpoint, su ausencia de Retry-After y el quinto evento
aproximado proceden del informe suministrado por Seba; no se leyeron los archivos
del motor en la PC. El lote de 440 y su relanzamiento a las 21:43 también son
datos del operador, no estados nuevos comprobados desde este entorno.

## 2. Hipótesis y límites de la evidencia

La documentación oficial indica que el control se aplica principalmente por
Client ID y por endpoint. La app compartida `4741021817925208` permite una
interferencia entre consumos, pero no demuestra que el consumo de `/products/{id}`
comparta exactamente la cuota de `/products/search`.

El código de Libros contiene un enriquecimiento que consulta `/products/{id}`.
Sin embargo, el cron de cada minuto llama al publicador y puede no hacer ninguna
consulta si no hay un run elegible. El de cinco minutos mantiene portadas,
reintenta medición de compras y revisa stock según sus interruptores; no equivale
a un sync completo de cientos de lotes cada cinco minutos. El sync completo
diario está programado a las 07:15 UTC, fuera de las ventanas de este incidente;
una ejecución manual sería otra posibilidad, no confirmada.

Para probar coincidencia en una futura ventana haría falta registrar solicitudes
salientes de ambos servicios por método/endpoint y minuto, con relojes UTC, o
conseguir del soporte ML la trazabilidad de la app. Los contadores nuevos cubren
Vintage. Instrumentar Libros queda fuera de esta entrega porque se pidió no tocarlo.

## 3. Medición y cambios de esta rama

1. Contadores de solicitudes que realmente llegan al fetch de ML. La caché no
   suma solicitudes de red. Se separan inventario, observaciones de libros y
   reconciliaciones; se conservan los 429 reales en el archivo existente.
2. Caché de cinco minutos para una búsqueda exacta positiva y para el detalle
   activo de un libro de catálogo. La búsqueda se identifica por ISBN y el detalle
   por product ID; prepare conserva las comprobaciones de correspondencia entre
   ambos. No se cachean vacíos, ambigüedades, inactivos ni errores.
3. Presupuesto propio de cinco segundos para `/products/search`, además de los
   dos segundos globales existentes. Strikes persistentes por método/endpoint;
   otros recursos ya no borran el historial del endpoint que recibió 429.
4. Se mantienen ambas validaciones `/items/validate`, tarifas, reserva por ISBN,
   stock/precio, verificación del seller y lectura posterior. Se conserva el
   diferimiento ya agregado por #458; una foto pendiente no puede ocultar un
   seller/ISBN/precio incorrecto ni otra causa de moderación.

No se eliminó la búsqueda por `catalog_listing:false`: ese es un resultado de
la preparación, y la búsqueda aporta edición/ISBN, categoría, atributos y tapa,
además de detectar Catálogo obligatorio. Quitarla sin una fuente equivalente
verificada reduciría controles de identidad.

**Medición de producción pendiente.** La instrumentación comienza cuando se
ejecute esta versión. En una prueba con servidor simulado y la implementación API
real se midieron 15 solicitudes para el primer libro y 12 para un ISBN distinto
con categorías/atributos calientes. No son un promedio medido del lote de Seba.

| Grupo, recorrido simulado con caché caliente | Llamadas reales del caso de prueba |
|---|---:|
| Duplicados: sku y seller_sku | 2 |
| Identidad de cuenta: prepare y create | 2 |
| Búsqueda y detalle de producto | 2 |
| Tarifas: prepare y create | 2 |
| Validación: prepare y create | 2 |
| Creación | 1 |
| Lectura posterior | 1 |
| **Total** | **12** |

Los dos GET de categorías/atributos son caché; la preferencia de envío ya está
caliente. Catálogo con hijos, variantes de envío, reintentos y fotos pendientes
pueden aumentar ese conteo. La caché de catálogo mejora reintentos; no elimina
las dos consultas para ISBNs que todavía no se procesaron.

Con 12 llamadas y una separación global de 2 s, el techo sostenido es de unas
150 altas/h antes de sumar latencia y otras esperas. El objetivo 250/h exige
otro diseño o menor carga por libro validada con evidencia. Estas mejoras no lo
garantizan. El publicador oficial Excel merece el piloto por separado: Mercado
Libre anuncia un máximo de 10.000/día y exige una planilla descargada de esa
misma cuenta; no hay base para describirlo como un servicio sin límites.

## 4. Pedido de revisión/aumento de cupo — borrador, no enviado

**Asunto: Revisión de HTTP 429 en GET /products/search — app 4741021817925208, Uruguay**

Hola, equipo de Integraciones de Mercado Libre:

Tenemos un publicador propio de libros para Uruguay. La app es
4741021817925208; la cuenta afectada es Amado Vintage, seller 2341378249.
La misma app también tiene autorizada la cuenta Amado Libros, seller 440298103.

El 18 de octubre recibimos HTTP 429 en GET /products/search, buscando una edición
por su código universal, en estos horarios UTC:

- 2026-10-18 22:56:57Z
- 2026-10-18 23:30:15Z
- 2026-10-18 23:44:39Z
- 2026-10-19 00:36:01Z

Según el registro del operador, esas respuestas no incluyeron Retry-After.
Hay además un evento aproximado a las 22:08Z sin endpoint identificado.
No podemos atribuirlo con certeza al mismo recurso.

El motor local publica de a un libro, con un mínimo global de dos segundos entre
solicitudes y pausas con backoff. El ritmo informado es de unas 125 altas/h y
una búsqueda de catálogo por libro. Esas cifras son aproximaciones operativas;
todavía no contamos con un consolidado medido por endpoint para toda la app.
Ya preparamos contadores de solicitudes de red y caché para adjuntar ese detalle
después del próximo reinicio autorizado. No adjuntamos un benchmark simulado
como si fuera tráfico real.

Solicitamos que revisen la cuota efectiva, la ventana y el motivo de esos 429.
En particular, necesitamos saber si GET /products/search comparte presupuesto
con GET /products/{id} y entre ambos sellers autorizados bajo el mismo Client ID.
También pedimos evaluar un aumento para el volumen legítimo de publicación de
libros, con un objetivo de 250 altas/h, y que nos indiquen el ritmo recomendado
por endpoint antes de modificar nuestros límites.

Podemos aportar un resumen por minuto sin tokens, secretos, datos de compradores
ni códigos de los libros. Si necesitan otros datos de diagnóstico, indíquennos
cuáles y el canal de soporte adecuado para entregarlos.

Gracias. Sebastián — Amado Libros / Amado Vintage.

Antes de enviarlo, adjuntar el resumen de `metrics.mjs` de una ventana real y
especificar sus fechas. El pedido no fue enviado y no se asumió que ya exista
un aumento aprobado.

## 5. App propia para Vintage — plan solamente

**Evaluación:** puede separar responsabilidad y consumo de ambas operaciones,
pero no garantiza que Mercado Libre conceda un cupo independiente o mayor.
Primero conviene pedir la cuota efectiva y medir. Esta entrega mantiene la app
actual, conforme a la decisión previa; no crea ni migra una aplicación.

| Archivo/área | Trabajo necesario si se aprueba la separación |
|---|---|
| `worker-sync/wrangler.toml` y `wrangler.toml` de Pages | Mantener APP_ID/USER_ID y secretos de Libros. Añadir una configuración Vintage explícita; no reemplazar el APP_ID compartido a ciegas. |
| `worker-sync/publication-policy.js` y `publication-engine.js` | Desacoplar la validación de app del único APP_ID constante, con default de Libros intacto y par app/seller validado para Vintage. |
| `functions/_shared/meli-vintage-token.js` | Nuevo Client ID y secreto propios de Vintage; conservar tokens y locks indexados por app_id + seller_id. No copiar tokens entre apps. |
| `functions/_shared/meli-vintage-oauth.js` | Registrar callback/scopes y verificar la nueva autorización de Vintage. Mantener la autorización de Libros. |
| `functions/_shared/vintage-local-access.js`, motor local y configuración exportada | Emitir y validar el nuevo par app/seller. Descargar una conexión temporal nueva y preservar recibos/progreso por seller + ISBN. |
| `worker-sync/operations-read.js` | Conservar las restricciones de Libros. Lectura Vintage por un contexto separado, sin ampliar de forma implícita el destino del conector actual. |
| `functions/api/webhooks/mercadolibre.js` | Conservar el webhook de Libros; diseñar una ruta Vintage o despacho explícito por app/seller antes de registrar notificaciones nuevas. |
| Pruebas y corte | Probar renovación, identidad, recibos, pausa/reinicio y reconciliación para las dos apps; verificar que ningún caso Vintage utilice el token de Libros. |

Costo monetario de alta/API: la documentación consultada no ofrece un tarifario
que permita prometer un monto; hay que confirmarlo con Mercado Libre. Tampoco
hay un costo ni plazo confirmado para el aumento de cuota.

Estimación técnica preliminar: **8–16 horas de trabajo**, como orden de magnitud
de ingeniería, no como cotización ni compromiso. Incluye separar configuración,
OAuth/tokens, guardas, pruebas de ambas cuentas y un corte con reversión. Puede
reutilizar broker y base existentes; no exige por diseño contratar otro servidor.

La migración sería otro cambio revisable. Se preservan recibos por seller/ISBN
para no recrear publicaciones, se verifica primero una lectura con la nueva app
y se hace el cambio en un reinicio acordado. No se regenera el secreto de la app
actual ni se elimina ninguna autorización de Libros. El retorno usa la conexión
Vintage anterior mientras siga vigente y la misma base, sin restaurar una copia
vieja que borre recibos de altas ya creadas.

## Activación de esta rama

Después de revisar el PR, integrar el commit probado en una copia nueva del
checkout elegido para el siguiente reinicio. Si se va a usar #459, incorporar
también esta entrega allí y resolver el posible conflicto de `engine.mjs`
**antes** del corte; #459 incluye sincronización de stock que esta base no agrega.
No ejecutar dos motores apuntando a la misma campaña. No fusionar #458/#459 como
consecuencia automática de aceptar este diagnóstico.

La ventana indicada por el operador es 19/10 a la 01:04 Uruguay (04:04 UTC),
cuando se renuevan Excel y conexión. Este documento no programa ni ejecuta ese
reinicio. La actualización crea una tabla nueva de presupuestos en la SQLite
local y conserva el reloj/cooldown anterior. No necesita desplegar el Worker de
Libros para usar el motor local actualizado.

En esa ventana, respaldar el estado con el motor detenido, mantener la base y los
recibos, y revisar el resumen de métricas de los primeros 20–30 libros. Volver al
código anterior es posible conservando la misma base: la tabla adicional no
interfiere con el motor previo. Revertir código no equivale a restaurar recibos
anteriores ni a republicar un ISBN incierto.

## Fuentes oficiales

- [Rate Limit / Error 429](https://developers.mercadolibre.com.uy/rate-limit-error-429), actualización indicada 05/05/2026, consultado 18/10/2026.
- [Publicador masivo oficial de Uruguay](https://vendedores.mercadolibre.com.uy/nota/publica-muchos-productos-a-la-vez?guideKeyId=GE28&moduleKeyId=MO208), consultado 18/10/2026.
- [Crear una aplicación](https://developers.mercadolibre.com.uy/crea-una-aplicacion-en-mercado-libre-es), consultado 18/10/2026.

Las observaciones de Cloudflare proceden de la interfaz autenticada, en modo de
lectura. No se exportaron credenciales, tokens ni registros de compradores.
