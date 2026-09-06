# PLAN MAESTRO — B11: enriquecimiento editorial real del catálogo

## 🎯 Gran Apuesta en curso — Google Merchant Center

Este documento es la única fuente de prioridades del proyecto. Seba
autorizó explícitamente, el 2026-09-05, el siguiente orden de
prioridades — es el único vigente y reemplaza cualquier orden anterior:

1. **Google Merchant Center — 🎯 EN CURSO (única Gran Apuesta activa).**
2. **Verificación GA4 post-checkout — EN ESPERA DE EVIDENCIA** (ya no es
   la Gran Apuesta activa; queda a un paso de cerrarse — ver detalle
   abajo).
3. **Google Search Console — registrado, NO iniciado.**
4. **SEO técnico / indexación / fichas — registrado, NO iniciado.**
5. **Blindaje técnico de Amado — registrado, NO iniciado.**
6. **Limpieza de los 17 `bibliographic.language` históricos** (heredado
   del cierre de B11) — **pausado.**
7. **Definición de B12** (heredado del cierre de B11) — **pausado.**

No iniciar ningún trabajo de los puntos 2-7 sin autorización explícita y
separada de Seba. El detalle completo de cada uno (objetivo, criterio de
aceptación, evidencia requerida) está en sus secciones de backlog
correspondientes, más abajo.

### Google Merchant Center — detalle de la Gran Apuesta activa

- **Estado:** 🎯 EN CURSO — única Gran Apuesta activa del proyecto desde
  el 2026-09-05.
- **Responsable:** ChatGPT + Seba, con Claude Code para cambios técnicos
  si fueran necesarios (ningún cambio técnico está autorizado todavía;
  esta etapa es de diagnóstico).
- **Esfuerzo:** S para el diagnóstico real inicial — sólo escala si
  aparecen correcciones que autorizar.
- **Objetivo inicial:** obtener el estado REAL de Merchant Center:
  aprobados, desaprobados, advertencias, cobertura del feed y las
  principales causas de cada problema encontrado.
- **Criterio de aceptación:** diagnóstico real documentado (no inferido
  desde el repo) más una lista de quick wins priorizados por cantidad de
  productos afectados / impacto comercial.
- **Evidencia requerida:** consola de Merchant Center o export/API real
  — nunca una inferencia desde el código o desde auditorías internas de
  B11 (esas ya existen, pero miden el feed propio, no el veredicto real
  de Merchant sobre ese feed).
