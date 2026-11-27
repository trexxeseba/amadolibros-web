# Checkly: diagnóstico y cierre parcial — 26/11/2026

Todas las horas de este informe son de Uruguay (UTC−3).

## Portadas, banners y ficha: cerrado

Control: 0dc3fea6-5f11-49eb-b9e0-1c4f79471334.
Cambio revisable: https://github.com/trexxeseba/amadolibros-web/pull/841
Ejecución y evidencia: https://github.com/trexxeseba/amadolibros-web/actions/runs/45911342770

La falla era del monitor. No encontramos una caída de imágenes en las páginas y la muestra comprobadas.

- Corrida de las 16:50:04: contaba una imagen lazy del séptimo libro del carrusel, fuera del ancho visible, como una imagen visible que no había cargado. El trace tiene 35 solicitudes, ninguna fallida ni con HTTP >=400. Las seis tapas visibles cargaron. El libro fuera de pantalla (MLU1534573954) no había solicitado su imagen.
- Corrida de las 18:50:05: la expresión regular rechazaba la URL válida de La reina descalza porque contiene el título después del ID. La ficha responde 200.
- Las mismas clases de falla aparecen desde el 25/11. No las introdujeron los PR #830/#834 del 26/11.
- Se añadieron los límites horizontales a las dos comprobaciones de visibilidad y se permitió el segmento de título de las fichas. No se aumentaron los tiempos de espera ni se quitaron comprobaciones.
- El usuario autorizó aplicar este cambio al monitor y ejecutar dos pruebas. Se aplicó el script; frecuencia 120 minutos, región us-east-1, activo, sin silenciar, runtime 2026.04 y umbrales conservados.
- La respuesta de configuración mostró cero suscripciones directas a canales de alerta antes y después. No se agregó ningún destinatario; eso requiere una decisión aparte.
- Cuatro recorridos previos en Chrome pasaron: dos a 390 px y dos a 1365 px.
- Las doce pruebas automatizadas nuevas pasan; CI Syntax & Build del commit 962cb6b en verde.

| Corrida real de Checkly | Inicio Uruguay | Resultado | Duración del control |
| --- | --- | --- | --- |
| 01a21a32-6985-70ed-87c1-b53386741eb9 | 26/11 20:30:41.598 | Verde, sin errores ni degradación | 5,936 s |
| 01a21a32-befc-758f-99c3-1a0901f4b8d2 | 26/11 20:31:03.482 | Verde, sin errores ni degradación | 5,918 s |

Script aplicado SHA-256 (LF): 0fc70b991744fe4d63401f8e3d4ba342ff54d871c5da45e43d5921719047fa7e.
El job temporal que aplicaba la configuración se retiró del workflow después de las dos pruebas aprobadas.

## Aviso de Mercado Pago exige firma: no cerrado en Checkly

Control: 0e4f3da1-91d2-42cc-9c6c-c2888be2546b.

Hechos comprobados:

- Activo, sin silenciar, cada 10 minutos, una región (us-east-1), sin mantenimiento ni scripts de setup/teardown, shouldFail=false.
- La consulta paginada de 72 horas devolvió solo siete resultados: el control fue creado el 26/11. No existen veinte resultados para mostrar en ese intervalo.
- La última ejecución real fue a las 12:11:36.982. El campo updated_at del estado es posterior, pero no representa una nueva ejecución.
- Todos los resultados devolvieron HTTP 401 y el cuerpo JSON {"error":"Firma inválida."}.
- Error Group 80abe22d-8bbc-4b87-b6f6-31231d263926: HTTP 401 401 Unauthorized. Las aserciones devueltas actualmente no muestran error. El correo original de las 11:22 muestra STATUS_CODE EQUALS 401; la API devuelve las tres aserciones actuales también para esa corrida antigua. No se puede tratar esa vista como la configuración histórica inmutable ni afirmar qué comparación exacta originó el rojo.
- Las pruebas manuales en producción sin firma (20:02:00) y con firma inválida (20:02:11) devolvieron 401 y el mismo cuerpo. No se enviaron firmas válidas, ni se crearon pedidos, ni se tocaron pagos.
- Los intentos de ejecutar el control a las 20:12 y 20:16 fueron rechazados por Checkly con HTTP 402 y el mensaje de cupo insuficiente. No generaron nuevos resultados.
- Los cuatro controles API activos dejaron de registrar resultados entre las 12:07 y 12:11. Los verdes de cobro y catálogo son históricos, no comprobaciones recientes.
- No hay evidencia de WAF/rate limit del sitio en las muestras: el 402 pertenece a la API de Checkly, no a amadolibros.com.
- Falta comprobar con nuevas corridas cómo se evalúa la configuración actual cuando se restablezca el cupo.

