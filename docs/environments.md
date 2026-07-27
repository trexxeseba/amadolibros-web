# Ambientes — Preview y Production (2-N-E1, actualizado en 2-N-G2)

Este documento describe la configuración centralizada introducida en 2-N-E1
(`functions/api/_env_config.js`). El código queda preparado para operar en
Preview y Production. Production ya tiene D1 propia, hosts declarados,
`MP_COLLECTOR_ID` confirmado y site key pública de Turnstile inyectada por
`deploy.yml` (2-N-G2) — pero el checkout permanece apagado y oculto:
`CHECKOUT_ENABLED` y `PUBLIC_CHECKOUT_ENABLED` siguen en `"false"` y
Mercado Pago no procesa ningún cobro real. `MP_ACCESS_TOKEN` y
`MP_WEBHOOK_SECRET` de Production están presentes por nombre en el dashboard
de Cloudflare Pages (confirmado en la auditoría 2-N-G1); sus valores no se
leen, validan ni modifican desde este repo ni en este lote.

## Principio general

El ambiente (`APP_ENV`) es siempre explícito. Nunca se infiere de `Host`,
del access token, de `live_mode`, ni de la rama Git. Si `resolveConfig()`
no puede construir una configuración completa y válida, el handler
responde fail-closed (503) sin asumir ningún valor por defecto.

## Matriz de variables

| Variable | Preview (valor actual) | Production (valor actual — checkout sigue apagado) | Tipo | Obligatoria | Si falta o es inválida | Quién la configura |
|---|---|---|---|---|---|---|
| `APP_ENV` | `preview` | `production` | var (`wrangler.toml`) | Sí | 503 en todos los endpoints de pagos/pedidos | Repo — `wrangler.toml` |
| `MP_COLLECTOR_ID` | `3559407834` (collector de la cuenta TEST) | `440298103` — **confirmado en 2-N-G2**. No confundir con el número de aplicación de Mercado Pago (`6816864196905927`), que es solo informativo y no se usa en runtime | var | Sí | 503 fail-closed | Repo — `wrangler.toml` |
| `CHECKOUT_ENABLED` | `"true"` | `"false"` | var | No (ausente = deshabilitado) | `POST /api/orders` y `POST /api/preferences` responden `503 checkout_temporarily_unavailable`; webhook, `/api/orders/status` y `/pedido` siguen funcionando | Repo — `wrangler.toml` |
| `PUBLIC_CHECKOUT_ENABLED` | Según build de Preview | `"false"` | variable de build pública | Sí para mostrar el checkout | Los botones y el flujo de pago online no se renderizan | Workflow de build/deploy |
| `PUBLIC_TURNSTILE_SITE_KEY` | **Pendiente.** No hay un workflow de GitHub efectivo identificado que construya el Preview con checkout — ver "Pendientes" | `0x4AAAAAAD_Ul8KGae_hdWwj` (inyectada en `deploy.yml`, no es secreta) | variable de build pública | Sí para cargar el widget | El script de `carrito.astro` nunca carga Turnstile ni permite preparar el pago (falla cerrado) | Workflow de build/deploy |
| `PUBLIC_TURNSTILE_ALLOWED_HOSTS` | **Pendiente**, mismo motivo que la fila anterior | `amadolibros.com,www.amadolibros.com` | variable de build pública | Sí para cargar el widget | Mismo fail-closed que la site key ausente | Workflow de build/deploy |
| `CANONICAL_ORIGIN` | `https://feature-2-n-e1-production-re.amadolibros-web.pages.dev` (alias truncado por Cloudflare Pages — el nombre completo de la rama no entra en el límite de un label DNS) | `https://www.amadolibros.com` | var | Sí | 503 fail-closed | Repo — `wrangler.toml` |
| `ALLOWED_HOSTS` | No aplica — Preview usa una validación estructural (ver abajo), no una lista | `amadolibros.com,www.amadolibros.com` | var | Sí en Production | 503 fail-closed en Production | Repo — `wrangler.toml` (bloque `env.production`) |
| `MP_ACCESS_TOKEN` | Token TEST de la app MP | **Presente por nombre** en Cloudflare Pages Production (confirmado en auditoría 2-N-G1); su valor no fue leído ni validado en 2-N-G2 | secret | Sí | `503 MP_NOT_CONFIGURED` (preferencias) / `503` sin cuerpo (webhook) | Dashboard de Cloudflare Pages — nunca en el repo |
| `MP_WEBHOOK_SECRET` | Secret del webhook configurado para la URL de Preview | **Presente por nombre** en Cloudflare Pages Production (confirmado en auditoría 2-N-G1); su valor no fue leído ni validado en 2-N-G2 | secret | Sí | `503` sin cuerpo | Dashboard de Cloudflare Pages |
| `TURNSTILE_SECRET_KEY` | Secret del widget `amadolibros-orders-preview` | Secret del widget Production — **ya cargado manualmente en el dashboard de Cloudflare Pages** (2-N-G2); su valor nunca se lee, imprime ni versiona desde este repo | secret | Sí | `503 TS_NOT_CONFIGURED` — bloquea la creación de pedidos, Turnstile nunca se desactiva silenciosamente | Dashboard de Cloudflare Pages |
| `ORDERS_DB` (binding D1) | `amadolibros-orders-preview` | `amadolibros-orders-production` | binding D1 | Sí | `503` sin fallback a Preview, memoria u otra base | `wrangler.toml` |

