# EXPORT-STOCK-DRIVE-1 — diagnóstico y propuesta (sin implementar)

Estado: propuesta para aprobación. No se escribió código de producción. Lo que
se afirma está medido en el repo o en una corrida real; lo demás figura como
**sin probar**.

## Resumen

- **Cobertura:** el inventario ya existe en R2. Activas con stock: **7.003**
  (`catalog.json`, medido el 2026-10-14). Pausadas: **10.270** ids (índice de
  pausados). Total ≈ **17.273** publicaciones, que coincide con las ~17.000
  del ticket.
- **13 de las 17 columnas salen de R2 sin llamar a Mercado Libre.** Las 4 de
  ventas (`fecha_ultima_venta`, `dias_sin_vender`, `ventas_90d`, `ventas_12m`)
  necesitan la API de órdenes y un token del vendedor.
- **Ese token es el único riesgo serio** (ver «Riesgos»).

## Columna | fuente | método

| Columna | Fuente | Método | Estado |
|---|---|---|---|
| `mlu_id` | R2: `catalog.json` (activas) + bloques de pausadas | campo `id` | medido |
| `titulo` | ídem | `title` | medido |
| `categoria` (del sitio) | ídem | `category_id` + `domain_id` mapeados con la taxonomía del repo (misma que usa `/libros/...`) | por verificar el mapeo de las no clasificadas |
| `isbn` | ídem | `isbn` (6.809 de 7.003 activas lo tienen) | medido |
| `estado` | ídem | `status` + `available_quantity` | medido |
| `stock_unidades` | ídem | `available_quantity` | medido |
| `precio_ml` | ídem | `price` (UYU) | medido |
| `precio_web` | ídem | hoy la web muestra el mismo `price`; la transferencia es `round(price × 0,88)`. **Pregunta para Seba:** ¿`precio_web` = precio tarjeta, o querés una columna aparte `precio_transferencia`? | decisión |
| `fecha_publicacion` | ídem | `start_time` | medido |
| `peso_gramos` | ídem | `dimensions.weight`; **no todas lo tienen** (queda vacío si falta) | cobertura sin medir |
| `link_ficha_web` | derivado | `https://www.amadolibros.com/libro/{id}/{slug}` (mismo `slugify` del sitio) | derivable |
| `link_ficha_ml` | ídem R2 | `permalink` | medido |
| `url_portada` | ídem R2 | `thumbnail` / `pictures[0]` | medido |
| `fecha_ultima_venta` | **API de órdenes de ML** | agregar por ítem la fecha de la última orden | **sin probar** |
| `dias_sin_vender` | derivado | hoy − `fecha_ultima_venta`; si nunca vendió en 12 m, «>365» | depende de la anterior |
| `ventas_90d`, `ventas_12m` | **API de órdenes de ML** | sumar cantidades por ítem en cada ventana | **sin probar** |

El catálogo publicado **no trae campos de ventas** (medido: ninguno de
`sold_quantity`, `sales`, `revenue`). Pedir `sold_quantity` en el multiget que
ya hace el sync **no agrega llamadas**, pero es un acumulado histórico: no da
fecha ni ventanas de 90 días y 12 meses.

## Órdenes: cómo y cuántas llamadas

- Método propuesto: listar las órdenes del vendedor de los últimos 12 meses
  (paginado) y agregar por ítem. Una sola pasada alimenta las 4 columnas.
- Cantidad de llamadas ≈ órdenes de 12 meses ÷ tamaño de página. **No conozco
  el volumen de órdenes**: es lo primero que hay que medir. Con 350 ms entre
  consultas, 120 páginas serían menos de 1 minuto: entra holgado, pero es una
  estimación, **no una medición**.
- Va en un **job aparte de GitHub Actions**, nunca dentro del cron del
  `worker-sync`.

## Escribir en Drive de forma segura

- Reusar la **Workload Identity Federation** que ya usa el diagnóstico de
  Merchant (proyecto `amado-libros-analytics`): sin claves guardadas en el repo.
