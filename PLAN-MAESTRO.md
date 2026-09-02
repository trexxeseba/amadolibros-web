# PLAN MAESTRO — B11: enriquecimiento editorial real del catálogo

## Estado vigente (2026-09-02)

- **Fase activa: B11.2**, con el **circuito automático agotado**. La
  estructura original de 10 lotes de 200 fichas quedó **superada** y se
  conserva más abajo sólo como registro histórico.
- **Lotes B11.2 terminados: 01, 02 y 03 final.** Los lotes 01 y 02 están
  fusionados y verificados en Producción; el Lote 03 final está en el
  [PR #308](https://github.com/trexxeseba/amadolibros-web/pull/308), en
  Draft, **sin fusionar ni desplegar**.
- **El pool `REVISAR` quedó agotado**: los 556 ISBN que dejó B11.1 ya
  fueron procesados, no queda ninguno sin intentar.
- Contadores canónicos (head del PR #308): registry **1.609**, pendientes
  **2.006** (`REVISAR` **442** + `SIN_DATOS` **1.564**), universo **3.615**.
- Los contadores en vivo, la evidencia de Producción y los bloqueos activos
  están en `ESTADO-ACTUAL.md`, que es la fuente de verdad operativa.

## Objetivo operativo

Enriquecer fichas reales del catálogo con información editorial verificable
(sinopsis, descripción, temas, público, autoría, datos bibliográficos, FAQ
específicas, metadatos SEO secundarios).

El objetivo original —2.000 fichas en **10 lotes consecutivos de 200**, cada
uno en su propia rama y PR— se fijó antes de conocer el rendimiento real del
catálogo. El Lote 1 lo desmintió: de 2.276 ISBN elegibles investigados sólo
187 calificaron, un 8,2%. Desde B11.2 la meta ya no es un número fijo de
fichas sino **agotar el universo real** de 3.615 ISBN hasta donde llegue la
evidencia verificable, en lotes dimensionados a ese rendimiento efectivo.

Lo que no cambió: no es un piloto. Cada lote se implementa, se prueba y se
presenta en un PR — nada de lotes testimoniales ni de planes sin ejecución.

## Historial verificado

### PR #298 — cierre definitivo (registrado 2026-08-31)

- **Título:** "B11: cohorte editorial real de 2.000 ISBN + preservar SEO curado"
- **Rama:** `b11/editorial-real-2000-1` → `main`
- **Estado:** `closed`, `merged: true`
- **Merge commit:** `0c0ebf3848447365b87bd38147c4bc1f943f8309`
- **Merged por:** trexxeseba, 2026-08-31T15:16:16Z
- **Qué entregó:**
  - Cambió la unidad de trabajo de B11 a "2.000 ISBN únicos por cohorte":
    investigación bibliográfica real (Google Books, Open Library, BNE) sin
    contar metadatos aislados como fichas editoriales completas.
  - Generó 2.000 *dossiers* de investigación (estados: listo para
    redacción, una sola fuente, contenido estructurado, conflicto de
    identidad, sin evidencia) con `publication_allowed: false` explícito en
    los 2.000 — ninguno se auto-publicó.
  - Corrigió un bug real de producción: el middleware de vidriera
    automática reprocesaba fichas editoriales curadas después del SSR,
    duplicando contenido y pisando el copy SEO curado con texto genérico.
  - Evidencia de CI: cohorte de 2.000 dossiers (`run 33388882918`), CI
    general (`run 33391392044`), preview/auditorías (`run 33391392061`),
    SEO baseline (`run 33391392073`), enrich 1000 ISBN (`run 33391392090`).
- **Lo que el PR #298 NO hizo:** no redactó ni publicó copy editorial para
  los 2.000 ISBN. Dejó la investigación lista como insumo (`next_action:
  REDACT_AND_VALIDATE_EDITORIAL_REAL_V1` en los dossiers que calificaron),
  bloqueada a propósito para publicación.

### Precedentes de redacción real (antes de este plan)

- PR #296 — Disney tomo 11 (ISBN 9791388034435): primer y único
  enriquecimiento `editorial_real_v1` completo (sinopsis, highlights,
  copy de decisión, meta description, merchant description) con 3 fuentes
  verificadas (2 `exact_edition` + 1 `source_edition` editorial).
- PR #293 — 333 ISBN con enriquecimiento factual (`auto_publish_facts`):
  autor, editorial, páginas, idioma, formato — sin redacción de sinopsis.
- Lote SEO psicología (`docs/seo/enrichment-batch-01-psychology.md`,
  2026-08-14): 5 fichas con sinopsis real, seleccionadas cruzando archivo
  de ventas de Mercado Libre — proceso manual, fuentes documentadas.

## Arquitectura del pipeline (repo)

- `scripts/seo/book-intelligence-research-run.mjs` /
  `book-intelligence-sources.mjs` / `book-intelligence-bne.mjs`: adaptadores
  de investigación (Google Books, Open Library, BNE).
- `scripts/seo/book-editorial-cohort-2000.mjs`: selección + clasificación de
  cohortes en dossiers, sin publicar.
- `functions/_shared/book-enrichment-registry.js`: registro por ISBN-13 con
  `validateBookEnrichment` — exige fuentes reales, URLs verificables,
  fecha de verificación y trazabilidad. Nunca toca precio, stock, imágenes,
  condición, slug, canonical ni checkout.
- `functions/_shared/book-editorial-upgrades.js`: tier `editorial_real_v1`
  (sinopsis + highlights + copy de decisión), el más exigente.
- `functions/_shared/book-enrichment-facts-1000.js` /
  `book-enrichment-facts-333.js`: tier `auto_publish_facts` (datos
  bibliográficos verificados sin redacción de sinopsis).
- `functions/__tests__/editorial-showcase-boundary.test.js`: evita que la
  vidriera automática duplique o pise una ficha editorial curada.

## Reglas absolutas (invariantes de todos los lotes)

No modificar: título original/comercial, H1, slug, precio, stock,
condición, imágenes, permalink, canonical, carrito ni identificadores
comerciales. No inventar sinopsis, autores, características ni datos
bibliográficos. No usar texto genérico sin sustento específico. No trabajar
sobre `main`. Si una ficha no tiene información confiable suficiente:
saltear y reemplazar por otra hasta completar 2.000 fichas efectivamente
enriquecidas.

## Lotes ejecutados

| Fase | Lote | Alcance real | PR | Estado |
| --- | --- | --- | --- | --- |
| B11.1 | 1 | Universo 2.276 → 187 enriquecidos | [#303](https://github.com/trexxeseba/amadolibros-web/pull/303) | **Fusionado y verificado en Producción** (commit `5b46f72`) |
| B11.1 | — | Infra de verificación manual contra cualquier `base_url` | [#304](https://github.com/trexxeseba/amadolibros-web/pull/304) | **Fusionado** (commit `7be3b39`) |
| B11.2 | 01 | 100 ISBN de `REVISAR` → 12 TERMINADO, 1 SIN_DATOS, 87 REVISAR | [#305](https://github.com/trexxeseba/amadolibros-web/pull/305) | **Fusionado y verificado en Producción** (commit `8d474bf`) |
| B11.2 | 02 | 100 ISBN de `REVISAR` → 12 TERMINADO, 7 SIN_DATOS, 81 REVISAR | [#306](https://github.com/trexxeseba/amadolibros-web/pull/306) | **Fusionado y verificado en Producción** (commit `662c13c`) |
| B11.2 | 03 final | 356 ISBN de `REVISAR` → 59 TERMINADO, 23 SIN_DATOS, 274 REVISAR | [#308](https://github.com/trexxeseba/amadolibros-web/pull/308) | **Ejecutado, en Draft** — sin fusionar ni verificar en Producción |

### Estructura original de 10 lotes (histórica, descartada)

El plan inicial preveía 10 lotes fijos de 200 fichas
(`b11/enriquecimiento-lote-01` … `-10`) hasta llegar a 2.000. Se descartó
tras el Lote 1: el universo elegible completo (2.276 ISBN) ya fue
investigado de una sola vez y sólo rindió 187 fichas, así que repartir el
mismo universo en lotes de 200 no habría agregado nada. B11.2 lo reemplaza
por lotes de 100 sobre estados persistentes.

## Flujo obligatorio por lote

1. Rama nueva desde `main` actualizado.
2. Selección de ISBN (100 por lote desde B11.2; eran 200 en el plan
   original) priorizando: valor comercial/tráfico, fichas pobres en
   contenido, ISBN identificable, datos bibliográficos confiables reales.
   Descartar y reemplazar los que no califiquen, y excluir todo ISBN que
   ya tenga estado persistente previo.
3. Enriquecimiento editorial real (campos verificados únicamente).
4. Tests completos + verificación de no-duplicación con la vidriera
   automática (`editorial-showcase-boundary.test.js` u equivalente).
5. PR separado documentando: cantidad procesada, ISBN incluidos, fuentes
   utilizadas, resultado de tests.
6. No fusionar sin autorización explícita — salvo autorización previa
   expresa para fusión automática de lotes en verde.

## B11.2 — Pipeline continuo de enriquecimiento y resolución de conflictos

Registrado el 2026-09-01, autorizado y ejecutado sobre el pool REVISAR.
Lote 01: **12 TERMINADO, 1 SIN_DATOS, 87 REVISAR** —
[PR #305](https://github.com/trexxeseba/amadolibros-web/pull/305)
**fusionado y verificado en Producción** (commit `8d474bf`). Lote 02:
**12 TERMINADO, 7 SIN_DATOS, 81 REVISAR** —
[PR #306](https://github.com/trexxeseba/amadolibros-web/pull/306)
**fusionado y verificado en Producción** (commit `662c13c`). Lote 03 final:
**59 TERMINADO, 23 SIN_DATOS, 274 REVISAR** sobre los 356 ISBN nunca
intentados —
[PR #308](https://github.com/trexxeseba/amadolibros-web/pull/308), en Draft,
sin fusionar. Registry acumulado: 1.609. Detalle real en
`ESTADO-ACTUAL.md`.
Reemplaza la estructura fija de 10 lotes de 200 (que el Lote 1 ya mostró
inviable: de 2.276 candidatos elegibles, solo 187 califican con las
fuentes actuales) por un pipeline continuo dimensionado al rendimiento
real del catálogo.

### Motivación

El Lote 1 investigó su universo elegible completo (2.276 ISBN) en vez de
una muestra de 200: 187 calificaron, 1.533 quedaron sin evidencia y 556
quedaron con evidencia en conflicto. Repetir "lotes de 200" sobre el
mismo universo ya investigado no agrega nada — hace falta un pipeline que
sepa qué ISBN ya se investigó, en qué estado quedó, y que solo vuelva a
tocar los que pueden cambiar de estado.

### Diseño

- **Unidad de trabajo:** lotes independientes de 100 ISBN (no 200).
- **Estados persistentes por ISBN** (se guardan, no se recalculan desde
  cero en cada corrida):
  - `PUBLICABLE`: evidencia suficiente, sin conflicto — listo para
    integrar al registry (equivalente a `GREEN_FULL`/`GREEN_FACTS` hoy).
  - `REVISAR`: hay evidencia pero con conflicto de identidad (título,
    autor, editorial o año no coinciden entre fuentes) — requiere
    resolución antes de publicar.
  - `SIN_DATOS`: ninguna fuente disponible tiene evidencia utilizable.
  - `TERMINADO`: el ISBN ya se procesó de forma definitiva (publicado o
    descartado) — **nunca se vuelve a consultar**.
- **Resolución automática de conflictos:** cuando dos o más fuentes
  coinciden en ISBN exacto + título normalizado + autor + editorial + año,
  el conflicto se resuelve automáticamente y el ISBN pasa a `PUBLICABLE`.
  Si no coinciden en esos cuatro campos, se queda en `REVISAR` para
  revisión humana — nunca se fuerza una resolución sin ese acuerdo.
- **Los `SIN_DATOS` salen del circuito automático**: no se reintentan en
  cada corrida (evita repetir consultas ya fallidas contra BNE/Open
  Library/Google Books); quedan disponibles para una fuente adicional
  futura o revisión manual, pero no consumen presupuesto de investigación
  de forma repetida.
- **Ningún lote puede sobrescribir resultados anteriores**: cada corrida
  fusiona sobre el estado persistente existente (la causa raíz del bug
  encontrado y corregido en la 2ª corrida del Lote 1: acumular, nunca
  pisar).
- **Cada lote es retomable**: un lote interrumpido (timeout, error de
  red, cuota agotada) puede continuarse desde el estado persistido sin
  perder lo ya resuelto.
- **Invariante comercial sin excepción:** títulos, H1, slugs, precios,
  stock, imágenes y demás datos comerciales permanecen intactos en todos
  los lotes de B11.2, igual que en B11.1.

### Decisiones ya resueltas al ejecutar B11.2

- **Dónde vive el estado persistente:** manifiesto único
  `artifacts/b11-2/state.json`, acumulativo y retomable, más un resumen por
  lote (`artifacts/b11-2/lote-NN-summary.md`). Ya contiene las 556 entradas
  del pool completo (83 `TERMINADO`, 31 `SIN_DATOS`, 442 `REVISAR`).
- **Cómo se excluyen ISBN ya vistos:** cada corrida descarta todo ISBN con
  estado persistente previo, sin importar cuál sea. Filtrar sólo por
  `TERMINADO` fue un bug real detectado antes del Lote 02, que si no habría
  reprocesado los mismos 88 ISBN del Lote 01 sin avanzar.
- **Tamaño de lote:** irrelevante para el resultado. Se comprobó que un
  único lote de 356 y cuatro lotes secuenciales de 100 producen
  clasificaciones idénticas — la evidencia es inmutable y cada ISBN se
  evalúa por separado. Por eso el Lote 03 se corrió entero de una vez.
- **Autorización:** concedida por Seba y ejercida en los lotes 01, 02 y 03
  final. Sigue siendo requisito explícito por lote.

### Riesgo operativo del resolver: defaults que pisan el Lote 01

`B11_2_FACTS_OUTPUT` y `B11_2_SUMMARY_PATH` tienen como default los
archivos del Lote 01, y el script los **reescribe completos** con los
resultados de la corrida actual. Ejecutar el resolver sin definirlos borra
del registry los ISBN del Lote 01. Toda corrida nueva debe pasar las cuatro
variables explícitas (`B11_2_BATCH_SIZE`, `B11_2_BATCH_NAME`,
`B11_2_FACTS_OUTPUT`, `B11_2_SUMMARY_PATH`) y, además, agregar el `import`
del módulo nuevo en `functions/_shared/book-enrichment-registry.js`: el
registry compone los lotes por nombre, así que un módulo no importado no
entra aunque el archivo exista.

### Qué sigue pendiente de decidir

- Si conseguir sinopsis real (campo `description`, disponible en un
  subconjunto de los matches de Google Books) es parte de B11.2 o un tercer
  proyecto separado. Ninguna de las fichas enriquecidas hasta hoy tiene
  sinopsis: el pipeline masivo sólo escribe hechos bibliográficos.
- Qué hacer con los 1.564 `SIN_DATOS` y los 442 `REVISAR` que quedaron sin
  resolver: sin una fuente de evidencia nueva, reintentarlos da exactamente
  el mismo resultado.

### Estado de ejecución

Lotes 01 y 02 terminados, fusionados y verificados en Producción. Lote 03
final ejecutado y en el
[PR #308](https://github.com/trexxeseba/amadolibros-web/pull/308), en Draft,
sin fusionar ni desplegar.

**El circuito automático quedó agotado**: los 556 ISBN `REVISAR` de B11.1
ya fueron procesados y no queda ninguno sin intentar. No hay un Lote 04
posible con las fuentes actuales — cualquier avance adicional exige
evidencia nueva, no otra corrida del resolver.

Ver `ESTADO-ACTUAL.md` para contadores en vivo y bloqueos activos.
