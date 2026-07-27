# Ambientes — Preview y Production (2-N-E1)

Este documento describe la configuración centralizada introducida en 2-N-E1
(`functions/api/_env_config.js`). El código queda preparado para operar en
Preview y Production. Production ya tiene D1 propia y hosts declarados, pero
el checkout permanece apagado y oculto: no hay credenciales LIVE ni Turnstile
de Production configurados.

## Principio general

El ambiente (`APP_ENV`) es siempre explícito. Nunca se infiere de `Host`,
del access token, de `live_mode`, ni de la rama Git. Si `resolveConfig()`
no puede construir una configuración completa y válida, el handler
responde fail-closed (503) sin asumir ningún valor por defecto.

## Matriz de variables

| Variable | Preview (valor actual) | Production (valor propuesto, no aplicado) | Tipo | Obligatoria | Si falta o es inválida | Quién la configura |
|---|---|---|---|---|---|---|
| `APP_ENV` | `preview` | `production` | var (`wrangler.toml`) | Sí | 503 en todos los endpoints de pagos/pedidos | Repo — `wrangler.toml` |
| `MP_COLLECTOR_ID` | `3559407834` (collector de la cuenta TEST) | Collector real de la cuenta LIVE — **a confirmar empíricamente antes de 2-N-E2**, no asumir el `440298103` documentado como owner de la app | var | Sí | 503 fail-closed | Repo — `wrangler.toml` |
| `CHECKOUT_ENABLED` | `"true"` | `"false"` | var | No (ausente = deshabilitado) | `POST /api/orders` y `POST /api/preferences` responden `503 checkout_temporarily_unavailable`; webhook, `/api/orders/status` y `/pedido` siguen funcionando | Repo — `wrangler.toml` |
| `PUBLIC_CHECKOUT_ENABLED` | Según build de Preview | `"false"` | variable de build pública | Sí para mostrar el checkout | Los botones y el flujo de pago online no se renderizan | Workflow de build/deploy |
| `CANONICAL_ORIGIN` | `https://feature-2-n-e1-production-re.amadolibros-web.pages.dev` (alias truncado por Cloudflare Pages — el nombre completo de la rama no entra en el límite de un label DNS) | `https://www.amadolibros.com` (propuesto) | var | Sí | 503 fail-closed | Repo — `wrangler.toml` |
| `ALLOWED_HOSTS` | No aplica — Preview usa una validación estructural (ver abajo), no una lista | `amadolibros.com,www.amadolibros.com` (propuesto) | var | Sí en Production | 503 fail-closed en Production | Repo — `wrangler.toml` (bloque `env.production`, a crear en 2-N-E2) |
| `MP_ACCESS_TOKEN` | Token TEST de la app MP | Token LIVE — **no cargar en este lote** | secret | Sí | `503 MP_NOT_CONFIGURED` (preferencias) / `503` sin cuerpo (webhook) | Dashboard de Cloudflare Pages — nunca en el repo |
| `MP_WEBHOOK_SECRET` | Secret del webhook configurado para la URL de Preview | Secret del webhook Production — requiere su propia entrada en el panel de MP | secret | Sí | `503` sin cuerpo | Dashboard de Cloudflare Pages |
| `TURNSTILE_SECRET_KEY` | Secret del widget `amadolibros-orders-preview` | Secret de un widget Production **todavía no creado** | secret | Sí | `503 TS_NOT_CONFIGURED` — bloquea la creación de pedidos, Turnstile nunca se desactiva silenciosamente | Dashboard de Cloudflare Pages |
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

- Preview: widget `amadolibros-orders-preview` (modo `managed`, dominio
  `amadolibros-web.pages.dev`), secret en `TURNSTILE_SECRET_KEY` de
  Preview únicamente.
- Production: **sin crear todavía**. Va a necesitar su propio widget
  (dominio `amadolibros.com`/`www.amadolibros.com`) y su propio secret.
  El hostname esperado por `verifyTurnstile()` ya no tiene un valor por
  defecto hardcodeado — se toma de `resolveConfig()`, así que si falta la
  configuración, la verificación falla cerrada (bloquea la creación de
  pedidos) en vez de aceptar cualquier hostname.

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
2. **`MP_COLLECTOR_ID` de Production no está confirmado.** El valor
   documentado como owner de la app (`440298103`) no debe asumirse como el
   collector real de pagos LIVE sin verificarlo empíricamente, tal como se
   tuvo que corregir para el collector de TEST en el fix de `live_mode`
   (commit `6e3e181`).
3. **Faltan el widget/secret de Turnstile y las credenciales LIVE de
   Production.** No se crean ni cargan en este lote.
4. **La activación exige dos llaves explícitas.** El backend requiere
   `CHECKOUT_ENABLED="true"` y el frontend debe compilarse con
   `PUBLIC_CHECKOUT_ENABLED="true"`. Mientras cualquiera permanezca apagada,
   no se ofrece el flujo de cobro.