## Origen canónico vs. hosts aceptados

Son dos conceptos deliberadamente separados:

- **Hosts aceptados** (`isAllowedRequestHost`): determinan si una solicitud
  entrante puede procesarse. En Preview es una validación **estructural**
  por labels del hostname (`<algo>.amadolibros-web.pages.dev`, exactamente
  4 labels) — no una lista, porque Cloudflare Pages genera un subdominio
  nuevo en cada deploy. En Production es una lista exacta (`ALLOWED_HOSTS`).
  Ningún caso usa `includes()`/`endsWith()` sobre el string completo del
  host; se compara contra el hostname ya parseado por `URL`.
- **Origen canónico** (`CANONICAL_ORIGIN`): el único origen usado para
  construir `notification_url` y las tres `back_urls`. Nunca se deriva de
  `Host`, `Origin`, `Referer` ni `X-Forwarded-Host` — eso lo cubren los
  tests `url-1`/`url-2`/`url-3` en `preferences.test.js`. En Production,
  aunque se acepten tanto `amadolibros.com` como `www.amadolibros.com`
  como hosts válidos, las URLs generadas siempre usan el mismo origen
  canónico configurado.

## D1 por ambiente

- Preview: `amadolibros-orders-preview` (`database_id`
  `6fa387af-f29e-46dc-97e5-30298568b4a6`), bindeada únicamente bajo
  `env.preview.d1_databases` en `wrangler.toml`.
- Production: `amadolibros-orders-production` (`database_id`
  `6dc8dc3a-2d4f-4045-b428-14323c7b0bcd`), bindeada únicamente bajo
  `env.production.d1_databases`.
- Las bases tienen identificadores distintos. Si `ORDERS_DB` está ausente,
  el handler responde `503` sin fallback a Preview, memoria u otra base.

## Turnstile por ambiente

Hay dos mitades independientes, backend y frontend, ambas fail-closed:

- **Backend** (`verifyTurnstile()` en `_turnstile.js`, vía
  `resolveConfig()`): valida el token contra el hostname esperado del
  ambiente. Preview usa el widget `amadolibros-orders-preview` (modo
  `managed`, dominio `amadolibros-web.pages.dev`) con su
  `TURNSTILE_SECRET_KEY` propio. Production usa su propio widget
  (dominio `amadolibros.com`/`www.amadolibros.com`); su
  `TURNSTILE_SECRET_KEY` ya está cargado en el dashboard de Cloudflare
  Pages (2-N-G2) — su valor no vive ni se lee desde este repo. Si falta
  la configuración de cualquiera de los dos lados, la verificación falla
  cerrada (bloquea la creación de pedidos) en vez de aceptar cualquier
  hostname.
- **Frontend** (`carrito.astro`, desde 2-N-G2): la site key pública y los
  hosts permitidos para cargar el widget ya no están hardcodeados ni se
  infieren del hostname del navegador — se inyectan en build time vía
  `PUBLIC_TURNSTILE_SITE_KEY`/`PUBLIC_TURNSTILE_ALLOWED_HOSTS` (ver
  matriz arriba). El matching de hosts es por labels completos, nunca
  por substring (`evil-amadolibros.com` o `amadolibros.com.evil.example`
  nunca matchean `amadolibros.com`); está probado en
  `astro-front/src/lib/__tests__/turnstile-hosts.test.js`. Si el checkout
  está habilitado pero la site key falta o el host actual no está en la
  lista, el widget nunca se carga y "Preparar pago online" muestra un
  error controlado en vez de mandar la request sin verificación.
  **Solo Production tiene esta configuración conectada a un workflow real
  (`deploy.yml`).** Para Preview la mecánica está lista en el código
  (`carrito.astro` acepta las mismas variables) pero **no hay ningún
  workflow de GitHub identificado como efectivo** para construir un
  Preview con checkout — ver "Pendientes" más abajo. No se afirma que
  Preview quede configurado por este lote.

## Collector por ambiente

`MP_COLLECTOR_ID` ya no es una constante hardcodeada en el código
(`_mp_client.js` ya no exporta `MP_COLLECTOR_ID`) — se lee de config,
validado como identificador decimal. `live_mode` dejó de ser un gate (ver
2-N-D2/fix `6e3e181`): ahora es diagnóstico, y el valor esperado también
depende del ambiente (`false` en Preview, `true` en Production). Un
mismatch solo genera un `console.warn` con `payment_id`, `app_env`,
`expected` y `observed` — nunca token, firma completa, payload completo
ni datos personales.

## Kill switch (`CHECKOUT_ENABLED`)

