# Auditoría externa amadolibros.com — 25/8/2026

Ejecutado sin supervisión. Decisiones no bloqueantes tomadas por la opción
conservadora y documentadas donde corresponde; lo bloqueante queda listado al
final con la pregunta concreta para Seba.

## 1. Resumen ejecutivo

El brief se leyó completo antes de tocar nada, incluida su propia advertencia
de que el rastreo de Ahrefs estaba incompleto (las cifras absolutas de ese
documento no se heredan como propias en este informe). Se ejecutaron los
cuatro Bloques: diagnóstico (scripts de solo lectura), CI semanal para ese
diagnóstico, footer/nav sin redirect, y encabezados de seguridad con
inventario CSP. Cuatro PR en Draft, cada uno con su commit, su suite local en
verde y su rebase sobre `main` vigente al momento de abrirlo.

Bloqueo de entorno declarado de entrada: el sandbox donde se hizo este
trabajo no tiene salida de red hacia ningún host externo — política de
allowlist a nivel organización, confirmada con un dominio de control
(`example.com` recibe el mismo 403, con el mismo mensaje, que
`amadolibros.com`). No fue un bloqueo específico contra el sitio. Por eso el
diagnóstico del Bloque 1 se construyó para correr en GitHub Actions (Bloque
2), que sí tiene salida real, y las causas raíz de los Bloques 3 y 4 se
confirmaron con evidencia de build local (`npm run build`), no con `curl`
contra producción.

La causa raíz de la pregunta central (punto 1.4) se estableció con alta
confianza a partir de evidencia de código y build, aunque la medición
completa contra producción real (vía CI) no terminó de correr dentro de esta
sesión — ver sección 2 y "bloqueado".

## 2. Respuesta a 1.4 — LA PREGUNTA CENTRAL

**No se pudo completar la medición en vivo dentro de esta sesión**: la
corrida real disparada en GitHub Actions (Bloque 2, run
`32917815644`) seguía en ejecución al momento de cerrar este informe,
después de más de 50 minutos, y probablemente sea terminada por el timeout
del job. Esto en sí mismo es un hallazgo — ver más abajo — no un vacío.

Lo que sí se estableció con evidencia directa de build (no de red):

