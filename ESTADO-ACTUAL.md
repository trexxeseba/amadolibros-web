# ESTADO ACTUAL — B11: enriquecimiento editorial real (2.000 fichas)

Última actualización: 2026-09-03 — **B11 CERRADO**. El
[PR #308](https://github.com/trexxeseba/amadolibros-web/pull/308) (Lote 03
final) está **fusionado a `main` y verificado en Producción**. El circuito
automático de B11.2 quedó agotado: no hay más lotes posibles con las fuentes
actuales.

## Estado canónico (fuente de verdad)

| Métrica | Valor |
| --- | --- |
| ISBN enriquecidos en el registry (en `main` y Producción) | **1.609** |
| Pendientes totales | **2.006** |
| — de los cuales `REVISAR` (evidencia con conflicto de identidad) | **442** |
| — de los cuales `SIN_DATOS` (sin evidencia utilizable) | **1.564** |
| Universo addressable | **3.615** ISBN únicos |
| Fase B11 | **TERMINADA** — circuito automático agotado |
| Lotes B11.2 | 01, 02 y 03 final — los tres fusionados y verificados en Producción |
| `REVISAR` sin intentar | **0** — los 556 del pool ya fueron procesados |

Verificación aritmética: 442 + 1.564 = 2.006 pendientes; 1.609 + 2.006 =
3.615. El universo no crece: cada lote sólo reclasifica ISBN dentro de él.

Comprobación contra el repositorio (no son cifras declarativas):
`listBookEnrichments()` de `functions/_shared/book-enrichment-registry.js`
devuelve 1.609 ISBN, y `artifacts/b11-2/state.json` contiene 556 entradas
con `TERMINADO` 83, `SIN_DATOS` 31 y `REVISAR` 442 — el pool `REVISAR`
completo de B11.1, ya sin ningún ISBN pendiente de intentar.

## B12 — enriquecimiento de fichas activas (2026-09-06)

**Resultado real: 481 fichas activas mejoradas**, verificadas una por una en
el Preview desplegado. La meta autorizada eran 1.000 y **no se alcanzó**: el
circuito se agotó antes con las fuentes disponibles. El objetivo sigue
pendiente y se continúa después.

> **Corrección de una cifra que informé mal.** Antes reporté 423 fichas. Ese
> número salía de reconstruir el "antes" restándole al ítem los hechos del
> lote —un supuesto— y además medía sólo dos de los tres módulos que trae el
> PR: dejaba fuera el lote `qw3a2` (47 ediciones). La cifra correcta,
> comparando la ficha efectiva de `main` contra la del PR sobre el mismo
> snapshot congelado, es **481**.

### Reconciliación contra `main`, mismo snapshot

