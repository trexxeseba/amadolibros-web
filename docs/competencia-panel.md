# Panel de competencia: integridad, cobertura y bandeja

Estado al 28/10/2026. Punto de entrada para cualquier sesión que retome el
proyecto "revisar todo el catálogo y entregar decisiones explicadas".

## Qué hay en main y qué agrega este cambio

Base verificada en main (27/10): `worker-sync/ml-competition.js` (foto diaria por
API de ML de hasta 400 fichas de catálogo elegidas por ventas propias),
`reposicion-facts.js` / `reposicion-read.js` (hechos por ISBN y API firmada para
GPT), `functions/_shared/panel-bi.js` (ABC, márgenes, `priceRaises`),
`functions/panel/inteligencia.js`, `functions/panel/reposicion.js` y el correo
diario `daily-panel-digest.js`. Worker + D1 + R2. No existe AGENTS.md en el repo.

Este cambio (primer PR) agrega:

| Pieza | Dónde | Qué hace |
|---|---|---|
| Foto completa vs parcial | `ml-competition.js` | Lee el listado de la ficha página por página (`paging.total`). Estado por ficha y día: `ok` (completo), `partial` (faltó una página o ML cortó), `error`. Guarda total/leídos/páginas/competidores sin detalle de `/items/bulk`. |
| Última foto completa por producto | `competitionByIsbn` | Compara la última foto `ok` de cada ficha con la anterior `ok` (no las dos últimas fechas globales). Durante la captura del día una ficha no desaparece: muestra su última foto completa con `foto_edad_horas` y, si hay una captura más nueva parcial o fallida, `captura_posterior`. |
| Etiquetas | `competitionByIsbn`, eventos, panel | `observado` (se vio en la ficha), `estimado` (venta inferida: el contador de ventas del vendedor es de toda su cuenta), `desconocido` (sin condición, plazo o envío legible: no entra en precios). |
| Filtros comparables | `competitionByIsbn` | Lo que se mergeó en #520 manda: de cada competidor sólo cuenta lo verificado por `/items/bulk` (condición, moneda, envío, publicación activa con stock y plazo con un cero explícito; la ausencia de `MANUFACTURING_TIME` es "sin dato", nunca inmediato). Si algún competidor de la ficha queda sin verificar o está en otra moneda, la ficha no produce hechos hasta completar la verificación; Cobertura las cuenta como "sin verificar". Comparables = inmediatos nacionales nuevos con el mismo tipo de envío. Una foto completa rehecha el mismo día borra las ofertas retiradas. Las fotos de versiones anteriores (`snapshot_version`) no se usan. |
| Registro de corridas | tabla `comp_runs` | Por corrida: fecha, estado, fase, fichas completas/parciales/error, vendedores, llamadas usadas, código de error, capacidades. Se guardan las últimas 400. |
| Cobertura | `competitionCoverage`, bloque en `/panel/reposicion`, acción `competencia_cobertura`, `GET /competition/coverage` | Por segmento (ventas propias / agotados): revisadas hoy, parciales, errores, pendientes, nunca completas, foto completa más vieja y su edad. Brechas: títulos activos con ficha ML sin vigilar (tope 400) y títulos sin ficha ML (sin listado comparable por API). |
| Bandeja de oportunidades | `worker-sync/oportunidades.js`, `/panel/oportunidades`, acción `oportunidades`, `POST /opportunities/refresh` | Tabla `comp_opportunities` con id determinista `tipo:ISBN`, estados pendiente/aprobado/descartado/pedido/recibido/resultado, acción, impacto por mes, confianza, cantidad y nivel, evidencia, enlaces (ML, panel, tapa), primera y última observación, nota, avisado por correo. |
| Cantidad | `cantidadSugerida` | `max(0, objetivo − stock físico − en camino)`. Objetivo 1..3 por ventas de 90 días. 2 o 3 sólo con repetición real (≥3 en el año y ≥2 en 90 días), costo cargado y ventana de ventas completa; si falta algo, 1 como prueba (`provisional`) con el motivo. Señal externa aislada en ISBN sin ventas propias: 1, nunca 3. Stock compartido entre publicaciones: máximo, nunca suma. |
| Rotación de todo el catálogo | tabla `comp_rotation`, fase `rotation` del cron | Todas las fichas con `catalog_product_id` del catálogo que no entran en el top diario. Cada corrida de 5 minutos, con el cupo que sobra después del top y los vendedores, lee hasta 12 fichas cuyo turno venció. Foto completa: próximo turno a los 3 días; parcial: al día siguiente; error: espera 1 h, 2 h, 4 h… hasta 48 h, y tres errores seguidos cortan la corrida. La cola se rearma cada día con el catálogo conservando su historial. Los hechos (`competitionByIsbn`) leen también estas fichas (`segmento: rotacion`). |
| Revisión de precios de todo el catálogo | `worker-sync/precios-catalogo.js` | Para cada ficha con foto completa (top y rotación): precio actual, comparables inmediatos, ventaja inmediata (los demás a pedido), sugerido (2 % debajo del más barato comparable si está 15 % o más arriba; sin referencia, probar de a 5 % hasta 20 %), rango de prueba, costo con fecha y proveedor (última compra cargada al cambio del día), comisión ML (mediana observada), flete (sin fuente: faltante), contribución actual y sugerida, faltantes y nivel (`firme` sólo con costo y comisión y contribución positiva; `provisional` si falta algo crítico; `sin_suba`; `bloqueado`). Parámetros pisables por llamada. Resumen en `comp_state` (`price_review`) visible en `/panel/oportunidades`; las subas entran a la bandeja con todo eso en la evidencia. Corre en el Worker con el correo diario y en `POST /opportunities/refresh`. |
| Ventas y long tail | `worker-sync/long-tail.js`, bloque en `/panel/inteligencia`, acción `long_tail` | Una categoría por título: quiebre (sin stock y con demanda), oferta con ventas, ventas lentas (sin ventas en 90 d pero sí en el año: mantener 1), sin ventas publicado hace poco (menos de 180 días disponible o ventana de ventas incompleta: evidencia insuficiente), visitas sin conversión (visitas observadas ≥ 30 en 90 d y ninguna venta), poca exposición (visitas observadas bajas), sin ventas con visitas desconocidas (no se distingue exposición de demanda). "Días disponible" sale de la fecha de alta: es un techo y se dice. Parejas catálogo / no catálogo del mismo ISBN con precio o cantidad distintos se listan para revisar; nunca se fusionan ni se suman. |
| Visitas por API de ML | tabla `comp_item_visits`, fase `visits` del cron | Una lectura por día de `GET /items/visits?ids=…&date_from&date_to` (ventana 90 días, 20 ids por llamada, hasta 6 llamadas por corrida) para las publicaciones propias del top y la rotación. Es una capacidad verificada en runtime: si ML responde 403/404 o con otra forma, queda en `caps.items_visits` y Cobertura lo muestra; las visitas siguen "desconocidas", nunca 0. Por ISBN se toma el máximo entre publicaciones (la propia y la de catálogo pueden ser la misma ficha). |
| Importación externa auditable | `worker-sync/importacion-externa.js`, `/panel/importar-externo`, `POST /external/import`, `GET /external/imports`, `GET /external/radar`, acción `radar_externo` | Contrato: `ext_imports` (id = SHA-256 del original, original guardado, fuente, tipo, mercado, vendedor, extracción, período, ventana, completitud declarada, mapeo usado, plantilla, nota) y `ext_rows` (una fila por línea con número de fila, línea cruda, ISBN normalizado o título, vendedor, precio, vendidas, ventana, logística, `estimado`, válida/motivo, duplicada_de). El mismo archivo dos veces no se carga dos veces. Plantillas `administrado_competidores_ventas` y `nubimetrics_competidor_publicaciones` marcadas **verificado=false** (columnas vistas en pantalla, no en un archivo): si las columnas no están, la carga falla y muestra las cabeceras encontradas para ajustar el mapeo. Sólo CSV; XLSX se guarda como CSV antes (adaptador pendiente). |
| Señales externas en los hechos | `reposicion-facts.js` (`senales_externas`), `/panel/reposicion` | Por ISBN, la última observación de cada fuente / vendedor / ventana, etiquetada `estimado`, mostradas lado a lado. Nunca se suman entre fuentes ni entre ventanas móviles. |
| Radar de ISBN externos | `radarExterno`, bandeja tipo `probar_externo` | ISBN que aparecen en cargas externas y no están en el catálogo, cruzados por título con búsquedas sin resultado de la web (90 días) y lista de espera. Entran a la bandeja sólo con cruce propio o con dos fuentes distintas, como prueba de 1 (provisional); nunca 2 o 3 por una señal externa aislada. |
| Correo diario | `daily-panel-digest.js` | Recalcula la bandeja antes de armar el correo, cuenta pendientes vigentes y lista sólo las nuevas (se marcan `notificado_at` cuando Resend acepta el correo; una prueba manual no marca). |

