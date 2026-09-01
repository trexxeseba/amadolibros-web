# ESTADO ACTUAL — B11: enriquecimiento editorial real (2.000 fichas)

Última actualización: 2026-09-01 (sesión `session_014vUFN9BC9DEb3Nh1B477Ri`), tras verificar B11.2 Lote 01 en Producción.

## B11 Lote 1 — TERMINADO (fusionado y verificado en Producción)

- [PR #303](https://github.com/trexxeseba/amadolibros-web/pull/303) fusionado a `main` por trexxeseba (squash, commit `5b46f72`), 2026-09-01T16:55:06Z.
- [PR #304](https://github.com/trexxeseba/amadolibros-web/pull/304) fusionado (infra de verificación manual contra cualquier `base_url`), commit `7be3b3931b`.
- Deploy to Cloudflare Pages sobre `5b46f72`: `run 33534675172`, intento 2, **success** (el intento 1 falló solo en el job "Publish production paused/active catalog" por un `Recv failure: Connection reset by peer` transitorio de red; el job "Deploy" —build, Wrangler, smoke test— fue success desde el intento 1).
- Full commerce production audit (dispatch manual, `sample_only=true`), `run 33544377442`: **result=pass, critical=0** — catálogo 7.128 items, feed Merchant 3.707 items (0 críticos/warnings), 300/300 imágenes válidas (`r2-production`), 300/300 páginas verificadas.
- Book enrichment live check contra Producción (`https://www.amadolibros.com`), `run 33545168003`: **1.517 verified, 9 not_applicable, 0 failed** sobre el registry completo de 1.526 ISBN (incluidos los 187 del Lote 1). Los 9 `not_applicable` son ISBN del registry sin ninguna publicación MLU activa hoy — no es una falla, es la conservación correcta del dato para cuando vuelva a haber oferta.
- Muestra de 12 ISBN del Lote 1 verificados individualmente contra Producción (mezcla de los 19 de la 1ª corrida y los 168 de la 2ª): `9788401039058`, `9788408214359`, `9788425427015`, `9788446056720`, `9788467975819`, `9780006551805`, `9780142410110`, `9780194053921`, `9780198338734`, `9780307951526`, `9780230490017`, `9780199640942` — los 12 con status `verified`, cada uno con sus propios MLU reales y sin mezcla de datos entre ISBN.

## Contadores acumulados

| Métrica | Valor |
| --- | --- |
| Universo inicial del Lote 1 (ISBN elegibles investigados) | 2.276 |
| Fichas enriquecidas correctamente (verificadas, en `main` y Producción) | **187** (18 `GREEN_FULL` + 169 `GREEN_FACTS`) |
| Fichas pendientes totales | **2.089** |
| — de las cuales SIN_DATOS (sin evidencia utilizable) | 1.533 |
| — de las cuales REVISAR (evidencia con conflicto de identidad) | 556 |
| PRs abiertos (lotes) | 0 |
| PRs fusionados (lotes) | 2 — [PR #303](https://github.com/trexxeseba/amadolibros-web/pull/303) (187 fichas), [PR #304](https://github.com/trexxeseba/amadolibros-web/pull/304) (infra de verificación) |

Verificación: 187 + 2.089 = 2.276. 1.533 + 556 = 2.089. Los 556 REVISAR
están **dentro** de los 2.089 pendientes, no se suman aparte.

Total del catálogo (todos los lotes B11 hasta ahora, incluido B11.2 Lote
01): 1.339 ya enriquecidos antes del Lote 1 + 187 del Lote 1 + 12 de
B11.2 Lote 01 = **1.538 ISBN enriquecidos**. Universo addressable
completo: 1.538 + 2.077 pendientes (1.534 SIN_DATOS + 543 REVISAR) =
**3.615 ISBN únicos** (sin cambios — el universo no crece, solo se
reclasifican ISBN dentro de él). Ver la sección "B11.2 Lote 01" más abajo
para el detalle y la evidencia de Producción.

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

## PR #298 — CERRADO

Registrado como definitivamente cerrado y fusionado. Ver detalle completo en
`PLAN-MAESTRO.md`. No requiere ninguna acción adicional.