Base `main` **`d380374`**, head **`a66b419`**. Corrida
[34063187043](https://github.com/trexxeseba/amadolibros-web/actions/runs/34063187043),
snapshot `catalog.json` `updated_at` **2026-09-06T11:37:55.003Z**, 7.104 fichas
activas comparadas de los dos lados. El snapshot se baja **una sola vez** y lo
comparten los dos lados: si cada uno bajara el suyo, una actualización del
catálogo en el medio invalidaría la comparación.

| Métrica | Valor |
| --- | ---: |
| Registro de enriquecimiento en `main` | 1.609 |
| Registro en el PR | **1.790** |
| Crecimiento del registro | **+181** |
| ISBN únicos con mejora | **268** |
| **Fichas activas beneficiadas** | **481** |
| — con ≥1 campo nuevo | 481 |
| — con ≥3 campos nuevos | **105** |
| Fichas que **pierden** algún campo | **0** |
| Fichas presentes en un solo lado (diferencia de catálogo) | 0 |

| CAMPO | +FICHAS |
| --- | ---: |
| Páginas | **+291** |
| Temas | **+235** |
| Editorial | **+158** |
| Año de publicación | +135 |
| Autor real | +16 |
| Idioma | +6 |

### Cómo se relacionan 227, 268, 274 y +181

Son cuatro cifras distintas y conviene no confundirlas:

| Cifra | Qué es |
| --- | ---: |
| 274 | Registros de investigación en los tres módulos (47 + 196 + 31) |
| **268** | **ISBN únicos**: 6 registros repiten ISBN entre módulos |
| **+181** | Ediciones **nuevas** en el registro |
| 87 | ISBN que `main` ya tenía y a los que el PR les **completó** campos |

El «227» que informé antes era la suma de registros de sólo dos módulos, y
además contaba registros en vez de ISBN únicos. Los 268 ISBN únicos mejoran al
menos una ficha viva cada uno; 268 − 181 = 87 son ediciones ya investigadas
que ganaron campos que les faltaban, sin pisar ningún dato verificado.

### Verificado en el Preview desplegado

Probar el renderizador localmente no demuestra nada: sólo el Preview muestra si
el dato llegó a la página que sirve Cloudflare.

> **Corrección — mi primer verificador daba falsos positivos.** Buscaba cada
> valor con `html.includes()` sobre el documento entero y, como el bloque
> JSON-LD vive DENTRO del HTML, todo campo «aparecía visible» aunque la ficha
> no lo mostrara. Además aprobaba con **una sola** de las dos comprobaciones,
> hacía coincidir un número dentro de otro (496 dentro de 1496) y `topics` no
> se comprobaba en absoluto. **El 481/481 que informé antes no probaba nada.**
> El verificador se reescribió, se le agregaron pruebas que reproducen los
> cuatro defectos, y la medición se repitió. Lo que sigue es el resultado de
> la versión corregida.

Qué comprueba hoy, campo por campo:

- **Valor visible**: se lee **sólo** de la lista de detalles de la ficha
  (`<div class="detail-row"><dt>Etiqueta</dt><dd>Valor</dd></div>`), que por
  construcción excluye scripts, estilos y contenido no mostrado. Se compara el
  valor **normalizado completo**, nunca un fragmento.
- **Propiedad JSON-LD**, declarada según el contrato real del renderizador:
  `author.name`, `publisher.name`, `numberOfPages`, `inLanguage`,
  `bookFormat`, `bookEdition`, `datePublished`, `keywords`.
- **Se exigen las dos** donde las dos corresponden. Cuando una no corresponde,
  se registra como NO APLICA **con el motivo escrito**, jamás como aprobada
  por omisión.
- **Ningún campo esperado pasa con cero comprobaciones**: un campo mejorado
  que no produjo comprobación se cuenta como `sin_comprobar` y **reprueba** la
  ficha.
- **Un HTTP 404 queda SIN VERIFICAR**, no fallido y tampoco atribuido al
  catálogo: es un resultado propio, contado aparte.

Corrida [34063187043](https://github.com/trexxeseba/amadolibros-web/actions/runs/34063187043),
base `https://pr-325.amadolibros-web.pages.dev`. El SHA **realmente desplegado**
es `a66b419` y no es un supuesto: la corrida espera a que concluya con éxito el
check de despliegue **de ese mismo commit** y recién entonces valida.

| | |
| --- | ---: |
| Fichas esperadas | 481 |
| **Verificadas** (todas sus comprobaciones aprobadas) | **481** |
| Fallidas | **0** |
| Sin verificar (HTTP 404 u otro error) | **0** |
| Comprobaciones de campo realizadas | **841** |

| CAMPO | COMPROB. | VISIBLE OK | JSON-LD OK | JSON-LD N/A | FALLIDAS |
| --- | ---: | ---: | ---: | ---: | ---: |
| Páginas | 291 | 291 | 290 | **1** | 0 |
| Temas | 235 | 235 | 235 | 0 | 0 |
| Editorial | 158 | 158 | 158 | 0 | 0 |
| Año de publicación | 135 | 135 | 135 | 0 | 0 |
| Autor real | 16 | 16 | 16 | 0 | 0 |
| Idioma | 6 | 6 | 6 | 0 | 0 |

Las 841 comprobaciones son exactamente la suma de las mejoras por campo de la
reconciliación: **cada mejora que el PR declara fue comprobada en la página
servida**, ninguna quedó sin mirar.

El único «no aplica» es **MLU644234684** (ISBN 9781572813458). El middleware de
vidriera publica esa ficha como `Product` a secas —no como `Book`— y entonces
BORRA a propósito `numberOfPages`, `bookFormat` y `bookEdition`. Es lo correcto:
un producto que no es un libro no debe declarar páginas en schema.org. El dato
sigue **visible** en la ficha y su comprobación visible aprobó. No se retiró
ningún dato ni se aflojó ninguna exigencia para que el número cerrara.

Evidencia por ficha —MLU, ISBN, campo, valor esperado, valor visible
encontrado, valor JSON-LD y resultado— en el artefacto
`b12-reconciliacion-34063187043` de esa corrida. Las cifras de arriba, además,
quedan en el **resumen de la corrida**, que no vence con el artefacto.

### Rendimiento por lote — el circuito se agotó

| Lote | ISBN incorporados |
| --- | ---: |
| B12 01 | 196 |
| B12 02 | 31 |
| B12 03 | **0** |

Los tres recorrieron el MISMO universo de 3.596 ediciones. El primero se llevó
los casos con más evidencia y el tercero no encontró nada: con las fuentes de
hoy, esto es el techo.

### El bloqueo concreto

De los 3.596 investigados, **2.488 (69%) tienen al menos una fuente exacta**,
así que el problema no es cobertura:

| Causa | ISBN |
| --- | ---: |
| Sin evidencia utilizable en ninguna fuente | 2.398 |
| Conflicto de identidad (título o autor no coinciden con la fuente) | 638 |
| Una sola familia de fuente (el gate exige dos, o una oficial) | 489 |
| Evidencia cruzada pero los campos ya estaban completos | 71 |

**El mayor freno recuperable es Google Books**: quedó en **4 de 3.596** con
HTTP 429 en las tres corridas, incluso tras bajar el presupuesto de 1.500 a
400. Es cuota diaria agotada, no un fallo de código; históricamente aportaba
500-615 coincidencias exactas.

Continuar por ahí queda **fuera de este cierre**: esperar el reset de cuota y
volver a correr, con el caché compartido pidiendo sólo lo que falta. Los 489
bloqueados por «una sola familia» exigen **sumar otro catálogo oficial**, no
relajar el gate: bajar la exigencia publicaría datos con menos respaldo.

### Qué se construyó

- **Library of Congress y Deutsche Nationalbibliothek** como fuentes oficiales
  (`national_library`, mismo nivel que BNE), gratis y sin API key. Sonda de
  alcance previa: [34031761113](https://github.com/trexxeseba/amadolibros-web/actions/runs/34031761113).
- **El selector mide huecos sobre la ficha efectiva**: antes excluía cualquier
  ISBN del registro aunque le faltaran campos.
- **Un lote posterior completa al anterior** sin pisar datos verificados.
- **Caché compartido y comprimido**: una corrida bajó de 60 a 15 minutos.

### Evidencia y reanudación

El diff llegó a superar **1.006.814 líneas**; el 98% eran dos archivos por
lote —el volcado de investigación y el caché de fuentes—. Hoy son **20.329**.
La evidencia **no se movió fuera del repo**: se guarda comprimida (unas doce
veces menos) en el mismo lugar, así que la reanudación de un lote sigue siendo
automática con un `checkout`, sin credenciales ni vencimientos. Se verificó
que cada archivo se recupera **idéntico** y que el caché comprimido
efectivamente evita repedir lo ya conocido. El caché compartido y el del lote
01 eran byte a byte el mismo archivo; quedó uno solo.

**Sin sinopsis copiadas y sin datos comerciales.** Cada hecho conserva su
fuente por campo (`provider`, `url`, `relationship: exact_edition`), verificado
por test. Precio, stock, imágenes, slug y canonical no se tocan.

Trabajo en [PR #325](https://github.com/trexxeseba/amadolibros-web/pull/325),
sin mergear ni desplegar.

## Trabajo pendiente que hereda de B11

1. **PR técnico de limpieza de idiomas históricos** (no iniciado): auditar los
   17 `bibliographic.language` multivaluados que siguen publicados en módulos
   fusionados antes de la corrección de MARC 041 (13 en `facts-1000`, 2 en
   `facts-333`, 2 en B11.2 Lote 02). Detalle por ISBN más abajo.
2. **B12**: ya no está por definirse — su primera tanda está entregada y
   medida (sección de arriba). Lo que sigue pendiente es llegar a las 1.000
   fichas, y para eso vale lo mismo que decía este punto: **cualquier avance
   exige evidencia nueva** (otra fuente oficial, o el reset de cuota de Google
   Books), no otra corrida del resolver sobre el mismo universo.

## B11 Lote 1 — TERMINADO (fusionado y verificado en Producción)

- [PR #303](https://github.com/trexxeseba/amadolibros-web/pull/303) fusionado a `main` por trexxeseba (squash, commit `5b46f72`), 2026-09-01T16:55:06Z.
- [PR #304](https://github.com/trexxeseba/amadolibros-web/pull/304) fusionado (infra de verificación manual contra cualquier `base_url`), commit `7be3b3931b`.
- Deploy to Cloudflare Pages sobre `5b46f72`: `run 33534675172`, intento 2, **success** (el intento 1 falló solo en el job "Publish production paused/active catalog" por un `Recv failure: Connection reset by peer` transitorio de red; el job "Deploy" —build, Wrangler, smoke test— fue success desde el intento 1).
- Full commerce production audit (dispatch manual, `sample_only=true`), `run 33544377442`: **result=pass, critical=0** — catálogo 7.128 items, feed Merchant 3.707 items (0 críticos/warnings), 300/300 imágenes válidas (`r2-production`), 300/300 páginas verificadas.
- Book enrichment live check contra Producción (`https://www.amadolibros.com`), `run 33545168003`: **1.517 verified, 9 not_applicable, 0 failed** sobre el registry completo de 1.526 ISBN (incluidos los 187 del Lote 1). Los 9 `not_applicable` son ISBN del registry sin ninguna publicación MLU activa hoy — no es una falla, es la conservación correcta del dato para cuando vuelva a haber oferta.
- Muestra de 12 ISBN del Lote 1 verificados individualmente contra Producción (mezcla de los 19 de la 1ª corrida y los 168 de la 2ª): `9788401039058`, `9788408214359`, `9788425427015`, `9788446056720`, `9788467975819`, `9780006551805`, `9780142410110`, `9780194053921`, `9780198338734`, `9780307951526`, `9780230490017`, `9780199640942` — los 12 con status `verified`, cada uno con sus propios MLU reales y sin mezcla de datos entre ISBN.

## Contadores del Lote 1 (histórico, ya superado)

Esta tabla es la foto al cierre de B11.1 y se conserva como registro. Los
contadores vigentes son los de "Estado canónico" al principio del documento.

| Métrica | Valor al cierre del Lote 1 |
| --- | --- |
| Universo inicial del Lote 1 (ISBN elegibles investigados) | 2.276 |
| Fichas enriquecidas correctamente (verificadas, en `main` y Producción) | **187** (18 `GREEN_FULL` + 169 `GREEN_FACTS`) |
| Fichas pendientes entonces | **2.089** |
| — de las cuales SIN_DATOS | 1.533 |
| — de las cuales REVISAR | 556 |

Verificación de esa foto: 187 + 2.089 = 2.276. 1.533 + 556 = 2.089. Los 556
REVISAR estaban **dentro** de los 2.089 pendientes, no se sumaban aparte.
B11.2 ya movió esos números: ver "Estado canónico".

## Composición del registry actual

| Origen | ISBN |
| --- | --- |
| Enriquecidos antes del Lote 1 | 1.339 |
| B11 Lote 1 | 187 |
| B11.2 Lote 01 | 12 |
| B11.2 Lote 02 | 12 |
| B11.2 Lote 03 final | 59 |
| **Total en el registry** | **1.609** |

## Estado de PRs

| Métrica | Valor |
| --- | --- |
| PRs de lote abiertos | 0 — B11 cerrado |
| PRs de lote fusionados | 5 — [#303](https://github.com/trexxeseba/amadolibros-web/pull/303) (187 fichas), [#304](https://github.com/trexxeseba/amadolibros-web/pull/304) (infra de verificación), [#305](https://github.com/trexxeseba/amadolibros-web/pull/305) (B11.2 Lote 01), [#306](https://github.com/trexxeseba/amadolibros-web/pull/306) (B11.2 Lote 02), [#308](https://github.com/trexxeseba/amadolibros-web/pull/308) (B11.2 Lote 03 final) |

## Corrección de Google Books (aplicada y verificada)

La corrida 1 (`33457523327`) tenía Google Books casi inutilizable: 39/40
pedidos con `HTTP 429`, circuit-breaker cortando el resto. Causa:
concurrencia/ritmo (2 pedidos en paralelo, 1,1s de espera) excedía la
cuota por segundo del proyecto GCP. Corrección aplicada en
`b11-batch-research.yml`: concurrencia 1, delay 2s, presupuestos de BNE/
Open Library/Google Books ampliados al universo elegible completo (2.276).

**Resultado de la corrida 2** (`33513707088`, éxito, 57 min): Google Books
pasó de 1/40 a **615/2.257** coincidencias exactas (71 errores, ya no por
cuota agotada; 2.257 = 2.276 menos las 19 ya resueltas en la corrida 1).
Open Library: 1.071/2.257. BNE: 234/2.257. `GREEN_FULL` 1→17 nuevos,
`GREEN_FACTS` 18→151 nuevos: de 19 a **187** ISBN verificados en total
(+8,8×).

**Bug encontrado y corregido en la propia corrida 2:** el script
`book-intelligence-project.mjs` reescribe el archivo de hechos del lote
desde cero con el manifest de la corrida actual — la corrida 2 pisó (no
fusionó) los 19 ISBN de la corrida 1 en el archivo commiteado por el
workflow. Se detectó antes de fusionar nada a `main`, se recuperaron los
19 desde el commit `86bbec3` y se fusionaron sin ISBN duplicados: 187
totales, verificado por test. El workflow se corrigió para que corridas
futuras del mismo lote **acumulen** sobre el archivo existente en vez de
pisarlo — evita que el mismo bug se repita en los lotes siguientes.

## Validación (todas corridas localmente sobre el head actual del PR #303)

- Tests focales (lote-01 + editorial-upgrades + 333 + boundary + 1000 +
  cohort-2000): **20/20**.
- Suite completa de Functions: **1.041/1.041**.
- `bash scripts/validate-ci.sh` (build Preview + Producción, smoke
  checkout ON/OFF): **OK**.
- `git diff --check`: sin errores.
- CI de GitHub Actions sobre el commit final del PR #303: verificado, ver
  sección de checks más abajo.

## Sigue sin haber sinopsis real

Ninguna de las 187 fichas tiene sinopsis: el pipeline masivo
(`book-intelligence-project.mjs`) solo escribe hechos bibliográficos
(editorial, páginas, idioma, año, temas) — por diseño explícito del
propio script, nunca copia una sinopsis externa. Conseguir sinopsis real
(como el precedente Disney, PR #296) requiere lectura y redacción caso
por caso de la evidencia ya obtenida (Google Books ahora sí trae
`description` para varios de los 615 matches).

## 🔴 El techo del catálogo sigue siendo el hallazgo crítico

3.615 ISBN únicos en todo el catálogo addressable. El objetivo original
de "2.000 fichas nuevas" sigue excediendo por mucho lo que el catálogo
tiene para dar: incluso con Google Books funcionando, este lote convirtió
187/2.276 (8,2%) en verificado — una mejora real de ~9× sobre el 0,8%
anterior — pero el techo absoluto no cambia. Ver `PLAN-MAESTRO.md` para
el rediseño (B11.2) que reemplaza el objetivo fijo de 2.000 por un
pipeline continuo con estados persistentes sobre el universo real.

## B11.2 Lote 01 — TERMINADO (fusionado y verificado en Producción)

Autorizado e iniciado 2026-09-01, sobre el pool de 556 `REVISAR` dejado
por B11.1, sin tocar los 1.533 `SIN_DATOS`. Primer lote de 100 ISBN.

- Regla aplicada: un ISBN pasa a `PUBLICABLE` cuando 2 fuentes
  independientes (Google Books/Open Library/BNE) coinciden entre sí en
  título normalizado + autor + editorial + año (un campo ausente en un
  lado nunca cuenta como conflicto). Reutiliza evidencia ya investigada
  por B11.1 — 0 llamadas de red nuevas.
- Resultado real del lote 01: **12 TERMINADO** (integrados al
  registry), **1 SIN_DATOS** (identidad confirmada, sin hechos con
  evidencia suficiente para publicar), **87 siguen REVISAR**. Duración
  del procesamiento: 0,1s.
- Estado persistente commiteado en `artifacts/b11-2/state.json`
  (acumulativo, retomable, nunca reprocesa un `TERMINADO`).
- [PR #305](https://github.com/trexxeseba/amadolibros-web/pull/305)
  fusionado a `main` por trexxeseba (squash, commit `8d474bf`),
  2026-09-01.
- Dos bugs reales encontrados y corregidos durante la verificación
  (ninguno tocó título/precio/stock/imágenes/datos comerciales, los
  tres siguientes hallazgos son solo de la propia herramienta de
  verificación/merge):
  1. Las URLs `infoLink`/`selfLink` de Google Books a veces vienen en
     `http://`, no `https://`, y `validateBookEnrichment` exige
     `https`. Sin la normalización (ya usada en
     `book-intelligence-project.mjs`, faltaba replicarla en el
     resolver) el resolver daba 0 resueltos en vez de 12.
  2. `applyBookEnrichment` mezclaba `bibliographic` con spread de
     objeto: una clave ya presente en el ítem del catálogo (aunque
     vacía, como suele traer MercadoLibre) tapaba el hecho verificado
     en vez de sólo ganar cuando su propio valor es real —
     inconsistente con el patrón que ya usan `publisher`/`pages`.
     Corregido con test de regresión.
  3. `book-enrichment-live-check.mjs` exigía que cada
     `auto_publish_facts` introdujera al menos un campo visible nuevo
     respecto al catálogo para considerarse "verificado". Con
     evidencia real de CI se confirmó que no había corrupción de
     datos: 8 de los 12 ISBN ya tenían en el catálogo el mismo valor
     real que el hecho verificado (ej. `9780194501873`:
     `publication_year "2015"` en ambos lados — hecho legítimamente
     redundante), y el resto tenía un valor real distinto que el merge
     correctamente no pisa (ej. catálogo con `"2222"`, un dato erróneo
     del vendedor). Corregido: el gate ahora verifica que los hechos
     que sí se aplicaron se rendericen bien, sin exigir novedad.
- Deploy to Cloudflare Pages sobre `8d474bf`: `run 33558241703`,
  **success** (el job "Publish production paused/active catalog" tardó
  ~9 min pero terminó en verde; el resto —build, Wrangler, smoke
  test— fue success desde el arranque).
- Full commerce production audit (dispatch manual, `sample_only=true`),
  `run 33559277806`: **result=pass, critical=0** — catálogo 7.128
  items, feed Merchant 3.707 items (0 críticos/warnings), 300/300
  imágenes válidas (`r2-production`), 300/300 páginas verificadas.
- Book enrichment live check contra Producción
  (`https://www.amadolibros.com`), `run 33559284981`: **1.529
  verified, 9 not_applicable, 0 failed** sobre el registry completo de
  **1.538** ISBN (1.529 + 9 = 1.538, exacto). Los 9 `not_applicable`
  son los mismos ISBN sin publicación MLU activa ya vistos en la
  verificación del Lote 1 — no es una falla nueva.
- Los 12 ISBN de este lote verificados individualmente contra
  Producción, todos `verified`, cada uno con sus propios MLU reales y
  sin mezcla de datos entre ISBN: `9780194114226` (MLU637863473,
  MLU674080904), `9780194419215` (MLU637824793, MLU1300310658,
  MLU1299647170), `9780194501873` (MLU702908736, MLU702882796),
  `9780194730952` (MLU675019228, MLU638287647), `9780230498181`
  (MLU887472434, MLU653511723), `9781090348418` (MLU679894804),
  `9781292268729` (MLU627781415), `9781292401133` (MLU628486908,
  MLU636069230), `9781316627686` (MLU642033254, MLU658014430),
  `9781456277161` (MLU684400158, MLU684374146), `9781557764256`
  (MLU725474470, MLU730190378), `9781640951877` (MLU1467423248,
  MLU1468208694).
- Tests: 6/6 focales de B11.2 (+2 tests de regresión agregados durante
  la verificación) + 1.048/1.048 suite completa + `validate-ci.sh` OK +
  `git diff --check` limpio.
- Pendientes de REVISAR tras este lote: 556 − 12 − 1 = **543** (444 sin
  tocar aún + 87 reintentados sin éxito en este lote). SIN_DATOS:
  1.533 + 1 = **1.534**. Verificación: 543 + 1.534 = 2.077 pendientes;
  1.538 enriquecidos + 2.077 pendientes = 3.615 — el universo total no
  cambia, sólo se movieron 12 ISBN de pendiente a enriquecido y 1 de
  REVISAR a SIN_DATOS.

## B11.2 Lote 02 — TERMINADO (fusionado y verificado en Producción)

Autorizado explícitamente por Seba el 2026-09-02, sobre los **siguientes
100 ISBN** del pool REVISAR que quedaron sin intentar tras el lote 01.
No tocó el pool SIN_DATOS.

- Bug real encontrado y corregido antes de correr este lote: el filtro
  de candidatos de `scripts/seo/b11-2-resolve-revisar.mjs` sólo excluía
  ISBN ya `TERMINADO`, no los que habían quedado `REVISAR` o
  `SIN_DATOS` en el lote 01. Como el script reutiliza la misma
  evidencia inmutable (sin nuevas consultas externas), reintentar esos
  ISBN da exactamente el mismo resultado — sin el fix, este lote habría
  repetido los mismos 87 `REVISAR` + 1 `SIN_DATOS` del lote 01 en vez
  de avanzar. Corregido para excluir cualquier ISBN con un estado
  persistente previo, sin importar su status. Verificado: candidatos
  disponibles antes de la corrida = 456 (= 556 − 100 ya intentados en
  el lote 01), exacto.
- Resultado real del lote 02: **12 TERMINADO** (integrados al
  registry), **7 SIN_DATOS**, **81 siguen REVISAR**. Duración del
  procesamiento: 0,1s.
- Estado persistente acumulado en `artifacts/b11-2/state.json`: **200**
  ISBN (100 lote 01 + 100 lote 02), sin solapamiento — `TERMINADO` 24,
  `SIN_DATOS` 8, `REVISAR` 168.
- [PR #306](https://github.com/trexxeseba/amadolibros-web/pull/306)
  fusionado a `main` por trexxeseba (squash, commit `662c13c`),
  2026-09-02.
- Deploy to Cloudflare Pages sobre `662c13c`: `run 33581187859`,
  **success**.
- Full commerce production audit (dispatch manual, `sample_only=true`),
  `run 33634575851`: **result=pass, critical=0** — catálogo 7.115
  items, feed Merchant 3.702 items (0 críticos/warnings), 300/300
  imágenes válidas (`r2-production`), 300/300 páginas verificadas.
- Book enrichment live check contra Producción
  (`https://www.amadolibros.com`), `run 33634584205`: **1.535
  verified, 15 not_applicable, 0 failed** sobre el registry completo de
  **1.550** ISBN (1.535 + 15 = 1.550, exacto).
- Los 12 ISBN de este lote verificados individualmente contra
  Producción, todos `verified`, cada uno con sus propios MLU reales y
  sin mezcla de datos entre ISBN: `9781711054490` (MLU1031375038,
  MLU1033790258), `9786074485905` (MLU638995253, MLU676667854),
  `9788408039532` (MLU619139873, MLU663111902), `9788408239321`
  (MLU1494561902, MLU1494066700), `9788408249436` (MLU668636662,
  MLU668440964), `9788408257363` (MLU625847761, MLU654868116),
  `9788408262770` (MLU620296782, MLU649316004), `9788411323000`
  (MLU698429827), `9788412364163` (MLU660119936, MLU660297658),
  `9788412440843` (MLU692240645, MLU692279433), `9788415292494`
  (MLU634314472, MLU654449602), `9788415577133` (MLU685273682,
  MLU685118228).
- Tests: suite completa **1.052/1.052** + `validate-ci.sh` OK +
  `git diff --check` limpio.
- Contadores tras este lote: REVISAR-status = 87 (lote 01, sin tocar) +
  356 (nunca intentados, 456 − 100) + 81 (lote 02, sin resolver) =
  **524**. SIN_DATOS: 1.534 + 7 = **1.541**. Verificación: 524 + 1.541
  = 2.065 pendientes; 1.550 enriquecidos + 2.065 pendientes = 3.615 —
  el universo total no cambia, sólo se movieron 12 ISBN de pendiente a
  enriquecido y 7 de REVISAR a SIN_DATOS.

## B11.2 Lote 03 final — TERMINADO (fusionado y verificado en Producción)

Autorizado explícitamente por Seba el 2026-09-02 para **agotar el pool
automático en una sola ejecución**, sobre los 356 ISBN `REVISAR` que nunca
habían sido intentados. No tocó el pool `SIN_DATOS`.

- Resultado real: **59 TERMINADO** (integrados al registry), **23
  SIN_DATOS**, **274 siguen REVISAR**. Procesados: 356. Duración del
  procesamiento: 0,1s, sin ninguna llamada de red — reutiliza la evidencia
  inmutable ya commiteada por B11.1.
- Coincide exactamente con la simulación previa (59/23/274), como era
  esperable: la evidencia no cambia y cada ISBN se evalúa por separado. Se
  verificó además que un único lote de 356 y cuatro lotes secuenciales de
  100 producen clasificaciones idénticas, sin una sola diferencia.
- Registry: **1.550 → 1.609**. Campos publicados en el resultado final:
  `publication_year` en 54 ISBN, `publisher` en 19, `author` en 4 y
  `language` en **0** — los 8 `language` que generó la primera corrida se
  retiraron con la corrección de MARC 041 descrita más abajo. Fuentes: Open
  Library en los 59, Biblioteca Nacional de España en 47, Google Books en
  34. Los 59 tienen `sample_listing_id` MLU real y procedencia en `https`.
- Tasa de resolución: 16,6% (59/356), por encima del 12,0% de los lotes 01
  y 02. La diferencia es de composición, no de método: 213 de los 356
  restantes son prefijo 978-84 (registro español), que resuelve al 24%,
  mientras que los prefijos latinoamericanos 978-95x y 978-98x resuelven
  al 4-6%.

### El circuito automático quedó agotado

`artifacts/b11-2/state.json` pasa de 200 a **556** entradas, que son
exactamente los 556 ISBN `REVISAR` que dejó B11.1: **no queda ninguno sin
intentar**. Hay un test que lo verifica cruzando el estado persistente
contra el report original de B11.1, no por conteo.

Estado acumulado: `TERMINADO` 83, `SIN_DATOS` 31, `REVISAR` 442. Por lote:
100 (lote 01) + 100 (lote 02) + 356 (lote 03 final).

Reintentar los 442 `REVISAR` restantes con la evidencia actual daría
idéntico resultado. Avanzar más exige evidencia nueva —una fuente
adicional o redacción manual—, no otra corrida del resolver.

### Protección contra sobrescritura

Los defaults de `B11_2_FACTS_OUTPUT` y `B11_2_SUMMARY_PATH` apuntan a los
archivos del Lote 01, y el resolver los reescribe por completo: correrlo
sin definirlos habría borrado del registry los 12 ISBN del Lote 01. Se
ejecutó con las cuatro variables explícitas (`B11_2_BATCH_SIZE=356`,
`B11_2_BATCH_NAME=lote-03-final`, y los dos archivos nuevos
`book-enrichment-facts-b11-2-lote-03.js` y `lote-03-final-summary.md`).
Verificado después de correr: los módulos y resúmenes de los lotes 01 y 02
quedaron sin cambios, y de las 200 entradas previas de `state.json` no se
perdió ni se alteró ninguna.

### Corrección semántica de `language` (cambios solicitados en el PR #308)

La revisión detectó un bloqueo semántico real: los 8 `bibliographic.language`
que publicaba este lote mezclaban el idioma del texto con el idioma de la
obra original. `scripts/seo/book-intelligence-bne.mjs` construía el campo
fusionando MARC 041 `$a`, `$d` y `$h`, cuando según MARC 21 `$a` es el idioma
del texto de esta edición, `$h` el de la obra original y `$d` el del
contenido cantado o hablado. Una traducción `041 1#$aspa$heng` quedaba
publicada como "Español, Inglés" siendo un libro enteramente en español.

Se corrigió en tres capas:

1. **Adaptador BNE**: `language` usa únicamente los `041$a` repetidos. No
   mezcla `$h` ni usa `$d` para libros impresos. Además, un código sin
   etiqueta conocida se descarta en vez de publicarse crudo — ése era el
   origen de `"Español, dut"`.
2. **Normalización**: `bookLanguageLabel()` traduce un código a etiqueta o
   devuelve `null`, para que un adaptador pueda descartarlo. Se agregó el
   neerlandés (`nl`/`nld`/`dut`), presente en la evidencia real.
3. **Resolver**: la caché de B11.1 es inmutable y sigue conteniendo los
   valores mezclados, así que no se editó a mano ni se sustituyeron los ocho
   valores por "Español". Se aplicó una regla conservadora y reproducible:
   **no se publica ningún `language` con más de un idioma**. El defecto sólo
   puede manifestarse como valor multivaluado (si `$a` y `$h` coinciden, la
   mezcla colapsa a un único idioma y el dato es correcto igual), así que la
   regla cubre exactamente el problema sin listar ISBN a mano.

`book-enrichment-facts-b11-2-lote-03.js` se **regeneró** con el resolver
corregido, partiendo del estado previo a la corrida. Resultado: los mismos 59
ISBN, **0 `language` publicados** (antes 8), y ningún otro campo cambió. Los
8 ISBN afectados conservan `publisher` y `publication_year`, así que siguen
siendo `TERMINADO` y los contadores no se mueven.

### Contaminación previa: pendiente de auditar en un PR separado

El mismo defecto dejó valores mezclados en módulos ya fusionados, que **este
PR no toca a propósito**. Auditoría del estado actual:

| Módulo | Con `language` | Multivaluados (sospechosos) |
| --- | --- | --- |
| `book-enrichment-facts-1000.js` | 13 | **13** |
| `book-enrichment-facts-333.js` | 2 | **2** |
| `book-enrichment-facts-lote-01.js` | 0 | 0 |
| `book-enrichment-facts-b11-2-lote-01.js` | 0 | 0 |
| `book-enrichment-facts-b11-2-lote-02.js` | 2 | **2** |
| `book-enrichment-facts-b11-2-lote-03.js` | 0 | 0 |
| **Total** | **17** | **17** |

Los 17 valores que quedan publicados en el catálogo son multivaluados y los
17 provienen de la Biblioteca Nacional de España, es decir que replican
exactamente el defecto corregido. Incluyen otro código crudo (`"Español,
dan"` en `9788418859694`). Los dos casos de B11.2 Lote 02 son
`9788408039532` ("Español, Francés") y `9788415292494` ("Español, Inglés").

**Siguiente PR técnico, separado:** auditar los 17 `bibliographic.language`
existentes contra MARC 041`$a` y corregirlos o retirarlos. No se hace acá
para no mezclar la corrección del Lote 03 con la limpieza histórica.

### Validación

- Tests focales de B11.2, del adaptador BNE y de los lotes previos:
  **44/44**.
- Suite completa: **1.547/1.547**, 0 fallos (la de Functions pasa de 1.052 a
  1.067 con los tests nuevos del Lote 03 y las regresiones de `language`).
- `bash scripts/validate-ci.sh`: **Validación completa OK** (sintaxis, suite
  completa y los dos builds de Astro, checkout OFF y ON).
- `git diff --check`: sin errores.
- CI de GitHub Actions sobre `023b026`, el head que trae la corrección de
  `language` y todo el código del lote: los cuatro checks en verde —
  `Syntax & Build`, `Deploy and audit every PR Preview`, `Investigate 1000
  unique ISBN editions` y `Reproduce public SEO baseline` (este último se
  sumó porque el diff toca `scripts/seo/`).
- En un commit posterior de **sólo documentación** el job de preview falló
  por muestreo de imágenes: 77 de 80 imágenes válidas, 3 sin responder desde
  R2, con feed, catálogo y páginas en 0 críticos (80/80 páginas OK). Es un
  fallo transitorio de red, no del cambio: la corrida inmediatamente anterior
  con el mismo código dio 80/80, y el diff entre ambos commits es un único
  archivo Markdown. La auditoría toma una muestra distinta de 80 imágenes en
  cada corrida.
- Book enrichment live check contra el Preview del PR
  (`https://pr-308.amadolibros-web.pages.dev`), dentro del job de preview:
  **1.594 ediciones activas verificadas en ficha y Merchant, 15 sin oferta
  activa como no aplicables** — 1.594 + 15 = 1.550 + 59 = **1.609**, exacto.
  Los **59 ISBN del Lote 03 aparecen los 59 como `verified`**, cada uno con
  sus propios MLU reales y sin mezcla de datos entre ISBN. Los 8 que
  perdieron el `language` siguen verificados por sus otros hechos (por
  ejemplo `9788417346935` con MLU612098974 y MLU655413122, o `9788433029102`
  con MLU625756445 y MLU652705502).

### Fusión y verificación en Producción (2026-09-03)

- [PR #308](https://github.com/trexxeseba/amadolibros-web/pull/308) fusionado
  a `main` (squash, commit `ebe83ff`), 2026-09-03T00:14:10Z, con los cuatro
  checks en verde sobre su head final `0878104`.
- Deploy to Cloudflare Pages sobre `ebe83ff`: `run 33698641329`, **success**
  en sus cuatro jobs (guard, validate, publish catalog y deploy con smoke
  test).
- Full commerce production audit (auto-disparada tras el deploy,
  `run 33699289571`): **result=pass, critical=0** — catálogo 7.115 items,
  feed Merchant 3.702 items (0 críticos/warnings), 300/300 imágenes válidas,
  300/300 páginas verificadas, sitemap con 10.086 URLs de libro.
- Book enrichment live check contra Producción
  (`https://www.amadolibros.com`): **1.594 verified, 15 not_applicable, 0
  failed** sobre el registry completo de **1.609** ISBN (1.594 + 15 = 1.609,
  exacto). Los **59 ISBN del Lote 03 aparecen los 59 como `verified`** en
  Producción, con sus propios MLU reales (por ejemplo `9788417346935` con
  MLU612098974 y MLU655413122). Nota operativa: el dispatch manual del
  workflow devolvió `HTTP 403` para el token de esta sesión, así que esta
  corrida se ejecutó localmente con el mismo script
  (`scripts/seo/book-enrichment-live-check.mjs`) apuntado a Producción — es
  el mismo chequeo HTTP de solo lectura que corre el workflow.

### Anomalía menor registrada

Tres tests fijaban el total del registry en 1.550 como literal
(`b11-2-lote-02.test.js`, `b11-2-resolve-revisar.test.js` y
`book-enrichment-lote-01.test.js`), así que cada lote nuevo los rompe hasta
que se actualizan a mano. Se actualizaron a 1.609. No es un fallo del lote,
pero conviene saber que ese literal hay que tocarlo en cada corrida.

## PR #298 — CERRADO

Registrado como definitivamente cerrado y fusionado. Ver detalle completo en
`PLAN-MAESTRO.md`. No requiere ninguna acción adicional.

---

## Checkout V1.1 — PR #310 fusionado y desplegado (workstream separado de B11)

Este documento es "ESTADO ACTUAL — B11" por título e historial, pero se dejó
constancia acá porque el checkout V1.1 (rediseño de `/carrito`, corrección
del bloqueante de D1 Preview y del ciclo de vida de idempotencia) se fusionó
y desplegó en paralelo a B11, sobre la misma rama principal. No forma parte
de B11 y no consume ni afecta sus contadores.

**Estado actual (2026-09-05):**

- **PR #310:** fusionado a `main` y **desplegado en Producción** (evidencia
  abajo).
- **Checkout:** **congelado comercialmente** — no se toca código de
  checkout ni de Producción mientras la prioridad activa sea un
  diagnóstico (Merchant Center) o una verificación pendiente de cierre
  (GA4).
- **Acción activa actual (Gran Apuesta en curso):** **Google Merchant
  Center** — diagnóstico real (aprobados, desaprobados, advertencias,
  cobertura del feed), **sin iniciar todavía, no declarado verificado**.
  Ver `PLAN-MAESTRO.md`, sección "🎯 Gran Apuesta en curso".
- **Verificación GA4 post-checkout:** EN ESPERA DE EVIDENCIA (ya no es la
  Gran Apuesta activa). Verificado: instrumentación, puente Apps Script +
  Google Sheet, compra real `AL-260820-W33NZ9` (transaction_id + $2.750
  UYU), mobile vs. desktop. Falta: validar una compra real posterior al
  deploy del checkout V1.1 (PR #310, commit `03abd31`). Ver
  `PLAN-MAESTRO.md`, "Backlog — checkout V1.1", entrada 2.

- [PR #310](https://github.com/trexxeseba/amadolibros-web/pull/310)
  fusionado a `main` por trexxeseba (commit `03abd3151fa093609c0c511d8207a056cd3fda19`),
  2026-09-04T08:46:00-03:00.
- Alcance del PR: guía de checkout (entrega/envío gratis), rediseño
  profundo de `/carrito` (layout 2 columnas, selector de pago, CTA único),
  Preview dedicada con checkout realmente encendido
  (`deploy-checkout-v11-preview.yml`), corrección del bloqueante real de
  `POST /api/orders` en esa Preview (migraciones D1 de Preview atrasadas —
  causa raíz confirmada con `PRAGMA table_info` antes/después), evento GA4
  `checkout_error` sin PII, y corrección del ciclo de vida de
  `idempotency_key` vs. `request_fingerprint` (bloqueante real encontrado
  en prueba humana: reutilizar la key de una orden ya creada al cambiar el
  pedido chocaba con el fail-safe 409 del backend).
- Validación humana previa al merge, documentada en el propio PR: Retiro +
  Mercado Pago, Envío + Mercado Pago y Retiro + Transferencia probados
  sobre `https://checkout-v11-preview.amadolibros-web.pages.dev/carrito/`
  sin conflicto de idempotencia en el recorrido completo (crear orden →
  volver → cambiar entrega/medio de pago → reintentar).
- Deploy to Cloudflare Pages sobre `03abd31`: `run 33869494365`. El job
  "Deploy" (build Astro, migraciones D1 de Producción, Wrangler, smoke
  test de Producción) terminó en **success**; el job "Publish production
  paused/active catalog" (sincronización de catálogo, independiente del
  checkout) seguía en curso al momento de este registro — no bloquea ni
  condiciona el propio deploy del checkout, que ya está confirmado en
  Producción.
- **No se tocó nada de B11** en este PR: registry, `state.json` de B11.2 y
  los contadores de la sección "Estado canónico" de este documento
  permanecen exactamente en 1.609 enriquecidos / 2.006 pendientes / 3.615
  universo, sin ningún cambio.
- Detalle técnico completo (causa raíz, corrección, tests, checks) en el
  propio PR #310 y en su historial de comentarios.

### Orden de prioridades vigente (actualizado 2026-09-05)

Seba autorizó explícitamente el siguiente orden — el único vigente,
reemplaza el del 2026-09-04. Detalle completo (responsable, esfuerzo,
criterio de aceptación, evidencia requerida) de cada punto en
`PLAN-MAESTRO.md`:

1. **Google Merchant Center — 🎯 EN CURSO (única Gran Apuesta activa).**
   Diagnóstico real del feed (aprobados, desaprobados, advertencias,
   cobertura), directamente contra la consola de Merchant — no contra el
   conteo interno ya existente. Responsable: ChatGPT + Seba, con Claude
   Code para cambios técnicos si fueran necesarios. Sin avance registrado
   todavía; **no declarar verificado**.
2. **Verificación GA4 post-checkout — EN ESPERA DE EVIDENCIA.** Dejó de
   ser la Gran Apuesta activa el 2026-09-05. Verificado: instrumentación,
   puente Apps Script + Sheet, compra real `AL-260820-W33NZ9`
   (`transaction_id` + $2.750 UYU), mobile vs. desktop. Falta: una compra
   real posterior al deploy del checkout V1.1 (PR #310, commit `03abd31`).
3. **Google Search Console — registrado, NO iniciado.**
4. **SEO técnico / indexación / fichas — registrado, NO iniciado.**
5. **Blindaje técnico de Amado — registrado, NO iniciado.**
6. **Limpieza de los 17 `bibliographic.language` históricos** (heredado de
   B11) — **pausado.**
7. **B12 — enriquecimiento de fichas activas** (heredado de B11) — **EN
   CURSO, primera tanda entregada**: 481 fichas activas mejoradas y
   verificadas en el Preview desplegado. La meta de 1.000 sigue pendiente y
   continúa después.

Ninguno de los puntos 2-7 está autorizado para iniciar trabajo sin
autorización explícita y separada de Seba.


## QW2 — sistema general de imágenes (rama Codex, 2026-09-06)

- **Responsable:** Codex. **Esfuerzo:** implementación transversal + validación CI/Preview.
- **Base:** main `ea0c4756cd1dfb44756d68d719d864cf9d9a8284`. Rama `codex/catalog-image-system`.
- **Alcance:** todas las imágenes del catálogo, actuales y futuras, en las 16 posiciones admitidas por la web; activos y bloques completos de pausados. Sin listas de MLU/ISBN para resolver imágenes.
- **Implementado en rama:** búsqueda de variantes nativas del mismo archivo ML, medición de bytes, selección sin reducir dimensiones, master R2 inmutable, preservación de copias mejores, caché por hash y cola persistente de fuentes insuficientes/inaccesibles.
- **Continuidad:** cron existente, lotes limitados a 100 imágenes; cursor persistente para pausados; errores con espera de 6 horas, fuentes <500 con revisión semanal, masters con revisión mensual. Cambiar la versión de la política obliga a recorrer de nuevo las imágenes conocidas.
- **Aceptación:** tests de todas las posiciones, fuente inaccesible sin bloqueo, preservación y caché; CI y Preview verdes; ejecución real de un lote automático en R2 Preview; igualdad SHA-256 entre master y URL web. El lote de verificación no limita el alcance del sistema.
- **Estado:** implementado en Draft #323. CI y prueba de imágenes R2/Preview verificadas en `1129dd4`; snapshot activo real de 2026-09-06: 7.104 productos / 32.569 imágenes. Lote automático de 100: 100/100 SHA-256 verificados, 81 fuentes mayores que la URL del catálogo, 74 >=500, 26 todavía insuficientes, 0 errores de validación. No son upgrades productivos: eran copias nuevas en Preview (0 masters existentes mejorados). Catálogo completo todavía no procesado.
- **Google:** filtro mínimo de ambos lados >=500 disponible para feed/JSON-LD mediante `COVER_GOOGLE_QUALITY_GATE=true`. Configurado en true para el futuro despliegue productivo autorizado: preflight read-only conserva 3.697/3.697 ofertas actuales, 0 excluidas. Preview mantiene el filtro apagado por tener un bucket parcial. Evidencia: Actions `34028835918`, artifact `9987951211`. La configuración aún no está desplegada.
- **Cloudflare Images:** binding de pago existente conservado para la arquitectura actual. La generación artificial queda desactivada por defecto: no inventa resolución ni sustituye la búsqueda de fuente real. Las variantes responsive web existentes consumen el master mediante `/book-cover/`.
- **Límites reales:** ML puede no ofrecer una fuente >=500; esos casos quedan pendientes con evidencia y reintento, no se contabilizan como corregidos. Buscar fuentes editoriales por edición sigue requiriendo datos verificables.
- Sin merge, sin deploy de producción, sin escritura en R2 productivo ni cambios en checkout. La prueba temporal sólo escribe en R2 Preview; el manifest productivo se lee para medir el impacto del filtro.
- QW3A2 y la consolidación central de documentación en #316 siguen a cargo de Claude. Este apartado registra únicamente el trabajo QW2 de esta rama.
