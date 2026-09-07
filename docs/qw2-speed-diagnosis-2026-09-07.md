# QW2 — diagnóstico de velocidad, 2026-09-07

Responsable: Codex. Esfuerzo del diagnóstico: S. Aceptación cumplida: revisar sólo el proceso de imágenes desplegado, contrastar los límites con código y evidencia, medir repetición de fuentes. No se implementa ni delega un cambio con este documento.

Base técnica comprobada: main d380374775db7b5d2ef80b09ae97351ccdcd88f9. Última observación productiva usada: 2026-09-07 14:31–14:32 UTC. No es una nueva lectura del Worker.

## Proceso existente

1. El cron de Cloudflare despierta cada cinco minutos. GPT y Claude no ejecutan cada imagen.
2. Lee el catálogo activo y un bloque completo de pausados. Selecciona hasta 100 referencias, con seis tareas concurrentes.
3. Para cada referencia prueba, en secuencia, hasta cuatro variantes permitidas del mismo archivo ML. Mide dimensiones y conserva la mejor fuente sin reducir dimensiones ni aceptar proporciones incompatibles.
4. Guarda bytes por SHA en R2 y actualiza el índice global de forma condicional con ETag. Esa deduplicación de almacenamiento ocurre después de descargar la fuente.
5. Feed/JSON-LD usan el filtro mínimo de resolución; la web consume el master y sus variantes. Una revisión completada no garantiza una foto apta.

## Hechos del código

- worker-sync/wrangler.toml: cron */5 y COVER_MIRROR_BATCH_SIZE=100.
- worker-sync/cover-mirror.js: syncCoverMirror recorta el límite con Math.min(100,...). Cambiar sólo la variable a 500 no aumenta la tanda.
- El máximo ordinario del cron, con tandas llenas y sin fallos, es 100 x 12 = 1.200 referencias/hora; no son 1.200 fotos mejoradas.
- worker-sync/index.js sólo reconoce la cadena exacta del cron de cinco minutos para esta ruta, compartida con reintentos GA4. Cambiar sólo la expresión del cron desviaría las invocaciones al flujo de sincronización general. Una mejora de frecuencia debe aislar correctamente la ruta de imágenes.
- El cursor de pausados avanza un bloque por invocación cuando acaba el descubrimiento del alcance. Con 128 bloques, sólo visitarlos una vez al ritmo de un bloque por cinco minutos consume 640 minutos (10 h 40 min), sin sumar tandas adicionales de imágenes.
- readManifestState carga el JSON completo y writeManifestAtomically lo serializa/escribe completo. La última evidencia midió 51.682.491 bytes (~51,7 MB). Es un coste repetido y una limitación para paralelizar escritores; no se ha medido qué porcentaje de tiempo consume ni observado un fallo de memoria en las tandas citadas.
- La selección se identifica por MLU:posición. No hay caché de investigación/descarga compartida por identidad de imagen entre publicaciones. El almacenamiento sí se deduplica por SHA después de descargar.

## Medición reproducible de fuentes repetidas

Snapshot conservado: catalog-production-after323.json, updated_at 2026-09-06T11:37:55.003Z. Se usaron las funciones de producción coverCandidates y mlImageIdentity; identidad no reconocida usa URL completa.

- Productos: 7.104.
- Referencias elegibles de imágenes: 32.569.
- Identidades/URLs distintas: 23.600.
- Repeticiones: 8.969, un 27,54% de referencias.
- Identidades compartidas: 4.083; máximo cuatro referencias por identidad.
- Es potencial para evitar investigación repetida en un recorrido completo, no ahorro de tiempo ya logrado ni una medición de solicitudes reales del último lote.

## Tres mejoras evaluadas — propuestas, no asignadas

| Orden | Mejora | Responsable propuesto | Esfuerzo | Aceptación y evidencia |
| --- | --- | --- | --- | --- |
| 1 | Reutilizar la investigación y master por identidad de fuente, manteniendo asociaciones MLU/posición y política/versiones/frescura. Unir alternativas observadas sin perder opciones de mayor resolución. | Codex; revisión independiente de Claude previa aprobación de Seba | M | Mismo snapshot y resultados de calidad; menos descargas medidas; sin reutilizar una fuente o edición distinta; sin degradar master ni perder galerías. |
| 2 | Desacoplar el trabajo pendiente de la espera fija de cinco minutos. Continuación acotada/cola con checkpoints, control por origen y un único publicador del índice actual. Procesar bloques pausados ya resueltos sin consumir una espera completa por bloque. | Codex; revisión independiente de Claude previa aprobación de Seba | M | Piloto aislado y comparable; objetivo propuesto >=2 veces referencias resueltas por hora, sujeto a medición; sin elevar errores ni perder resultados; checkout/GA4 intactos. No lanzar consumidores concurrentes contra el índice monolítico sin controlar la publicación. |
| 3 | Particionar los metadatos de imágenes para dejar de leer/escribir el índice entero por tanda; diseñar lectura compatible, migración y rollback antes de aumentar escritores. | Codex; revisión independiente de Claude previa aprobación de Seba | L | Evidencia de menos bytes y tiempo por tanda; igualdad de resolución de URLs/feed; coexistencia con índices viejos; sin pérdidas ante escritores concurrentes. |

Cloudflare Queues ofrece consumidores concurrentes, pero no se verificó configuración/coste de Queues en esta cuenta. Tener Images pago no confirma por sí solo ese servicio. No se propone comprar otro modelo.

## Calidad pendiente y decisión de responsable

Las mejoras de velocidad no crean originales mayores. Las 15.456 copias bajo umbral de la última lectura incluyen copias aún no revisadas; para las fuentes insuficientes confirmadas hace falta buscar originales verificables de la misma edición. Acelerar una nueva consulta a la misma fuente pequeña no demuestra mejora.

Recomendación: mantener implementación de imágenes en Codex por continuidad del código y evidencia; Claude puede revisar un diff concreto cuando Seba autorice la asignación. No hay un benchmark comparable de esta tarea que demuestre que GPT o Claude programe más rápido o con menos errores. Pasar la misma tarea entre agentes añade transferencia de contexto y no cambia el cron desplegado.

## Fuentes

- Código: https://github.com/trexxeseba/amadolibros-web/blob/d380374775db7b5d2ef80b09ae97351ccdcd88f9/worker-sync/cover-mirror.js
- Planificación: https://github.com/trexxeseba/amadolibros-web/blob/d380374775db7b5d2ef80b09ae97351ccdcd88f9/worker-sync/index.js
- Worker: https://github.com/trexxeseba/amadolibros-web/actions/runs/34068005892/attempts/3
- Cloudflare Queues: https://developers.cloudflare.com/queues/configuration/consumer-concurrency/
- Límites Workers: https://developers.cloudflare.com/workers/platform/limits/
