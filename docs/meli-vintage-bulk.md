# Lote de 10.000 en Vintage

Ruta privada `/panel/meli-vintage-lote`, sesión humana del panel y POST JSON del mismo origen. Cuenta fija 2341378249, app 4741021817925208. Libros no participa. El piloto permanece intacto.

El objetivo cuenta las cinco verificadas del piloto: el nuevo run determinista `23413782-4900-4000-8000-000000010000` puede crear hasta 9.995 adicionales. Usa la política sellada del piloto, incluida disponibilidad de 18 días. El inicio comprueba que sus cinco publicaciones estén verificadas; no acepta cambios de seller o política del cliente.

El Excel se lee en un Worker local del navegador. Se conserva su fecha interna, máximo 24 horas. Sólo filas con ISBN válido y disponibilidad, precio y peso válidos entran en el snapshot privado. Todos los ISBN repetidos se excluyen, sin escoger arbitrariamente una fila. Importación idempotente en grupos de 200, sin publicación. Los datos comerciales no salen del panel/D1 privado.

Antes de publicar se recorre el inventario de Vintage sin filtrar estados, en multigets de 20. Los identificadores ISBN/GTIN/EAN y SKU de ítems y variaciones alimentan un índice propio. Cada alta vuelve a consultar ambos campos de SKU. El motor reserva atómicamente `(seller_id,isbn)` en el registro exclusivo de Vintage antes del POST; cinco publicaciones existentes, reinicios y doble pestaña no vuelven a crearlas. Una respuesta incierta se reconcilia por SKU; no se repite el POST. No promete impedir publicaciones manuales externas hechas simultáneamente al proceso.

El presupuesto interno es de una consulta cada dos segundos, persistido en D1 y compartido entre pestañas. No representa una garantía del límite de ML. Categorías y atributos se cachean 30 minutos; identidad, stock, búsquedas SKU y altas nunca se cachean. Ante 429: Retry-After numérico o fecha, pausa mínima de dos minutos, crecimiento exponencial y jitter. El motor agrega su backoff persistente. Los reintentos inciertos y reservados consumen cupo para evitar superar el máximo conservador de 1.000 altas diarias. La cuenta se verifica inmediatamente antes de POST /items con el mismo token.

Una sola publicación por tick. La página continúa con cinco segundos entre ticks y un minuto de descanso cada 25 altas; pausa por stock vencido, autorización rechazada, error de respuesta o sesión vencida. Debe permanecer abierta. Al cerrarla se conserva el avance; `Iniciar / continuar` lo retoma. No existe todavía un ejecutor autónomo con la pestaña cerrada. El usuario puede detenerlo con `Pausar`.

Todo el estado se guarda en `ml_vintage_*` y `sbs_supplier_*`. No se importan feeds compartidos de Libros, no se llama a su conector de publicación y no se modifica su cron o su política. Los parámetros nuevos del motor compartido conservan los valores anteriores por defecto.

## Minimum price
Vintage has a hard minimum of UYU 1600 at policy calculation and the final item-create boundary. Books keeps its existing policy. The owner-only `apply_minimum` action requires a paused campaign, takes its lease, audits the old policy, clears only unpublished prepared payloads, and checks one known campaign item per request. It verifies seller and ISBN before a price-only PUT, reads back the actual price, and preserves all original payload seals and higher prices. Price amendments are separately audited and used for current pilot display/verification. Changed-price verification is invalidated until the five are rechecked; an uncertain PUT is read before retrying. Existing unrelated Vintage inventory is not repriced.