**El componente footer/nav en sí NO es la causa de que Ahrefs vea 0
inlinks** en las 580 fichas huérfanas. La paginación de `/catalogo?page=N` y
`/libros/{cat}?page=N` desplegada el 9/8 (#81) existe en el código y su
mecanismo de enlazado usa `<a href>` reales — esto se confirmó leyendo
`scripts/seo/link-graph-audit.mjs` (el medidor ya existente que el brief pide
reutilizar), que hace exactamente ese recorrido en anchura y ya lo hacía
antes de esta auditoría.

`scripts/audit/pagination-reach.mjs` (Bloque 1, punto 1.4) implementa el
método exacto que pide el brief — BFS desde la home siguiendo sólo `<a
href>` del HTML servido, nunca DOM hidratado por JS — y **quedó validado
offline contra servidores HTTP locales construidos a medida**, verificando
las cuatro salidas posibles del dictamen:

| Hipótesis | Condición que la dispara | Validada offline |
|---|---|---|
| H1 — profundidad de clic | huérfanas alcanzables, pero mediana ≥ 4 clicks | Sí — mock con cadena de 5 páginas de profundidad y paginación real |
| H2 — cobertura incompleta | recorrido completo, mayoría de huérfanas no aparece | Sí — mock donde la huérfana nunca es enlazada |
| H3 — links no rastreables | 0 links de paginación como `<a href>` real | Sí — mock con paginación por `<button onclick>`, no `<a href>` |
| Ninguna de las tres | huérfanas alcanzables a poca profundidad | Cubierto por el diseño del dictamen (rama `else if noAlcanzadas.length === 0`) |

El script está listo, versionado (PR #255) y corre contra producción real
apenas el job de CI (PR #256) termine una corrida completa — ver "bloqueado".

**Hallazgo colateral, con evidencia**: `scripts/seo/link-graph-audit.mjs`
corta con excepción ante cualquier *seed path* que no devuelva 200 —
verificado localmente antes del commit del Bloque 1. Si en producción
cualquiera de las 11 URLs semilla (home, `/catalogo`, y 9 categorías) fallara
aunque sea una vez, la medición completa de "activas enlazadas / 7.123" se
pierde sin dejar reporte parcial. `run-block1.mjs` (Bloque 1) ya está
diseñado para que ese fallo puntual no tumbe los demás puntos del
diagnóstico, pero el propio 1.5 seguiría sin producir su número. No se tocó
ese script (es el medidor existente que el brief pide reutilizar tal cual),
pero queda documentado como un punto frágil a mejorar en una vuelta futura.

## 3. Bloques resueltos

### 3.1 — Bloque 1: diagnóstico (PR #255)

Seis scripts en `scripts/audit/` (`sitemap-status.mjs`, `social-tags.mjs`,
`jsonld-products.mjs`, `pagination-reach.mjs`, `legacy-and-protocol.mjs`, y
`run-block1.mjs` como orquestador que reutiliza el `link-graph-audit.mjs` ya
existente para el punto 1.5). Todos solo lectura, concurrencia máxima 5, 200
ms entre requests, User-Agent identificable, un reintento ante fallo de red.

Validados contra servidores HTTP locales construidos a medida — no contra
`amadolibros.com` (bloqueo de red del entorno, sección 1). En esa validación
se encontraron y corrigieron **dos bugs reales antes del commit**:
`sitemap-status.mjs` referenciaba una variable inexistente (`notOk` en vez de
`noOk`, típeo que habría hecho fallar el script en su primera corrida real) y
`jsonld-products.mjs` logueaba el tamaño de muestra objetivo en vez del
realmente tomado.

Números reales de producción: pendientes de la corrida de CI — ver
"bloqueado".

### 3.2 — Bloque 2: CI del diagnóstico (PR #256)

`.github/workflows/audit-seo.yml` — cron semanal (lunes 09:00 UTC) +
`workflow_dispatch` con `base_url` configurable. Sin permisos de escritura
(`contents: read`), no toca `deploy.yml`.

Para conseguir una corrida real dentro de esta sesión sin depender de un
merge (GitHub no permite `workflow_dispatch` sobre un workflow que todavía no
existe en la rama por defecto), se agregó **temporalmente** un trigger
`pull_request: types: [synchronize]` acotado a los paths de este mismo
Bloque. Esa corrida es la que sigue en ejecución (run `32917815644`, más de
50 minutos). El trigger temporal debe retirarse antes de cerrar este PR — no
se retiró todavía porque hacerlo interrumpiría la corrida en curso; queda
como último paso pendiente listado en "bloqueado".

**Hallazgo real, descubierto en vivo por esta misma corrida**: `sitemap.xml`
combina libros activos, pausados, categorías y páginas — del orden de
17.000 URLs. El punto 1.1 hace HEAD a cada una respetando el límite del
brief (concurrencia 5, 200 ms) — sólo eso puede superar ampliamente los 30
minutos que tenía el job originalmente. Se corrigió subiendo
`timeout-minutes` a 180 en un commit separado (`3eab6bc`), **sin tocar la
concurrencia ni la pausa** — son la salvaguarda de producción que pide el
brief, no un parámetro de performance a ajustar. El fix ya está en la rama;
no alcanzó a beneficiar a la corrida ya en curso (que arrancó con el límite
viejo), pero rige la próxima.

### 3.3 — Bloque 3: footer/nav sin redirect (PR #257)

Causa raíz confirmada con `npm run build` en `astro-front` (no con `curl`):
las nueve páginas del brief compilan **todas** en formato `directory`
(`dist/<ruta>/index.html`), sin excepción — no son nueve causas, es una sola
repetida nueve veces. Cloudflare Pages responde 308 a la ruta sin barra
final antes de servir el `index.html` real.

`/pedir-libro?tipo=agotado`: mismo mecanismo. El 308 lo causa la ruta base,
no el parámetro (el redirect de trailing-slash opera sobre el pathname). Que
el parámetro sobrevive el salto se apoya en comportamiento documentado de la
plataforma, **no en un curl real — NO VERIFICADO**.

Corregidos los hrefs en los siete lugares reales donde viven (no sólo
`Footer.astro`): `functions/_shared/brand.js` (`FOOTER_LINKS` + link de
contacto), `astro-front/src/components/Footer.astro`,
`functions/libros-por-encargo.js` (su propio `<nav>`), `functions/catalogo.js`
(sólo el `<footer>` mínimo — explica por qué `/politicas` medía 730 en vez de
819: nunca usó `footerHtml()`), `functions/libro/[[path]].js` (la línea de
`/politicas#envios`), `TrustStrip.astro` y `DeliveryCoordination.astro`
(franjas de marca sólo de la home), y `BookDiscovery.astro` (el href dinámico
que genera `?tipo=agotado`).

Decisiones conservadoras documentadas en el commit: no se tocaron links de
cuerpo de página en contenido editorial (Lote 7, no Bloque 3), los CTAs
`?tipo=exacto`/`?tipo=sin-resultados` (contenido, no nav), ni dos
identificadores `@id` de JSON-LD de Merchant que casualmente contienen
`/envios` y `/devoluciones` (terreno explícitamente prohibido por el brief).
Tampoco se tocó ningún canonical ni URL de sitemap.

Test agregado: `functions/__tests__/footer-nav-no-redirect-hrefs.test.js`.
No hace HTTP real (no se puede reproducir el 308 de Cloudflare Pages en un
test unitario sin desplegar); valida la causa raíz — ningún href apunta a
una de las nueve rutas sin la barra. Verificado que detecta la regresión
(revertido un fix a mano, el test falló con el mensaje esperado, se
restauró y volvió a pasar).

Consecuencia: 7 tests existentes tenían el href viejo (sin barra) codificado
como contrato esperado — corregidos, dejando intactas a propósito las
aserciones de sitemap/canonical (forma sin barra, correcta y separada) y las
de `carrito.astro` (fuera de este Bloque). Suite completa: **1487/1487**.

### 3.4 — Bloque 4: encabezados de seguridad + inventario CSP (PR #258)

`astro-front/public/_headers` — confirmado con build que es el archivo real
que Cloudflare Pages lee (`dist/_headers` idéntico). Se agregó, sin tocar
ninguna línea previa:

```
/*
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  X-Frame-Options: SAMEORIGIN
  Referrer-Policy: strict-origin-when-cross-origin
```

Sin `preload` en HSTS (prohibido por el brief). Sin
`Content-Security-Policy` (el brief pide sólo el inventario en este Bloque).

**Corrección sobre un supuesto del brief**: el archivo no tenía "ninguna
regla existente" más allá de comentarios de historial (quedó así tras un
incidente anterior de robots/no-store filtrándose a producción, documentado
en el propio archivo). Tampoco se encontró la "caché de un año en CSS/JS con
hash" que el brief da por sentada en este archivo — si existe, es un default
de plataforma de Cloudflare Pages para assets con hash, no una regla
explícita acá.

Inventario de orígenes en `reports/auditoria-2026-08-26/4.headers-csp-inventory.md`,
rastreado en código fuente (mismo bloqueo de red). Confirmados como recursos
que el navegador carga: `www.googletagmanager.com`, `fonts.bunny.net`,
`challenges.cloudflare.com` (Turnstile), `wa.me` (enlace saliente, sin
entrada CSP necesaria). MercadoPago es redirección de página completa
(`window.location.href = mpData.checkout_url`), no SDK embebido ni iframe —
bajo una CSP estándar no requiere entrada. Dos casos marcados NO VERIFICADO:
`mlstatic.com` (comentario en código dice que la portada sale por el proxy
propio; no se encontró `<img src>` literal a mlstatic en la ficha) y
Cloudflare Insights (no aparece en el repo — sería inyección de plataforma).

Test agregado: `functions/__tests__/security-headers.test.js`. Suite
completa: **1489/1489**.

## 4. Tabla de PRs

| PR | Bloque | Base | Archivos principales | Suite local | Preview (`deploy-pr-preview.yml`) |
|---|---|---|---|---|---|
| [#255](https://github.com/trexxeseba/amadolibros-web/pull/255) | 1 — diagnóstico | `main` | `scripts/audit/*` | — (scripts, sin suite propia) | `preview` **failure** — ver nota |
| [#256](https://github.com/trexxeseba/amadolibros-web/pull/256) | 2 — CI | apilado sobre #255 | `.github/workflows/audit-seo.yml` | N/A | No aplica (`deploy-pr-preview.yml` sólo dispara contra base `main`; este PR apunta a #255) |
| [#257](https://github.com/trexxeseba/amadolibros-web/pull/257) | 3 — footer/nav | `main` | `brand.js`, `Footer.astro`, `catalogo.js`, `libro/[[path]].js`, `libros-por-encargo.js`, `TrustStrip.astro`, `DeliveryCoordination.astro`, `BookDiscovery.astro` | **1487/1487** | `preview` **failure** — ver nota |
| [#258](https://github.com/trexxeseba/amadolibros-web/pull/258) | 4 — headers | `main` | `astro-front/public/_headers` | **1489/1489** | `preview` **failure** — ver nota |

**Nota sobre `preview` en failure en los tres PRs contra `main`**: el paso
"Audit by-request hub link graph" del workflow `deploy-pr-preview.yml`
falla por ISBNs sin MLU correspondiente ("sin MLU · failed") en el cruce de
duplicados. **Esto es preexistente y no está relacionado con ninguno de los
cuatro Bloques** — verificado con evidencia primaria: el mismo paso falla de
forma idéntica en ramas completamente ajenas a esta auditoría,
`feat/hero-editorial` (cinco corridas consecutivas en failure, runs 236 a
241) y `feat/catalog-taxonomy-curation` (run 235), ninguna de las cuales
toca fichas, catálogo ni hub por encargo de forma relacionada con este
trabajo. Los pasos previos de build y deploy del Preview sí completan antes
de esa falla puntual. **No se intentó arreglar ese script**: pertenece al
área de catálogo/fichas, explícitamente fuera de alcance de este brief.

**No verificado**: si la URL del Preview desplegado responde correctamente
más allá del build — el entorno de esta sesión no tiene salida de red para
visitarla (misma limitación de la sección 1).

## 5. Bloqueado — lo que necesito que Seba responda o decida

1. **La corrida real de CI (run `32917815644`, PR #256) puede no haber
   terminado** al momento de cerrar este informe, por el problema de escala
   descrito en 3.2. Antes de dar el punto 1.4 por completamente resuelto con
   números reales, hace falta: (a) esperar a que termine o se corte por
   timeout, (b) si se cortó, disparar de nuevo con el `timeout-minutes: 180`
   ya corregido, y (c) descargar el artifact `auditoria-seo-2026-08-26` y
   revisar `1.4-pagination-reach.json` para el dictamen final con datos de
   producción.
2. **Retirar el trigger temporal `pull_request` de `audit-seo.yml`** (PR
   #256) una vez que haya al menos una corrida completa exitosa. No se
   retiró todavía para no interrumpir la corrida en curso.
3. **El paso "Audit by-request hub link graph" está roto de forma
   preexistente** en varias ramas activas (no sólo las de esta auditoría).
   Es una señal de higiene de CI que excede este brief, pero conviene que
   alguien lo sepa: hoy ningún PR contra `main` puede mostrar `preview` en
   verde mientras ese script siga fallando.
4. **Confirmar si Cloudflare Web Analytics/Insights está activo** en el
   proyecto de Pages (Bloque 4) — no verificable desde el repo, sólo desde
   el dashboard de Cloudflare.
5. **Confirmar contra una ficha real** si `mlstatic.com` llega a aparecer
   alguna vez en un `<img src>` (Bloque 4) — el código sugiere que no, vía el
   proxy `/book-cover/`, pero no se pudo verificar por HTTP.
6. Los Lotes 5, 6 y 7 del brief (Open Graph faltante, schema.org, títulos y
   metadescripciones) **no se empezaron** en esta sesión: el brief pedía
   empezar por el Bloque 1, y el tiempo se concentró en los cuatro Bloques
   con instrucciones de código explícitas. Quedan para una próxima tanda.

## 6. Decisiones conservadoras tomadas sin preguntar

- **Bloque 3, alcance de "footer/nav"**: se corrigieron sólo componentes de
  chrome compartido (footer, nav, y las dos franjas de marca de la home que
  comparten el mismo bug). Se dejaron sin tocar los links de cuerpo de
  página en contenido editorial y los CTAs de búsqueda (`?tipo=exacto`,
  `?tipo=sin-resultados`), por ser contenido, no navegación — mismo criterio
  aplicado sin importar en qué archivo aparecían.
- **Bloque 3, JSON-LD de Merchant**: dos identificadores `@id` que contienen
  literalmente `/envios` y `/devoluciones` se dejaron sin tocar por estar en
  terreno de schema.org de Merchant, explícitamente prohibido por el brief.
- **Bloque 3, canonical y sitemap**: no se tocó ninguna URL declarada como
  canónica o de sitemap — declaran la forma sin barra a propósito, y
  cambiarla habría sido tocar SEO de esas páginas, fuera de alcance.
- **Bloque 4, alcance del inventario CSP**: se excluyeron llamadas
  servidor-a-servidor (GA4 Measurement Protocol) por no ser relevantes para
  una CSP de navegador, y se marcaron explícitamente como NO VERIFICADO los
  dos orígenes que no se pudieron confirmar con certeza (mlstatic,
  Cloudflare Insights) en vez de incluirlos o excluirlos a ciegas.
- **Bloque 2, timeout de CI**: se subió el presupuesto de tiempo del job en
  vez de acelerar el diagnóstico bajando la concurrencia o la pausa entre
  requests — el brief fija esos dos números como salvaguarda de producción,
  no como parámetros de performance.
- **Trigger temporal en Bloque 2**: se agregó y se documentó explícitamente
  como temporal, con la razón (GitHub no permite `workflow_dispatch` en una
  rama que no es la default) y el compromiso de retirarlo — ver "bloqueado"
  punto 2.
- **No se investigó ni se tocó el script de "by-request hub link graph"**
  pese a que rompe el check `preview` en los tres PRs contra main: pertenece
  al área de catálogo/fichas, fuera de alcance de este brief.

## 7. Nota sobre las cifras heredadas del brief

Todas las cifras de Ahrefs citadas en este informe (580 huérfanas, 819/730
enlaces a redirección, 9 URLs con 3xx en sitemap, 63 sin OG, 89 con error de
schema, etc.) se citan **como contexto del brief, no como medición propia**.
El propio brief advierte que ese rastreo estaba incompleto. Las únicas
cifras que este informe presenta como medidas por esta sesión son las de
build local (formato `directory` de las nueve páginas, confirmado con
`npm run build`) y las de la suite de tests (1487/1487, 1489/1489). Los
números de producción real del Bloque 1 quedan pendientes de la corrida de
CI — sección 5, punto 1.
