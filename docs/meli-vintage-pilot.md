# Prueba de cinco publicaciones en Amado Vintage

Ruta privada: /panel/meli-vintage-piloto (sesión del panel, producción y origen canónico).

La cuenta destino queda fijada a AMADO_VINTAGE, seller 2341378249, app 4741021817925208. El flujo existente de Libros conserva su seller 440298103, su tabla ml_oauth y sus bindings actuales. El secreto MELI_VINTAGE_CLIENT_SECRET ya configurado en Pages corresponde a la misma app.

## Procedimiento
1. Elegir un snapshot ready con fecha real de stock de menos de 24 horas y la política comercial de un lote de referencia.
2. Preparar y continuar validando. No crea publicaciones: se completa el índice activo/pausado de Vintage y se validan cinco candidatas.
3. Revisar títulos, ISBN, precio UYU, política y disponibilidad. Aprobar la muestra exacta desde el panel con sesión humana. El conector firmado no admite aprobar.
4. Actualizar estado o presionar continuar si una llamada termina antes del lote. Se crean únicamente esos cinco ISBN.
5. Revisar los IDs reales. No existe continuidad automática hacia 10.000.

Los lotes, jobs, índices, recibos, nonces, límites y targets de Vintage usan el namespace fijo ml_vintage_pub_. Los nuevos snapshots automáticos SBS se guardan en sbs_supplier_feeds/sbs_supplier_stock, fuera de los feeds que consume el sincronizador de Libros. Los pilotos anteriores conservan acceso de lectura a sus snapshots inmutables ml_pub_feeds/ml_pub_stock. El historial previo de Libros no excluye libros de Vintage. La columna seller_id del nuevo esquema de runs incluye un CHECK fijo. El servicio Libros conserva los nombres originales por defecto.

El piloto tiene un único ID determinista, daily_cap=5 y target_published=5. Al aprobar se guardan sellos por ISBN que incluyen seller, run, policy_hash y el payload exacto, en una tabla exclusiva de Vintage. El motor verifica el sello antes de reutilizar el payload y antes de reservar su creación. Un payload ausente, modificado o con precio desactualizado pasa a revisión: no se reconstruye ni se publica. Al aprobar se descartan las demás candidatas; una rechazada o incierta no se sustituye automáticamente. No entra en la cola ni cron de Libros. El panel o el conector firmado pueden continuar lo ya aprobado.

Vintage solo acepta snapshots que la ingestión ya haya marcado ready. No confirma importaciones ni escribe en ml_pub_feeds/ml_pub_stock. La consulta de estado lee como máximo cinco filas de muestra y diez incidencias, además de conteos agrupados; no carga los payloads del catálogo completo.

La identidad GET /users/me se comprueba justo antes de POST /items y ambas solicitudes usan el mismo token, incluso si vence la caché entre ellas. No se modifican publicaciones existentes.

## Renovación de autorización
Se lee exclusivamente ml_oauth_sellers por app y seller. La rotación usa ml_oauth_seller_locks con vencimiento y compare-and-swap. Se valida el user_id devuelto por tokens y se guarda primero el refresh rotado, para no perderlo ante un fallo posterior de /users/me; después se comprueba la identidad completa. No hay bootstrap ni fallback a ml_oauth/KV/CLIENT_SECRET. Una autorización ausente o rechazada detiene el flujo. El bloqueo de cuenta equivocada también se aplica al refresco.

## Verificación
Pruebas con SQLite real cubren aislamiento del historial/recibos, stock vencido, preflight sin altas, hash incorrecto, muestra exacta de cinco, doble solicitud, conservación del lote fuente, identidad Libros rechazada, token fijado y lock de refresco. La suite existente del publicador conserva su comportamiento.
