# Prueba de cinco publicaciones en Amado Vintage

Ruta privada: /panel/meli-vintage-piloto (sesión del panel, producción y origen canónico).

La cuenta destino queda fijada a AMADO_VINTAGE, seller 2341378249, app 4741021817925208. El flujo existente de Libros conserva su seller 440298103, su tabla ml_oauth y sus bindings actuales. El secreto MELI_VINTAGE_CLIENT_SECRET ya configurado en Pages corresponde a la misma app.

## Procedimiento
1. Elegir un snapshot ready con fecha real de stock de menos de 24 horas y la política comercial de un lote de referencia.
2. Preparar y continuar validando. No crea publicaciones: se completa el índice activo/pausado de Vintage y se validan cinco candidatas.
3. Revisar títulos, ISBN, precio UYU, política y disponibilidad. Aprobar la muestra exacta e iniciar sus altas.
4. Actualizar estado o presionar continuar si una llamada termina antes del lote. Se crean únicamente esos cinco ISBN.
5. Revisar los IDs reales. No existe continuidad automática hacia 10.000.

Los lotes, jobs, índices, recibos, nonces, límites y targets de Vintage usan el namespace fijo ml_vintage_pub_. Se reutilizan solo las tablas de snapshots ml_pub_feeds/ml_pub_stock en lectura desde este flujo. El historial previo de Libros no excluye libros de Vintage. La columna seller_id del nuevo esquema de runs incluye un CHECK fijo. El servicio Libros conserva los nombres originales por defecto.

El piloto tiene un único ID determinista, daily_cap=5 y target_published=5. La aprobación cubre el seller, run, policy_hash y payloads de los cinco ISBN. Al aprobar se descartan las demás candidatas; una rechazada o incierta no se sustituye automáticamente. No entra en la cola ni cron de Libros; solo avanza con un POST autenticado desde esta pantalla.

La identidad GET /users/me se comprueba justo antes de POST /items y ambas solicitudes usan el mismo token, incluso si vence la caché entre ellas. No se modifican publicaciones existentes.

## Renovación de autorización
Se lee exclusivamente ml_oauth_sellers por app y seller. La rotación usa ml_oauth_seller_locks con vencimiento, compare-and-swap del refresh token e identidad comprobada antes de guardar. No hay bootstrap ni fallback a ml_oauth/KV/CLIENT_SECRET. Una autorización ausente o rechazada detiene el flujo. El bloqueo de cuenta equivocada también se aplica al refresco.

## Verificación
Pruebas con SQLite real cubren aislamiento del historial/recibos, stock vencido, preflight sin altas, hash incorrecto, muestra exacta de cinco, doble solicitud, conservación del lote fuente, identidad Libros rechazada, token fijado y lock de refresco. La suite existente del publicador conserva su comportamiento.
