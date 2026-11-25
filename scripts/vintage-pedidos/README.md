# Seguimiento de ventas Vintage

Importa ventas pagadas de AMADO_VINTAGE desde el 09/11/2026 (hora de Uruguay)
en PEDIDOS AMADO LIBROS. La ampliación al 09/11 fue solicitada por Seba el 22/11 para cubrir los últimos 14 días calendario.
Solo se crean órdenes de libros (domain_id MLU-BOOKS) con MANUFACTURING_TIME positivo. Las filas ya vinculadas siguen actualizándose. Las ventas entregadas se crean como entregado; los artículos de stock y otras categorías se cuentan y excluyen. Las siguientes corridas releen todas las ventas desde
ese inicio y todas las filas ya vinculadas, incluidas las antiguas, para recuperar
interrupciones y actualizar cancelaciones/envíos. Si se alcanza un límite de
paginación, la corrida falla explícitamente en lugar de omitir ventas.

## Uso del equipo

Trabajar en la vista Pedidos nuevos. Estado, Responsable, Pedido en, Fecha compra,
Entrega estimada y Seguimiento para ML forman el resumen de la venta.
No se copian NOTAS completas. Estado venta ML y Estado envío ML son espejos
de ML; no reemplazan el estado operativo ni certifican compra al proveedor.

Una fila por orden, con todas sus líneas y cantidades. Precio de venta usa
total_amount de la orden en UYU, no neto liquidado. No se infiere ISBN, teléfono,
dirección, fecha de despacho ni recepción. No se fusionan consultas por título.
No se modifican los importes manuales de registros existentes.

La nota empieza con [AMADO <orden>] y se mantiene por orden dentro del pack
cuando existe; sin pack se usa el recurso de notas de órdenes. El límite es
300 caracteres. Las notas manuales se conservan. Una nota propia borrada o
editada por alguien se marca para revisión en lugar de sobrescribirla.

## Ejecución

GitHub Actions: Vintage pedidos y notas, una vez por hora al minuto 17 UTC
(el servicio puede demorar las corridas). Funciona sin PC encendida.
PR: tests y consulta real de solo lectura. Main: push, cron y ejecución manual.
Una variable de repositorio VINTAGE_PEDIDOS_PAUSA=true pausa las escrituras.
Deshabilitar el workflow también lo detiene.

Se usan los secretos existentes AIRTABLE_TOKEN, CLOUDFLARE_ACCOUNT_ID y
CLOUDFLARE_ADMIN_API_TOKEN o CLOUDFLARE_API_TOKEN. El token de ML se lee de D1
mediante fuenteTokenD1; no se rota desde este proceso. /users/me debe confirmar
seller 2341378249 y sitio MLU antes de cualquier escritura.

El token de Airtable necesita data.records:read y data.records:write en la base
de pedidos. Los campos de sincronización se preparan previamente mediante el
conector Airtable. No se crean credenciales ni se amplían permisos automáticamente.

## Recuperación y límites

- Upsert por ML Venta ID y concurrencia única del workflow.
- Antes de escribir notas: leerlas, buscar marcador e ID guardado, comprobar
  que no cambió el texto confirmado; después escribir y volver a leer.
- No se reintenta POST a ciegas. Si la respuesta se perdió, la siguiente
  corrida adopta una nota con marcador y contenido exactamente esperado.
- Los cambios humanos hechos durante la corrida se reenvían en la siguiente.
- Error por venta: queda en Sincronización ML. Fallo general: Actions falla.
- Solo se imprimen contadores y códigos de error. No se suben artefactos con
  información comercial ni datos de compradores.
- START es el inicio autorizado. Para ampliar el histórico se necesita una
  decisión explícita y cambiar esa constante.
- Actualmente es sondeo horario de API; no hay webhook de Mercado Libre
  ni un segundo importador de correo compitiendo por las mismas filas.

Validación: node --test scripts/vintage-pedidos/core.test.mjs
