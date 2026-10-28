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
| Filtros comparables | `competitionByIsbn` | Moneda (`otra_moneda` se excluye), condición nueva, nacional, plazo 0 leído desde `/items/bulk` (nunca inferido), mismo tipo de envío. |
| Registro de corridas | tabla `comp_runs` | Por corrida: fecha, estado, fase, fichas completas/parciales/error, vendedores, llamadas usadas, código de error, capacidades. Se guardan las últimas 400. |
| Cobertura | `competitionCoverage`, bloque en `/panel/reposicion`, acción `competencia_cobertura`, `GET /competition/coverage` | Por segmento (ventas propias / agotados): revisadas hoy, parciales, errores, pendientes, nunca completas, foto completa más vieja y su edad. Brechas: títulos activos con ficha ML sin vigilar (tope 400) y títulos sin ficha ML (sin listado comparable por API). |
| Bandeja de oportunidades | `worker-sync/oportunidades.js`, `/panel/oportunidades`, acción `oportunidades`, `POST /opportunities/refresh` | Tabla `comp_opportunities` con id determinista `tipo:ISBN`, estados pendiente/aprobado/descartado/pedido/recibido/resultado, acción, impacto por mes, confianza, cantidad y nivel, evidencia, enlaces (ML, panel, tapa), primera y última observación, nota, avisado por correo. |
| Cantidad | `cantidadSugerida` | `max(0, objetivo − stock físico − en camino)`. Objetivo 1..3 por ventas de 90 días. 2 o 3 sólo con repetición real (≥3 en el año y ≥2 en 90 días), costo cargado y ventana de ventas completa; si falta algo, 1 como prueba (`provisional`) con el motivo. Señal externa aislada en ISBN sin ventas propias: 1, nunca 3. Stock compartido entre publicaciones: máximo, nunca suma. |
| Rotación de todo el catálogo | tabla `comp_rotation`, fase `rotation` del cron | Todas las fichas con `catalog_product_id` del catálogo que no entran en el top diario. Cada corrida de 5 minutos, con el cupo que sobra después del top y los vendedores, lee hasta 12 fichas cuyo turno venció. Foto completa: próximo turno a los 3 días; parcial: al día siguiente; error: espera 1 h, 2 h, 4 h… hasta 48 h, y tres errores seguidos cortan la corrida. La cola se rearma cada día con el catálogo conservando su historial. Los hechos (`competitionByIsbn`) leen también estas fichas (`segmento: rotacion`). |
| Correo diario | `daily-panel-digest.js` | Recalcula la bandeja antes de armar el correo, cuenta pendientes vigentes y lista sólo las nuevas (se marcan `notificado_at` cuando Resend acepta el correo; una prueba manual no marca). |

## Lo que NO hace (a propósito)

- No cambia precios en Mercado Libre, no compra, no publica. El publicador de
  Amado Libros sigue en solo lectura (`docs/cuentas-mercado-libre.md`).
- No dice "nadie lo vende": dice "no detectamos otra oferta comparable en la
  ficha de catálogo de ML (foto diaria por API)". Fuera de esa ficha no mira.
- No suma stocks de publicaciones distintas, no fusiona pares catálogo/no
  catálogo, no infiere ventas de competidores.
- No usa Nubimetrics ni Administrado: no hay archivos reales importados (la
  prueba de exportación no quedó confirmada) y no se inventaron columnas.

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

1. **Precios de todo el catálogo**: sugerencias de suba sobre todas las fichas
   con foto (top y rotación), con rango de prueba parametrizable, costo con
   fecha, comisión, flete y contribución; costos críticos faltantes bloquean el
   precio "firme". Hoy `priceRaises` sólo mira los libros con ventas en el año.
2. **Ventas y long tail**: clasificación poca exposición / visitas sin
   conversión / oferta con ventas / quiebre / evidencia insuficiente, con
   ventanas 90/365 y días efectivamente disponible; visitas desconocidas no son
   0. Pares catálogo/no catálogo agrupados por ISBN sin fusionar.
3. **Importación externa auditable** (Nubimetrics, Administrado): contrato
   interno (original, hash, fuente, mercado, vendedor, extracción, período,
   completitud, trazabilidad por fila, deduplicación) y carga CSV/XLSX con
   mapeo configurable. Primero una muestra real; sin muestra no se crean datos.
   La captura diaria automática se declara funcionando sólo tras probar
   adquisición → importación → análisis con canal autorizado y runtime real.
4. **Bandeja**: ISBN externos al radar, cruces con búsquedas sin resultado /
   lista de espera / proveedores, estados con resultado medido (rotación del
   lote, capital inmovilizado).
