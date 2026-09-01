# ESTADO ACTUAL — B11: enriquecimiento editorial real (2.000 fichas)

Última actualización: 2026-09-01 (sesión `session_014vUFN9BC9DEb3Nh1B477Ri`).

## Contadores acumulados

| Métrica | Valor |
| --- | --- |
| Fichas procesadas (investigadas con evidencia real, este plan) | 2.276 |
| Fichas enriquecidas correctamente (verificadas, listas en PR) | 19 (18 `auto_publish_facts` + 1 `GREEN_FULL`) |
| Fichas descartadas por falta de datos confiables | 2.043 (`NO_EVIDENCE`) + 214 en revisión por conflicto de identidad |
| Fichas pendientes (universo total restante del catálogo) | 2.257 (2.276 investigadas − 19 ya resueltas) |
| PRs abiertos (lotes) | 1 — [PR #303](https://github.com/trexxeseba/amadolibros-web/pull/303) (draft, "no fusionar sin autorización de Seba") |
| PRs fusionados (lotes) | 0 |

Bloqueo de red del PR #300 resuelto: PR #301/#302 (infraestructura CI, ya
fusionados) permiten correr la investigación real con Google Books, Open
Library y BNE dentro de GitHub Actions y commitear el resultado al repo.
Detalle en `PLAN-MAESTRO.md`.

## 🔴 Hallazgo crítico — el objetivo de 2.000 fichas no es alcanzable tal como está planteado

La corrida real del Lote 1 (workflow `b11-batch-research.yml`, run
`33457523327`, PR #303) investigó **todo** el universo restante del
catálogo, no solo una muestra:

- **Universo total addressable:** 1.339 ISBN ya enriquecidos en lotes
  previos (bíblias + 1000 + 333 + Disney) + **2.276 ISBN elegibles
  restantes** (activos, vendibles, con ISBN válido, no enriquecidos
  todavía) = **3.615 ISBN únicos en total en todo el catálogo.**
- De esos 2.276 restantes, se investigaron los 2.276 (no hubo corte por
  presupuesto): Google Books devolvió 1 coincidencia exacta (39 errores —
  la autenticación WIF probablemente no está funcionando bien, a
  diferencia de Open Library y BNE que dieron 0 errores); Open Library
  encontró 507 coincidencias; BNE encontró 116.
- Después de cruzar título/autor para descartar conflictos de identidad y
  exigir evidencia suficiente por campo: **19 ISBN (0,8%) calificaron**
  para publicación automática. 214 (9,4%) tienen alguna evidencia pero con
  conflictos que exigen revisión humana caso por caso. 2.043 (89,8%) no
  tienen ninguna evidencia utilizable en estas tres fuentes gratuitas.
- **Ninguna de las 19 tiene sinopsis** (el campo que pediste primero). Son
  solo hechos bibliográficos verificados (editorial, páginas, año, temas).
  Ninguna fuente gratuita consultada trajo texto de contraportada/sinopsis
  para estos ISBN — el tier `editorial_real_v1` (con sinopsis real) exige
  además una fuente `source_edition` de editorial, que este pipeline
  automatizado no genera solo.

### Qué significa esto en números

- El **techo absoluto** del catálogo entero (ya enriquecido + investigado
  ahora) es 3.615 ISBN. Pedir "2.000 fichas **nuevas**" sobre un resto de
  2.276 ya exige enriquecer el 88% de todo lo que queda — con estas tres
  fuentes gratuitas, el rendimiento real es <1%.
- Aunque se corrija el problema de Google Books y se investigue con más
  presupuesto, no hay más ISBN que investigar: 2.276 es el 100% del resto
  del catálogo, no una muestra parcial.
- Llegar a 2.000 fichas con contenido editorial real (sinopsis incluida)
  requeriría fuentes adicionales (sitios de editoriales/librerías por
  ISBN, investigación caso por caso) que no son automatizables en bloque
  al mismo ritmo — el precedente real (Disney tomo 11, PR #296) llevó
  investigación dedicada para 1 solo ISBN.

**No voy a inflar estos números ni inventar contenido para simular 2.000
fichas.** Prefiero un plan más chico pero 100% real a uno grande y falso.
Corté acá para plantearte la decisión en vez de seguir gastando corridas
de CI persiguiendo un número que el catálogo no puede sostener.

## PR #298 — CERRADO

Registrado como definitivamente cerrado y fusionado. Ver detalle completo en
`PLAN-MAESTRO.md`. No requiere ninguna acción adicional.