- **Avance registrado (2026-09-06):** diagnóstico real completo y quick
  wins con evidencia real, sin declarar Merchant Center verificado
  todavía (falta re-crawl real de Google sobre los fixes). Estado real
  de cada quick win, corregido tras validación (ver detalle en
  ESTADO-ACTUAL.md):
  - **QW1 — Offer/precio:** CAUSA RAÍZ VERIFICADA — EL FIX DE #313 NO
    CORRIGE NINGÚN CASO REAL. Evidencia reproducible (run
    [34005410037](https://github.com/trexxeseba/amadolibros-web/actions/runs/34005410037),
    `catalog.json` `updated_at` 2026-09-05T07:19:57.025Z, manifest de
    Producción `20260905012150762`):
    - **Clasificación del cohorte (171 MLU resueltos de los 172):**
      85 pausados presentes en el índice de ambos entornos, 85 no
      comparables por HTTP 404 en Preview (existen en el índice de
      Producción y no en el de Preview — los manifiestos de pausados
      son distintos por entorno), 1 activo con precio real
      (`MLU728138914`, 2.050 UYU, stock 2), 0 con causa pendiente de
      verificar. Es decir: **170 de 171 son publicaciones pausadas
      que siguen en el feed de Merchant**. La fuente que las
      transporta (`catalog/versions/.../index.json.gz`) **no lleva
      precio ni moneda**, así que la ficha no puede publicar `Offer`:
      no es un fallo del renderizador.
    - **Diff de renderizadores sobre el catálogo real completo
      (7.277 ítems, mismo snapshot, `main` `ea0c475` vs #313
      `6d38d22`):** 0 `Offer` agregados, 0 removidos, 0 modificados,
      **7.277 sin cambio**. Ambos publican `Offer` en los 7.107
      activos con stock y en ninguno de los 170 pausados. El supuesto
      del fix —activo, con precio real y sin stock— **no ocurre en el
      catálogo publicado**, porque `catalog.json` sólo contiene
      activos con stock.
    - **Coherencia precio visible ↔ JSON-LD:** 0 incoherencias en los
      7.277 ítems con `main` y 0 con #313 (ni `Offer` sin precio
      visible, ni precio visible sin `Offer`, ni botón de compra sin
      stock). No hay nada que corregir aquí hoy, y #313 tampoco lo
      introduce.
    - **Consecuencia:** [PR #313](https://github.com/trexxeseba/amadolibros-web/pull/313)
      queda Draft y **no se propone para merge**: es inerte sobre el
      catálogo real. La vía real para los 170 `missing_price` es
      dejar de enviar a Merchant las publicaciones pausadas (o
      transportar su precio), no cambiar el renderizador. **Nunca
      "Terminado" hasta recrawl real de Merchant.**
  - **QW3A1 — calidad de identificadores (ISBN/GTIN):** IMPLEMENTADO —
    PENDIENTE MERGE. **No es "enriquecimiento estructurado completo"**
    — es sólo la corrección de validación de ISBN/GTIN (mismo checksum
    que ya usa el feed de Merchant). El mapeo de campos bibliográficos
    (author, publisher, inLanguage, numberOfPages, bookFormat, edition)
    ya estaba completo desde antes, sin relación con este PR.
    [PR #314](https://github.com/trexxeseba/amadolibros-web/pull/314)
    (Draft, sin mergear).
  - **QW3A2 — enriquecimiento bibliográfico real:** EN CURSO. Selección
    de 100 fichas activas priorizadas por stock real + ficha indexable
    + ISBN válido + gaps bibliográficos reales (mismo criterio ya
    usado y probado en B11:
    `scripts/seo/book-intelligence-research-run.mjs`), investigación
    real contra Google Books/Open Library/BNE en curso vía
    `b11-batch-research.yml` (run 34004157966). Se actualiza este
    documento al terminar, con la tabla ANTES/DESPUÉS real y los
    conteos de ≥1 dato, ≥3 datos y sin mejora.
    **Defecto del selector, corregido:** `selectResearchCohort()`
    excluía cualquier ISBN presente en el registro de enriquecimiento
    aunque conservara campos incompletos, así que una edición que sólo
    aportó `publication_year` quedaba bloqueada para siempre. Ahora los
    huecos se miden sobre la ficha EFECTIVA (catálogo +
    `applyBookEnrichment()`) y un ISBN sólo queda fuera si no le falta
    ningún campo. [PR #318](https://github.com/trexxeseba/amadolibros-web/pull/318)
    (Draft, sin mergear).
  - **QW2 — imágenes:** MEDICIÓN COMPLETA — CORRECCIÓN NO INICIADA. Sin
    activar Cloudflare Images ni tocar Merchant. **Corrección de
    encuadre:** la posición en NUESTRA galería no es la función en
    Merchant. Toda URL que aparece en `imageLink` es la imagen
    **principal** del producto para Google, aunque internamente sea la
    segunda de la galería; hablar de «mayoría secundarias» minimizaba
    el problema. Medición real de la última corrida (32 productos
    `image_too_small` con imagen <500px): 24 servidas por nuestro
    proxy y 8 servidas directo desde Mercado Libre — **las 32 son
    principales para Merchant**. Todas usan ya la variante «-O» (la
    mayor que ofrece Mercado Libre por URL), así que no hay una
    variante mayor por simple sustitución. **Pendiente antes de
    concluir que sólo quedan IA u omisión:** verificar fuente real
    mejor por ISBN/edición (catálogo del editor, BNE, Open Library),
    que todavía NO se hizo.

### Cobertura del catálogo: CRUDA vs EFECTIVA (2026-09-06)

Medido con `scripts/seo/catalog-coverage-effective.mjs` sobre el mismo
universo y el mismo snapshot (`catalog.json` `updated_at`
2026-09-05T07:19:57.025Z, run
[34005410037](https://github.com/trexxeseba/amadolibros-web/actions/runs/34005410037)) —
**7.107 productos activos con stock**:

- **Cruda:** el catálogo tal como llega de Mercado Libre.
- **Efectiva:** el mismo ítem después de `applyBookEnrichment()`, que es
  lo que realmente ve la ficha publicada, el JSON-LD y el feed. El
  enriquecimiento toca **2.985 de los 7.107 ítems**.

**La cobertura cruda NO es la cobertura de las fichas publicadas.** La
tabla anterior de este documento presentaba la columna cruda como si lo
fuera, y subdeclaraba gravemente campos como páginas y editorial.

| Campo | Cruda | Efectiva | Ganancia | % cruda | % efectiva |
| --- | ---: | ---: | ---: | ---: | ---: |
| Autor no vacío | 6.705 | 6.713 | +8 | 94,34% | 94,46% |
| **Autor REAL** (descarta genéricos) | 6.288 | 6.336 | +48 | 88,48% | 89,15% |
| Autor genérico | 417 | 377 | −40 | 5,87% | 5,30% |
| ISBN válido | 6.703 | 6.703 | 0 | 94,32% | 94,32% |
| Editorial real | 269 | 1.539 | +1.270 | 3,79% | 21,65% |
| Páginas | 5 | 1.629 | +1.624 | 0,07% | 22,92% |
| Idioma | 6.730 | 6.747 | +17 | 94,70% | 94,93% |
| Formato | 370 | 383 | +13 | 5,21% | 5,39% |
| Edición | 5 | 18 | +13 | 0,07% | 0,25% |
| Año de publicación | 3.939 | 5.168 | +1.229 | 55,42% | 72,72% |
| Género | 5.557 | 5.558 | +1 | 78,19% | 78,20% |
| Descripción no vacía | 4.172 | 4.178 | +6 | 58,70% | 58,79% |
| Descripción ≥80 | 4.104 | 4.110 | +6 | 57,75% | 57,83% |
| **Descripción ÚTIL ≥280** | 3.852 | 3.858 | +6 | 54,20% | 54,28% |
| Descripción ≥700 | 2.769 | 2.765 | −4 | 38,96% | 38,91% |

Notas de lectura, para no volver a sobredeclarar:

- «Autor no vacío» y «autor real» son métricas distintas: 377 fichas
  publicadas siguen con un autor genérico (`Desconocido`, `Varios`).
- «Descripción no vacía» y «descripción útil» también: casi 6 de cada 10
  fichas tienen texto, pero sólo el 54,28% supera los 280 caracteres.
- La descripción ≥700 baja 4 casos porque el copy editorial verificado
  reemplaza descripciones largas de origen por texto más corto y real.

Sobre el catálogo **efectivo**, los mayores gaps reales son ahora
**edición (0,25%)**, **formato (5,39%)**, **editorial real (21,65%)** y
**páginas (22,92%)** — no «páginas al 0,07%». QW3A2 prioriza estos
campos cuando exista evidencia bibliográfica real verificable.
    [PR #315](https://github.com/trexxeseba/amadolibros-web/pull/315)
    (Draft, sin mergear).
  - **QW4 — títulos/descripciones a escala:** NO iniciado, salvo las
    descripciones incluidas legítimamente dentro del lote QW3A2.
  - **QW5 — enlazado interno:** NO iniciado.
  **No declarar Merchant Center verificado hasta mergear QW1/QW3A1/
  QW3A2 y confirmar el re-crawl real de Google.**

### Verificación GA4 post-checkout — EN ESPERA DE EVIDENCIA

- **Estado:** EN ESPERA DE EVIDENCIA. Deja de ser la Gran Apuesta activa
  el 2026-09-05, reemplazada por Google Merchant Center — no se cierra
  todavía porque falta un último punto de evidencia (ver abajo).
- Verificado hasta ahora: instrumentación de los eventos revisada y
  confirmada; el puente Apps Script + Google Sheet que recibe los datos
  de GA4 está funcionando; la compra real `AL-260820-W33NZ9` quedó
  verificada por `transaction_id` e importe ($2.750 UYU); comportamiento
  mobile vs. desktop verificado.
- **Falta para cerrar:** validar una compra real posterior al deploy del
  checkout V1.1 ([PR #310](https://github.com/trexxeseba/amadolibros-web/pull/310),
  commit `03abd31`) — la compra `AL-260820-W33NZ9` verificada hasta ahora
  es anterior a ese deploy.
- Detalle completo (responsable, esfuerzo, objetivo, criterio de
  aceptación, evidencia) en "Backlog — checkout V1.1", entrada 2, más
  abajo.

**Checkout:** sigue **congelado comercialmente** — no se toca código de
checkout ni de Producción mientras la prioridad activa es un diagnóstico
(Merchant Center) o una verificación pendiente de cierre (GA4).

## Estado vigente (2026-09-03) — B11 TERMINADO

- **B11 está cerrado.** Los tres lotes de B11.2 (01, 02 y 03 final) están
  **fusionados a `main` y verificados en Producción**. El
  [PR #308](https://github.com/trexxeseba/amadolibros-web/pull/308) se
  fusionó el 2026-09-03 (squash, commit `ebe83ff`).
- **El circuito automático quedó agotado**: los 556 ISBN `REVISAR` que dejó
  B11.1 ya fueron procesados, no queda ninguno sin intentar y no hay un
  Lote 04 posible con las fuentes actuales.
- Contadores canónicos (en `main` y Producción): registry **1.609**,
  pendientes **2.006** (`REVISAR` **442** + `SIN_DATOS` **1.564**), universo
  **3.615**.
- La estructura original de 10 lotes de 200 fichas quedó **superada** y se
  conserva más abajo sólo como registro histórico.
- Los contadores en vivo y la evidencia de Producción están en
  `ESTADO-ACTUAL.md`, que es la fuente de verdad operativa.
- **Lo que sigue, en orden:** 1) PR técnico de limpieza de los 17
  `bibliographic.language` históricos multivaluados; 2) definición de B12.
  Ninguno de los dos está iniciado, y ambos quedan **pausados detrás de la
  Gran Apuesta en curso** (Google Merchant Center — ver sección al
  principio del documento) hasta que Seba autorice retomarlos.

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
| B11.2 | 03 final | 356 ISBN de `REVISAR` → 59 TERMINADO, 23 SIN_DATOS, 274 REVISAR | [#308](https://github.com/trexxeseba/amadolibros-web/pull/308) | **Fusionado y verificado en Producción** (commit `ebe83ff`) |

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
[PR #308](https://github.com/trexxeseba/amadolibros-web/pull/308)
**fusionado y verificado en Producción** (commit `ebe83ff`). Registry
acumulado: 1.609. Detalle real en `ESTADO-ACTUAL.md`.
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

### MARC 041: qué subcampo describe el idioma de la edición

`$a` es el idioma del texto de esta edición, `$h` el de la obra original y
`$d` el del contenido cantado o hablado. Sólo `$a` describe lo que el lector
recibe. Fusionarlos —como hacía el adaptador de BNE hasta el Lote 03—
convierte una traducción (`041 1#$aspa$heng`) en un falso "Español, Inglés".
Un `$a` repetido (`041 0#$aspa$aeng`) sí indica una edición realmente
bilingüe. Además, un código sin etiqueta conocida se descarta en vez de
publicarse crudo: es preferible no informar el idioma antes que mostrar
`dut` en una ficha.

Como la evidencia cacheada por B11.1 es inmutable y conserva los valores
mezclados, el resolver aplica una regla conservadora: **no publica ningún
`language` con más de un idioma**. El defecto sólo puede aparecer como valor
multivaluado, así que la regla lo cubre sin necesidad de listar ISBN a mano.

Queda pendiente un PR técnico separado para auditar los 17
`bibliographic.language` que siguen publicados en módulos ya fusionados
(13 en `facts-1000`, 2 en `facts-333`, 2 en B11.2 Lote 02): los 17 son
multivaluados y provienen de BNE, o sea que replican el mismo defecto. Ver
`ESTADO-ACTUAL.md` para el detalle por ISBN.

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

### Estado de ejecución — B11 CERRADO

Los tres lotes de B11.2 (01, 02 y 03 final) están terminados, fusionados a
`main` y verificados en Producción. Con el
[PR #308](https://github.com/trexxeseba/amadolibros-web/pull/308) fusionado
(commit `ebe83ff`, deploy `run 33698641329`, auditoría post-deploy
`run 33699289571` en pass y live check de Producción con los 59 ISBN del
lote en `verified`), **B11 queda cerrado**.

**El circuito automático quedó agotado**: los 556 ISBN `REVISAR` de B11.1
ya fueron procesados y no queda ninguno sin intentar. No hay un Lote 04
posible con las fuentes actuales — cualquier avance adicional exige
evidencia nueva, no otra corrida del resolver.

Trabajo heredado, en orden y sin iniciar: 1) PR técnico de limpieza de los
17 `bibliographic.language` históricos; 2) B12.

Ver `ESTADO-ACTUAL.md` para contadores en vivo y bloqueos activos.

---

## Backlog — checkout V1.1 (fuera de B11)

Workstream separado de B11 — el checkout `/carrito` (rediseño V1.1,
bloqueante de D1 Preview y ciclo de vida de idempotencia) se fusionó y se
desplegó a Producción en el
[PR #310](https://github.com/trexxeseba/amadolibros-web/pull/310) (commit
`03abd31`, 2026-09-04). Detalle completo y evidencia en `ESTADO-ACTUAL.md`,
sección "Checkout V1.1".

Seba autorizó registrar estas dos acciones en el backlog. Desde
2026-09-05, la entrada 2 (Verificación GA4 post-checkout) pasó de ser la
Gran Apuesta activa a **EN ESPERA DE EVIDENCIA** — Google Merchant Center
la reemplazó como Gran Apuesta (ver la sección al principio del
documento). La entrada 5 (Blindaje técnico de Amado) permanece
**registrada, sin iniciar**, y sigue pausada detrás de la Gran Apuesta
activa: requiere autorización explícita y separada de Seba antes de
empezar cualquier trabajo sobre ella.

### 2. Verificación GA4 post-checkout — EN ESPERA DE EVIDENCIA

- **Estado:** EN ESPERA DE EVIDENCIA. Fue la Gran Apuesta activa del
  2026-09-04 al 2026-09-05; Seba la reemplazó por Google Merchant Center
  (ver sección "🎯 Gran Apuesta en curso" al principio del documento) sin
  cerrarla del todo — queda a un solo punto de evidencia de cerrarse.
  - **Verificado hasta ahora:** instrumentación de los eventos revisada y
    confirmada; el puente Apps Script + Google Sheet que recibe los datos
    de GA4 funcionando; la compra real `AL-260820-W33NZ9` verificada por
    `transaction_id` e importe ($2.750 UYU); comportamiento mobile vs.
    desktop verificado.
  - **Falta para cerrar:** validar una compra real posterior al deploy
    del checkout V1.1 ([PR #310](https://github.com/trexxeseba/amadolibros-web/pull/310),
    commit `03abd31`, 2026-09-04) — `AL-260820-W33NZ9` es anterior a ese
    deploy.
- **Responsable:** ChatGPT + Seba.
- **Esfuerzo estimado:** S (1 sesión de trabajo) — es verificación de
  instrumentación ya implementada, no desarrollo nuevo. Escalable a M
  **sólo si** aparecen eventos rotos que exijan corrección de código
  además de medición.
- **Objetivo:** confirmar en Producción, con datos reales de GA4 (no sólo
  revisión de código), que los eventos de comercio y de error del checkout
  miden lo que deben:
  - `view_item`, `add_to_cart`, `view_cart`, `begin_checkout`, `purchase`,
    `whatsapp_click`, `checkout_error` — los siete disparan en el momento
    correcto del flujo real, con los parámetros esperados.
  - `purchase` no se duplica (recarga de `/pedido`, doble navegación,
    back/forward) — ya existe una guarda de deduplicación en
    `analytics-events.js`; esta verificación confirma que sostiene en
    tráfico real, no sólo en el test unitario que ya la cubre.
  - Ingresos y `transaction_id` de `purchase` coinciden con las órdenes
    reales en D1 Producción (sin discrepancias de monto ni de moneda).
  - Comportamiento consistente mobile vs. desktop (mismos eventos, mismos
    parámetros, sin eventos exclusivos de una plataforma por accidente).
  - `checkout_error` permite distinguir, en GA4, en qué etapa
    (`order_create` / `preference_create` / `transfer_options`) se traban
    compradores reales — no sólo que el evento existe, sino que sus datos
    alcanzan para operar sobre ellos (identificar una etapa problemática
    sin necesidad de leer logs del servidor).
- **Criterio de aceptación:** los ocho puntos del objetivo confirmados con
  evidencia de GA4 real (Realtime o informes, según disponibilidad en el
  momento), no sólo con lectura de código. Cualquier evento roto, ausente,
  duplicado o con parámetros incorrectos encontrado durante la
  verificación se documenta como hallazgo — corregirlo es una acción
  aparte, no implícita en esta verificación, y también requiere
  autorización de Seba antes de tocar código de Producción.
- **Evidencia requerida:** capturas o exports de GA4 (Realtime y/o
  informes) mostrando cada uno de los siete eventos disparando con sus
  parámetros; comparación numérica de `transaction_id`/monto de al menos
  una muestra de compras reales contra las órdenes correspondientes en D1
  Producción; confirmación explícita de no-duplicación de `purchase` sobre
  al menos un caso de recarga/back real; comparación mobile vs. desktop
  documentada; y un registro explícito de qué etapas de `checkout_error`
  se observaron con datos reales (o su ausencia, si todavía no hubo
  errores reales que capturar).

### 5. Blindaje técnico de Amado — registrado, NO iniciado

- **Estado:** registrado, **NO iniciado**. Pausado detrás de la Gran
  Apuesta en curso (Google Merchant Center, entrada 1) y de la
  Verificación GA4 pendiente de cierre (entrada 2). No empezar ningún
  punto de este objetivo sin autorización explícita y separada de Seba.
- **Responsable:** a asignar por Seba (agente/desarrollador designado al
  momento de autorizar el inicio).
- **Esfuerzo estimado:** M-L (varios PRs pequeños y aislados, por diseño —
  ver objetivo) — no es una sola pieza de trabajo, así que el esfuerzo
  total depende de cuántos de los puntos siguientes se autoricen a la vez.
- **Objetivo:** reducir el riesgo de que un cambio futuro rompa el
  checkout o `main` sin que nadie lo note antes de Producción:
  - Reforzar la protección de la rama `main` (reglas de branch protection:
    checks obligatorios, sin push directo, revisión requerida donde
    corresponda).
  - Revisar `CODEOWNERS` para archivos críticos del checkout y del
    backend de órdenes (`carrito.astro`, `cart.js`, `_orders_handler.js`,
    `_orders_logic.js`, `_turnstile.js`, `_mp_handler.js`,
    `_transfer_options_handler.js`, migraciones de `orders`) — hoy **no
    existe ningún archivo `CODEOWNERS` en el repositorio**, así que este
    punto empieza por definirlo, no por editarlo.
  - Definir un gate de "cambio sensible" (qué archivos/rutas disparan
    revisión y checks adicionales antes de poder fusionar).
  - Suite de regresión obligatoria del checkout como check bloqueante en
    PRs que toquen esos archivos críticos (hoy la suite existe y corre,
    pero no está marcada como *required check* de branch protection).
  - Separar el E2E automatizado de la dependencia de un Turnstile real:
    el E2E de `deploy-checkout-v11-preview.yml` ya documenta (evidencia en
    el PR #310) que Turnstile bloquea por diseño cualquier navegador
    headless de CI, sin bypass — hace falta una estrategia explícita
    (modo de prueba real de Turnstile si Cloudflare lo ofrece, o
    verificación server-side desacoplada del challenge del navegador)
    para que el E2E pueda confirmar la creación real de una orden sin
    depender de una pasada humana cada vez.
  - Convención de PRs pequeños y aislados para cambios críticos (no volver
    a acumular etapas heterogéneas — guidance, rediseño, auditoría,
    bloqueante de D1, idempotencia — en un solo PR como pasó con el
    #310, aun cuando cada etapa individual estuvo bien probada).
- **Criterio de aceptación:** cada punto del objetivo, al ejecutarse,
  aterriza en su propio PR pequeño y aislado (consistente con el último
  punto del objetivo) con su propio criterio de aceptación verificable —
  por ejemplo: branch protection confirmado por captura de la
  configuración real de GitHub, no por descripción; `CODEOWNERS` nuevo
  cubriendo la lista de archivos críticos de arriba, con al menos una
  aprobación de prueba ejercitándolo; el gate de cambio sensible
  demostrado con un PR de prueba que lo dispara; la suite de regresión del
  checkout agregada a los *required checks* de la rama `main`, confirmado
  desde la configuración de branch protection; y una decisión explícita
  (documentada) sobre cómo desacoplar el E2E de Turnstile real, con al
  menos un caso demostrado end-to-end sin depender de una pasada humana.
- **Evidencia requerida:** por cada punto ejecutado, el PR correspondiente
  (número, head SHA, checks en verde) más la captura/export de la
  configuración de GitHub que prueba el cambio (branch protection rules,
  `CODEOWNERS` en el repo, definición del gate, lista de required checks).
  Sin evidencia de configuración real, un punto no se considera cerrado
  aunque el código exista.

---

## Backlog — Google Search Console y SEO técnico (fuera de B11 y de checkout V1.1)

Ninguna de las dos áreas siguientes tenía una acción registrada en este
documento antes de 2026-09-04 — sólo menciones incidentales ("SEO" como
parte del objetivo general de enriquecimiento editorial o como nombre de
checks de CI). Ninguna es lo mismo que esos conteos existentes: piden
estado real verificado directamente en la consola de cada herramienta, no
una cifra ya calculada por otro proceso.

(Google Merchant Center estaba registrado en esta misma sección — se
promovió a Gran Apuesta activa el 2026-09-05 y su detalle completo se
movió a la sección "🎯 Gran Apuesta en curso", al principio del
documento.)

Seba autorizó **registrar** las dos, en este orden, después de GA4.
**Ninguna queda marcada EN CURSO** — las dos están **pausadas detrás de la
Gran Apuesta en curso** (Google Merchant Center) y de la Verificación GA4
pendiente de cierre. Requieren autorización explícita y separada de Seba
antes de iniciar cualquier trabajo, la misma regla que ya aplica al resto
del backlog.

### 3. Google Search Console — indexación real

- **Estado:** registrado, **NO iniciado**. Pausado detrás de la Gran
  Apuesta en curso.
- **Responsable:** a asignar por Seba.
- **Esfuerzo estimado:** S — revisión de panel; escala a M si aparecen
  errores de cobertura o de rastreo que exijan investigación adicional.
- **Objetivo:** confirmar en Search Console real (no en el sitemap generado
  internamente, que ya se reporta como conteo de URLs dentro del "full
  commerce production audit") el estado real de indexación de las fichas
  de libro: páginas indexadas vs. excluidas y por qué, errores de rastreo
  activos, y que el sitemap enviado sea aceptado sin errores.
- **Criterio de aceptación:** estado de cobertura de Search Console
  confirmado con evidencia real de la consola — no sólo con el conteo de
  URLs del sitemap ya reportado internamente —, incluyendo el motivo de
  cualquier página excluida relevante y confirmación de que el sitemap no
  tiene errores de procesamiento.
- **Evidencia requerida:** captura o export del informe de cobertura de
  Search Console (fecha incluida) y del estado del sitemap enviado.

### 4. SEO técnico / indexación / fichas

- **Estado:** registrado, **NO iniciado**. Pausado detrás de la Gran
  Apuesta en curso.
- **Responsable:** a asignar por Seba.
- **Esfuerzo estimado:** S — es verificación, no desarrollo; escala a M si
  aparecen problemas reales (canonical incorrecto, datos estructurados
  inválidos, `noindex` mal aplicado) que exijan corrección de código.
- **Objetivo:** confirmar, sobre una muestra real de fichas en Producción
  (no sólo por lectura de código), que los elementos técnicos de SEO que
  ya existen en el código siguen funcionando como se espera: `canonical`
  correcto por ficha, `noindex`/`indexable` aplicado sólo donde corresponde
  (el mismo criterio que ya usan `carrito`/`pedido`, que deben quedar
  `noindex` con medición activa), datos estructurados (`schema.org`) sin
  errores de validación, y que la muestra no repita ningún hallazgo que
  auditorías previas de B11 (`full commerce production audit`, "Reproduce
  public SEO baseline") ya hayan cerrado.
- **Criterio de aceptación:** la muestra confirmada sin errores de
  validación de datos estructurados, sin `canonical` incorrecto, sin
  `noindex` aplicado o ausente donde no corresponde; cualquier hallazgo
  real se documenta como hallazgo separado, no se corrige como parte de
  este registro.
- **Evidencia requerida:** resultado de una herramienta de validación de
  datos estructurados (o equivalente) sobre la muestra elegida, con fecha;
  lista de las URLs de la muestra y su `canonical`/`indexable` real
  observado; referencia explícita a qué auditorías previas de B11 ya
  cubrían parte de este alcance, para no repetir verificaciones cerradas.