Autoridad exclusiva del backend. Con cualquier valor distinto del string
exacto `"true"` (ausente, `"false"`, `"TRUE"`, etc.):

- `POST /api/orders` y `POST /api/preferences` responden `503
  checkout_temporarily_unavailable` con `Cache-Control: no-store`, sin
  llamar a Mercado Pago ni escribir en D1.
- El webhook, `/api/orders/status`, `/pedido` y la idempotencia de pagos
  ya iniciados siguen funcionando normalmente — el kill switch nunca
  interrumpe la confirmación de un pago que ya se iba a procesar.

Es una variable normal de Cloudflare Pages: cambiarla puede requerir un
nuevo deployment para tomar efecto. En esta etapa funciona como *release
gate* (decisión tomada antes de desplegar), no necesariamente como un
apagado instantáneo en caliente.

## `sandbox_init_point` vs. `init_point`

- Preview usa exclusivamente `sandbox_init_point` (validado contra
  `sandbox.mercadopago.com`/`.com.uy`).
- Production usa exclusivamente `init_point` (validado contra
  `www.mercadopago.com`/`.com.uy`).
- Nunca hay fallback cruzado: si falta el campo correspondiente al
  ambiente actual, `_mp_client.js` devuelve un error controlado
  (`MP_API_ERROR`), nunca usa el campo del otro ambiente.
- El campo devuelto al frontend se unificó a `checkout_url` (antes
  `sandbox_init_point` siempre, sin importar el ambiente).

## `notification_url` y `back_urls`

Se construyen exclusivamente desde `CANONICAL_ORIGIN` + rutas fijas:

- `notification_url`: `<CANONICAL_ORIGIN>/api/webhooks/mercadopago`
- `back_urls.success`: `<CANONICAL_ORIGIN>/pedido/?result=success&code=<public_code>`
- `back_urls.pending`: `<CANONICAL_ORIGIN>/pedido/?result=pending&code=<public_code>`
- `back_urls.failure`: `<CANONICAL_ORIGIN>/pedido/?result=failure&code=<public_code>`

Las back_urls **nunca** confirman un pago — son solo el destino del
redirect del navegador. `/pedido` sigue mostrando "Pago confirmado" única
y exclusivamente en base al estado que devuelve `POST
/api/orders/status`, que a su vez lee D1.

## Pendientes antes de activar cobros LIVE

1. **`CANONICAL_ORIGIN` de Preview es project-wide, no por rama.**
   `env.preview.vars` de Cloudflare Pages aplica a *todos* los preview
   deployments del proyecto, no solo a esta rama. Quedó fijado al alias
   de `feature-2-n-e1-production-re` (Cloudflare trunca el alias cuando el
   nombre de rama excede el límite de un label DNS) porque es lo que se está
   validando ahora mismo; cualquier otra rama de preview que intente usar
   checkout va a generar `notification_url`/`back_urls` apuntando a esta
   rama hasta que se resuelva el alcance (por rama, o con otra estrategia).
2. **`MP_ACCESS_TOKEN` y `MP_WEBHOOK_SECRET` de Production están presentes
   por nombre** en el dashboard de Cloudflare Pages (confirmado en la
   auditoría 2-N-G1), y `MP_COLLECTOR_ID` (`440298103`) está confirmado y
   cargado (2-N-G2). Lo que falta es **validar funcionalmente** esas dos
   credenciales (que el token sea válido, que el secret del webhook sea
   el correcto) — ese valor no se lee, no se prueba ni se modifica desde
   este repo ni en este lote.
3. **No existe actualmente un workflow de GitHub identificado como
   efectivo para desplegar un Preview con el checkout de Mercado Pago.**
   `deploy-preview.yml` sigue exactamente como en `origin/main` (trigger
   limitado a la rama `astro-migration`, que no tiene código de pagos) —
   2-N-G2 no lo modificó. La configuración pública de Turnstile para
   Preview (`PUBLIC_TURNSTILE_SITE_KEY`/`PUBLIC_TURNSTILE_ALLOWED_HOSTS`
   con los valores `0x4AAAAAAD6E9kz8K3comwjj` /
   `amadolibros-web.pages.dev,.amadolibros-web.pages.dev`) queda
   documentada acá como pendiente de conectar el día que se identifique o
   cree el pipeline efectivo — no se afirma que Preview haya quedado
   configurado por este lote.
4. **La activación exige varias llaves explícitas, no solo una.** El
   backend requiere `CHECKOUT_ENABLED="true"`, el frontend debe
   compilarse con `PUBLIC_CHECKOUT_ENABLED="true"`, y además necesita
   `PUBLIC_TURNSTILE_SITE_KEY`/`PUBLIC_TURNSTILE_ALLOWED_HOSTS` válidos
   para el host que sirve la página — si falta cualquiera de estas
   últimas dos, el checkout no se oculta pero el pago queda bloqueado
   igual (fail-closed) hasta que se corrija. Mientras `CHECKOUT_ENABLED`
   o `PUBLIC_CHECKOUT_ENABLED` permanezcan apagadas, no se ofrece el
   flujo de cobro en absoluto.
