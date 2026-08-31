# ESTADO ACTUAL — B11: enriquecimiento editorial real (2.000 fichas)

Última actualización: 2026-08-31 (sesión `session_014vUFN9BC9DEb3Nh1B477Ri`).

## Contadores acumulados

| Métrica | Valor |
| --- | --- |
| Fichas procesadas (evaluadas para este plan de 2.000) | 0 |
| Fichas enriquecidas correctamente (redacción real publicada en este plan) | 0 |
| Fichas descartadas por falta de datos confiables | 0 |
| Fichas pendientes | 2.000 |
| PRs abiertos (lotes) | 0 |
| PRs fusionados (lotes) | 0 |

Estos contadores son del **plan de redacción de los 10 lotes**, no de la
investigación previa: PR #298 dejó 2.000 ISBN investigados y clasificados en
dossiers, pero con `publication_allowed: false` — ninguno fue redactado ni
publicado. Ese trabajo es el insumo, no el resultado.

## PR #298 — CERRADO

Registrado como definitivamente cerrado y fusionado. Ver detalle completo en
`PLAN-MAESTRO.md`. No requiere ninguna acción adicional.

## 🔴 Bloqueo activo — impide iniciar el Lote 1

Al intentar iniciar el Lote 1 (selección de 200 ISBN + investigación
bibliográfica real) se verificó que **este entorno de ejecución no tiene
salida de red hacia ninguna de las fuentes necesarias**:

| Destino | Necesario para | Resultado |
| --- | --- | --- |
| `pub-b2b408811ae24e3da04cda79c6ff084d.r2.dev` (`CATALOG_URL`, catálogo real del sitio) | Seleccionar las 2.000 fichas candidatas | Bloqueado por el proxy de egreso (403, política de organización) |
| `openlibrary.org` | Investigación bibliográfica (fuente pública, sin API key) | Bloqueado por el proxy de egreso (403) |
| `catalogo.bne.es` (Biblioteca Nacional de España) | Investigación bibliográfica (fuente pública, sin API key) | Bloqueado por el proxy de egreso (403) |
| `www.googleapis.com` (Google Books) | Investigación bibliográfica | Alcanzable, pero **cuota diaria agotada** (`RESOURCE_EXHAUSTED`) para el proyecto configurado; no tengo una API key propia |
| Librerías/editoriales (Casa del Libro, sitios de editoriales, etc.) | Fuentes `commercial_reference` / `publisher` para el tier `editorial_real_v1` | Bloqueado por el proxy de egreso (403) |
| `productionresultssa17.blob.core.windows.net` (descarga del artifact de CI con los 2.000 dossiers ya investigados por PR #298, run `33388882918`) | Reutilizar la investigación ya hecha en CI en vez de repetirla | Bloqueado por el proxy de egreso (403) |

Lo único con salida de red confirmada desde esta sesión es GitHub
(`github.com`, `api.github.com`, `raw.githubusercontent.com`) y algunos
registries de paquetes (npm, pypi). Probé además vía el tool `WebFetch`
(no solo `curl`) y el bloqueo es el mismo: `EGRESS_BLOCKED` a nivel de
proxy de la organización, no un límite de la herramienta.

**Consecuencia real:** no puedo obtener el catálogo real, ni investigar
bibliografía verificable, ni reutilizar los dossiers ya investigados por CI.
Cualquier ficha "enriquecida" que produjera en este momento tendría que
basarse en datos no verificables desde esta sesión — lo cual viola
directamente la regla de no inventar contenido y de usar solo fuentes
confiables.

**No voy a fabricar contenido ni simular verificación para completar el
contador.** Prefiero reportar 0/2.000 real antes que 2.000 falsos.

### Opciones para desbloquear (una sola alcanza)

1. Ampliar la política de red de este entorno (`env_01LJa9rxrtnhR4pwpabC8j7q`,
   "Default - trusted network access") para permitir `openlibrary.org`,
   `catalogo.bne.es`, el bucket R2 del catálogo y/o los dominios de
   descarga de artifacts de GitHub Actions (`*.blob.core.windows.net`).
2. Proveer una API key propia de Google Books con cuota disponible
   (variable de entorno) — con eso alcanzaría una sola fuente reachable,
   aunque seguiría faltando una segunda fuente independiente para el tier
   `editorial_real_v1`.
3. Ejecutar la investigación (o volver a correr el workflow
   `book-editorial-real-2000.yml`) en un entorno con red abierta (por
   ejemplo, GitHub Actions, que sí tiene salida completa) y dejar el
   resultado como archivo commiteado en el repo o accesible por HTTPS desde
   `github.com`/`raw.githubusercontent.com`, que sí son alcanzables desde
   aquí.
4. Indicar otra fuente de datos bibliográficos ya disponible dentro del
   repo o accesible por GitHub que pueda usarse en lugar de las anteriores.

En cuanto se resuelva el bloqueo, el Lote 1 arranca de inmediato sin pedir
autorización adicional, según el flujo ya definido en `PLAN-MAESTRO.md`.