## Lo que NO hace (a propósito)

- No cambia precios en Mercado Libre, no compra, no publica. El publicador de
  Amado Libros sigue en solo lectura (`docs/cuentas-mercado-libre.md`).
- No dice "nadie lo vende": dice "no detectamos otra oferta comparable en la
  ficha de catálogo de ML (foto diaria por API)". Fuera de esa ficha no mira.
- No suma stocks de publicaciones distintas, no fusiona pares catálogo/no
  catálogo, no infiere ventas de competidores.
- No hay archivos reales de Nubimetrics ni Administrado importados (la prueba
  de exportación no quedó confirmada): el contrato de importación está listo y
  probado con un CSV de prueba; las plantillas quedan "no verificadas" hasta
  cargar un archivo real. No se declara ninguna captura diaria automática: no
  se probó adquisición → importación → análisis con un canal autorizado.

## Datos reales y datos de prueba

- **Real**: todo lo que se ve en `/panel/reposicion`, `/panel/oportunidades` y
  el correo sale de D1 productiva (fotos de ML por API, ventas ML, compras
  cargadas, catálogo de R2). Las tablas nuevas (`comp_runs`,
  `comp_opportunities`, columnas nuevas en `comp_product_days`) se crean solas
  (`CREATE TABLE IF NOT EXISTS` / `ALTER` aditivo) en la primera corrida del
  Worker después del deploy. La bandeja se llena con el primer correo diario o
  con `POST /opportunities/refresh` (SYNC_SECRET).
