# PLAN MAESTRO — B11: enriquecimiento editorial real del catálogo

## Objetivo operativo

Enriquecer 2.000 fichas reales del catálogo con información editorial
verificable (sinopsis, descripción, temas, público, autoría, datos
bibliográficos, FAQ específicas, metadatos SEO secundarios), organizado en
**10 lotes consecutivos de 200 fichas**, cada uno en su propia rama y PR.

No es un piloto. El objetivo es 2.000 fichas efectivamente implementadas,
probadas y presentadas en PRs — no un plan ni un lote testimonial.

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

## Estructura de los 10 lotes

| Lote | Fichas | Rama | PR | Estado |
| --- | --- | --- | --- | --- |
| 1 | Universo 2.276 → 187 enriquecidos | `b11/enriquecimiento-lote-01-ci` | [#303](https://github.com/trexxeseba/amadolibros-web/pull/303) | **Fusionado y verificado en Producción** (commit `5b46f72`) |
| 2 | 201–400 | `b11/enriquecimiento-lote-02` | pendiente | pendiente |
| 3 | 401–600 | `b11/enriquecimiento-lote-03` | pendiente | pendiente |
| 4 | 601–800 | `b11/enriquecimiento-lote-04` | pendiente | pendiente |
| 5 | 801–1000 | `b11/enriquecimiento-lote-05` | pendiente | pendiente |
| 6 | 1001–1200 | `b11/enriquecimiento-lote-06` | pendiente | pendiente |
| 7 | 1201–1400 | `b11/enriquecimiento-lote-07` | pendiente | pendiente |
| 8 | 1401–1600 | `b11/enriquecimiento-lote-08` | pendiente | pendiente |
| 9 | 1601–1800 | `b11/enriquecimiento-lote-09` | pendiente | pendiente |
| 10 | 1801–2000 | `b11/enriquecimiento-lote-10` | pendiente | pendiente |

## Flujo obligatorio por lote

1. Rama nueva desde `main` actualizado.
2. Selección de 200 ISBN priorizando: valor comercial/tráfico, fichas
   pobres en contenido, ISBN identificable, datos bibliográficos
   confiables reales. Descartar y reemplazar los que no califiquen.
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
**fusionado y verificado en Producción** (commit `8d474bf`). Detalle
real en `ESTADO-ACTUAL.md`.
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

### Qué falta antes de ejecutar B11.2

- Definir dónde vive el estado persistente por ISBN (¿archivo commiteado
  por lote, como hoy, o un manifiesto único que se actualiza en cada
  corrida?) y cómo se pasa de `REVISAR`/`SIN_DATOS` a `TERMINADO`.
- Decidir si conseguir sinopsis real (campo `description`, ahora
  disponible en un subconjunto de los matches de Google Books) es parte
  de B11.2 o un tercer proyecto separado.
- Autorización explícita de Seba para arrancar — **no se ejecuta nada de
  esto todavía.**

Ver `ESTADO-ACTUAL.md` para contadores en vivo y bloqueos activos.