- Una **cuenta de servicio dedicada** (por ejemplo `export-stock@…`), con
  permiso de **Editor solo sobre la carpeta de Drive** de Seba. No ve nada más.
- Formato: **un Google Sheet** `AMADO_STOCK_DIARIO` (se sobrescribe sin
  versiones) con dos pestañas: `stock` (una fila por publicación) y `control`
  (fecha y hora de generación, cantidad de filas, filas por estado).
  Un Sheet es más simple de sobrescribir que un CSV y Claude lo lee por conector.
- Escritura en bloques de ~5.000 filas. ~17.300 × 17 ≈ 294.000 celdas: lejos
  del límite de Google.
- Cron diario 06:00 de Uruguay = 09:00 UTC, más `workflow_dispatch`.

## El token de ventas (el punto crítico)

El refresh token de Mercado Libre es **rotativo** y hoy lo administra el
`worker-sync` en Cloudflare KV. **No se puede usar desde Actions**: cada uso
entrega uno nuevo e invalida el anterior, y rompería el sync de producción.

| Opción | Cómo | Riesgo |
|---|---|---|
| **A. Segunda autorización, cadena propia** | Autorizar la app una vez más para obtener un refresh token independiente, guardado en otra clave de KV (`auth:refresh_token_export`). El job lo lee y lo rota vía API de Cloudflare. | Hay que **comprobar** que Mercado Libre admite dos cadenas de token para el mismo vendedor. Sin probar. |
| **B. Ruta protegida en el Worker** | Una ruta de solo lectura (con `SYNC_SECRET`) que devuelve las ventas agregadas; el Worker usa su propio token. | Toca el `worker-sync` y tiene límite de subllamadas por invocación: habría que paginar. |
| **C. Hoy, a mano** | Seba baja el Excel de «Publicaciones» / «Ventas» de Mercado Libre y lo sube a Drive. | No es automático; sirve de puente. |

Recomendación: probar **A**; si Mercado Libre no lo permite, **B** con
paginación. **C** mientras tanto.

## Riesgos

1. Token de ventas (arriba).
2. Cobertura de `peso_gramos` y de `categoria` para las no clasificadas.
3. Las ventas cuentan **órdenes**, no unidades devueltas o canceladas: definir
   si se excluyen las canceladas.
4. 429: no esperado con ~120 páginas y 350 ms de pausa, pero sin medir. El job
   respeta `Retry-After` y registra cuántos hubo.
5. El Sheet queda con datos del negocio: acceso solo a Seba y a la cuenta de
   servicio.

## Plan de prueba (50 publicaciones, antes de las ~17.300)

1. Muestra fija de **50**: 20 activas con ventas recientes, 10 pausadas, 10
   sin ventas en 12 meses y **10 de tarot y oráculos** (activas y pausadas).
2. Generar el Sheet de prueba `AMADO_STOCK_DIARIO_PRUEBA` y comparar fila por
   fila contra la ficha web y contra el panel de Mercado Libre.
3. Medir: llamadas, tiempo, 429, columnas vacías por motivo.
4. Con la muestra aprobada, correr el total y estimar la duración real.

## Pasos manuales para Seba

1. Crear una carpeta en Drive (por ejemplo `AMADO_STOCK`) y copiar su ID.
2. Crear en esa carpeta el Google Sheet `AMADO_STOCK_DIARIO` con las pestañas
   `stock` y `control`.
3. Crear la cuenta de servicio en Google Cloud (`amado-libros-analytics`),
   habilitar **Google Sheets API** y **Google Drive API**, y compartir la
   carpeta con su correo como **Editor**.
4. Cargar en GitHub (Variables, no secretos): `STOCK_SHEET_ID` y
   `STOCK_FOLDER_ID`.
5. Decidir la opción del token de ventas (A, B o C) y, si es A, autorizar la
   aplicación una vez más.