- **De prueba**: los escenarios de `functions/__tests__/ml-competition.test.js`
  (captura parcial, reaparición de un vendedor, moneda distinta, datos
  desconocidos, captura en curso, idempotencia del mismo día) y
  `functions/__tests__/oportunidades.test.js` (cantidades, stock compartido,
  recálculo sin duplicar ni pisar estados, aviso único por correo, panel) usan
  un Mercado Libre simulado y una D1 en memoria. Ningún número de esos tests es
  un dato del negocio.

## Límites conocidos

- El top diario cubre hasta 400 fichas elegidas por ventas propias; el resto con
  ficha ML rota cada 3 días con el cupo sobrante (unas 30 llamadas por corrida,
  288 corridas por día). Si el catálogo con ficha es mucho más grande que lo
  que entra en 3 días, Cobertura lo muestra como "vencidas" / "nunca leídas": el
  tope de llamadas es el límite real, no se fuerza. Los títulos sin ficha de
  catálogo ML quedan como brecha abierta (no hay listado comparable por API).
- No se pudo medir desde esta sesión el tamaño real del catálogo con ficha (el
  contenedor no llega a R2): la primera corrida en producción lo dirá en
  Cobertura.
- `paging.total` y `offset` en `/products/{id}/items` se usan tal como ML los
  devuelve; si ML ignora `offset`, la ficha queda `partial` y se ve en Cobertura
  (no se asume completa).
- Costos: si no hay compra cargada con precio, la oportunidad queda en
  confianza media y la cantidad no pasa de 1. No se inventan elasticidades ni
  ganancias garantizadas: "más por mes" supone el mismo ritmo de los últimos
  90 días y lo dice.

## Pendiente (fases siguientes, en cambios revisables)

1. **Flete por unidad**: no hay fuente en D1 para el envío que paga el vendedor
   en ML por libro; queda como faltante en cada revisión. Cuando haya tabla de
   costos de envío por peso/zona, `reviewCatalogPrices` la recibe por `flete`.
2. **Visitas**: confirmar en producción que `/items/visits` responde con
   `total_visits` por item (Cobertura lo dice). Si no, las categorías "poca
   exposición" y "visitas sin conversión" quedan vacías y todo cae en "visitas
   desconocidas", que es lo correcto. Historial de stock por día (para "días
   efectivamente disponible" real, no el techo por fecha de alta) no existe.
3. **Importación externa**: cargar una muestra real de cada fuente y marcar la
   plantilla como verificada (o ajustar el mapeo); adaptador XLSX; captura
   diaria automática sólo cuando haya canal autorizado (API/OAuth/export) y se
   pruebe adquisición → importación → análisis en el runtime real. Respuesta de
   soporte de Nubimetrics pendiente, no bloquea lo anterior.
4. **Bandeja**: cruce con proveedores (SBS / compras) para los ISBN externos y
   estados con resultado medido (rotación del lote, capital inmovilizado).