| Inicio Uruguay (26/11) | Ubicación | HTTP | Cuerpo | Estado histórico |
| --- | --- | --- | --- | --- |
| 11:11:36.260 | us-east-1 | 401 | {"error":"Firma inválida."} | rojo |
| 11:21:36.548 | us-east-1 | 401 | {"error":"Firma inválida."} | rojo |
| 11:31:36.459 | us-east-1 | 401 | {"error":"Firma inválida."} | rojo |
| 11:41:36.487 | us-east-1 | 401 | {"error":"Firma inválida."} | rojo |
| 11:51:36.643 | us-east-1 | 401 | {"error":"Firma inválida."} | rojo |
| 12:01:36.274 | us-east-1 | 401 | {"error":"Firma inválida."} | rojo |
| 12:11:36.982 | us-east-1 | 401 | {"error":"Firma inválida."} | rojo |

## Dos vías concretas para recuperar el monitoreo API

A. Sin suscripción nueva: verificar primero el ciclo y el cupo en Billing con Claude; si el reinicio no se aplicó, pedir a soporte que lo restablezca. Preparar una frecuencia de 20 minutos para los cuatro controles: 8.928 ejecuciones en 31 días, antes de pruebas/reintentos. Esto evita superar las 10.000 incluidas en Hobby, pero no repone el cupo agotado hoy y duplica el intervalo de detección. Como cobertura transitoria puede prepararse un control equivalente por GitHub Actions, con PR y alertas verificadas antes de activarlo.

B. Conservar los cuatro controles cada 10 minutos contratando capacidad suficiente, después de verificar facturación. Starter ofrece 25.000 ejecuciones API mensuales; referencia pública USD 24/mes con facturación anual (USD 288/año), a confirmar en la cuenta antes de contratar. No se contrató ni modificó ningún plan.

Configuración actual: cuatro controles cada 10 minutos consumen 17.856 ejecuciones en 31 días, antes de reintentos. Supera el cupo gratuito publicado de 10.000.

Datos faltantes: consumo del período vigente, límite efectivo, inicio/fin del ciclo, fecha del próximo reinicio y motivo por el que no hay cupo. La API de uso no devolvió los términos del período. El correo del 20/11 mencionaba un reinicio para el 22/11, fecha ya pasada; no alcanza para asegurar cuándo vuelve el servicio. No hacen falta claves ni credenciales compartidas: alcanza la lectura de Billing/Usage por Claude.

## Muestra de imágenes de Shopping

Se descargaron las primeras 25 portadas del feed (3.612 productos en total): todas respondieron 200, con contenido JPEG, CORS permitido y ambos lados de al menos 500 px. Las páginas comprobadas no mostraron errores de imágenes. Es una muestra, no una certificación de todo el feed ni de los veinte productos con más clics.

## Referencias

- Run con las dos ejecuciones verdes: https://github.com/trexxeseba/amadolibros-web/actions/runs/45911342770
- CI verde: https://github.com/trexxeseba/amadolibros-web/actions/runs/45911347163
- PR: https://github.com/trexxeseba/amadolibros-web/pull/841
- Planes y límites oficiales consultados el 26/11: https://www.checklyhq.com/pricing/
