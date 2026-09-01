# ESTADO ACTUAL — B11: enriquecimiento editorial real (2.000 fichas)

Última actualización: 2026-09-01 (sesión `session_014vUFN9BC9DEb3Nh1B477Ri`), tras la 2ª corrida del Lote 1 con Google Books corregido.

## Contadores acumulados

| Métrica | Valor |
| --- | --- |
| Universo inicial del Lote 1 (ISBN elegibles investigados) | 2.276 |
| Fichas enriquecidas correctamente (verificadas, integradas en PR #303) | **187** (18 `GREEN_FULL` + 169 `GREEN_FACTS`) |
| Fichas pendientes totales | **2.089** |
| — de las cuales SIN_DATOS (sin evidencia utilizable) | 1.533 |
| — de las cuales REVISAR (evidencia con conflicto de identidad) | 556 |
| PRs abiertos (lotes) | 1 — [PR #303](https://github.com/trexxeseba/amadolibros-web/pull/303) (draft, "no fusionar sin autorización de Seba") |
| PRs fusionados (lotes) | 0 |

Verificación: 187 + 2.089 = 2.276. 1.533 + 556 = 2.089. Los 556 REVISAR
están **dentro** de los 2.089 pendientes, no se suman aparte.

Total del catálogo (todos los lotes B11 hasta ahora): 1.339 ya enriquecidos
antes del Lote 1 + 187 de este lote = **1.526 ISBN enriquecidos**. Universo
addressable completo: 1.526 + 2.089 pendientes = **3.615 ISBN únicos**.

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

## PR #298 — CERRADO

Registrado como definitivamente cerrado y fusionado. Ver detalle completo en
`PLAN-MAESTRO.md`. No requiere ninguna acción adicional.
