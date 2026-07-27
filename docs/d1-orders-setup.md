# Configuración D1 — órdenes de Amado Libros

Estos pasos se ejecutan por ambiente. **No crear ni conectar recursos remotos sin autorización explícita.**

## Separación obligatoria de ambientes

- Local: base efímera de Wrangler para desarrollo y pruebas.
- Preview: base D1 remota exclusiva de previews.
- Producción: base D1 remota exclusiva de producción.

Preview y producción no deben compartir `database_id`. Un preview nunca debe escribir en la base productiva.

## 1. Prueba local sin crear D1 remoto

Para probar la migración localmente, se puede usar temporalmente este binding en un archivo de configuración local no commiteado:

```toml
[[d1_databases]]
binding = "ORDERS_DB"
database_name = "amadolibros-orders-local"
database_id = "00000000-0000-0000-0000-000000000000"
```

Aplicar las migraciones en local:

```bash
npx wrangler d1 migrations apply ORDERS_DB --local
```

Comprobar tablas y restricciones:

```bash
npx wrangler d1 execute ORDERS_DB --local --command "PRAGMA foreign_keys; SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name;"
```

La migración inicial es `migrations/0001_orders.sql`.

## 2. Crear D1 de preview — solo con autorización

```bash
npx wrangler d1 create amadolibros-orders-preview
```

Guardar el `database_id` resultante únicamente en la configuración de preview de Cloudflare Pages. Después aplicar:

```bash
npx wrangler d1 migrations apply amadolibros-orders-preview --remote
```

Antes de usarlo, verificar que el binding `ORDERS_DB` del ambiente Preview apunta a `amadolibros-orders-preview`.

## 3. Crear D1 de producción — autorización separada

```bash
npx wrangler d1 create amadolibros-orders-production
```

Guardar ese `database_id` únicamente en Production. Después aplicar:

```bash
npx wrangler d1 migrations apply amadolibros-orders-production --remote
```

No reutilizar el ID de preview.

## 4. Binding esperado

El código espera este nombre exacto:

```toml
[[d1_databases]]
binding = "ORDERS_DB"
database_name = "<NOMBRE_DEL_AMBIENTE>"
database_id = "<DATABASE_ID_REAL_DEL_AMBIENTE>"
```

## 5. Cloudflare Turnstile — protección Preview

`POST /api/orders` requiere verificación Turnstile **solo en el ambiente Preview**. En Producción la variable no está definida y el endpoint no existe.

### Recursos creados

- Widget: `amadolibros-orders-preview` (mode `managed`, domain `amadolibros-web.pages.dev`).
- Secret almacenado como variable de entorno de Pages: `TURNSTILE_SECRET_KEY` (ambiente Preview únicamente, nunca en Production).

### Comportamiento fail-closed

Si `ORDERS_DB` está presente pero `TURNSTILE_SECRET_KEY` no → 503 `TS_NOT_CONFIGURED`.
Si ambas están presentes → el token del cliente se valida contra siteverify antes de tocar D1.

### Crear/reutilizar el widget (requiere scope `challenge-widgets.write`)

```bash
# Verificar si existe
npx wrangler@latest turnstile widget list

# Crear (si no existe)
npx wrangler@latest turnstile widget create "amadolibros-orders-preview" \
  --domain amadolibros-web.pages.dev \
  --mode managed \
  --json
```

El comando muestra el `sitekey` (público) y el `secret`. El `sitekey` se escribe en `carrito.astro` como valor de `TS_SITE_KEY`. El `secret` se almacena via:

```bash
echo "<SECRET>" | npx wrangler pages secret put TURNSTILE_SECRET_KEY \
  --project-name amadolibros-web \
  --env preview
```

**El secret nunca se escribe en archivos del repositorio ni se incluye en commits.**

### Validaciones que realiza el servidor

- Token no vacío y longitud ≤ 2048 caracteres.
- `siteverify` con timeout de 5 s (`AbortController`).
- `action === 'prepare_order'`.
- `hostname` es `amadolibros-web.pages.dev` o subdomain (cubre hashes de commit y alias de rama).

## 6. Mercado Pago Checkout Pro — Preview

`POST /api/preferences` inicia un pago MP en sandbox. Solo opera en Preview; Production no tiene `MP_ACCESS_TOKEN` definida.

### App MP

- Nombre: VICTOR SEBASTIÁN
- App ID: `6816864196905927`
- User/Collector ID: `440298103`
- Sitio: `MLU` (Uruguay)
- Producto: Checkout Pro

### Activar credenciales de prueba (una sola vez, requiere login en MP)

1. Ingresar a `https://www.mercadopago.com.uy/developers/panel/app/6816864196905927`
2. En "Credenciales" → pestaña **Prueba** → clic en **Activar credenciales**
3. MP genera `TEST_PUBLIC_KEY` y `TEST_ACCESS_TOKEN`

### Guardar el secret (el valor nunca entra al repositorio)

```bash
npx wrangler@4.112.0 pages secret put MP_ACCESS_TOKEN \
  --project-name amadolibros-web \
  --env preview
# Wrangler pide el valor interactivamente. Pegar TEST_ACCESS_TOKEN.
```

### Endpoint `POST /api/preferences`

- Requiere: `{ public_code, idempotency_key }` — ambos del pedido creado por `/api/orders`
- Devuelve: `{ sandbox_init_point }` — URL de pago de MP sandbox
- Solo en hosts `*.amadolibros-web.pages.dev`
- Claim de idempotencia en D1: `creating:<epoch-seconds>:<uuid>`, TTL 30 s
- Evento D1: `preference_created` con payload `{ preference_id, environment: "test" }`
- Todos los errores tienen `Cache-Control: no-store`

### Validaciones de sandbox URL

- `protocol === 'https:'`
- `hostname === 'sandbox.mercadopago.com'` (sin `.com.uy`)
- `pathname.length > 1`

### Archivos

- `functions/api/preferences.js` — entry point
- `functions/api/_mp_handler.js` — lógica y claim
- `functions/api/_mp_client.js` — HTTP a MP, validación de respuesta
- `functions/api/__tests__/preferences.test.js` — 44 tests

## Referencias internas

- Endpoint: `POST /api/orders` → `functions/api/orders.js`.
- Handler con inyección de dependencias: `functions/api/_orders_handler.js`.
- Endpoint: `POST /api/preferences` → `functions/api/preferences.js`.
- Client MP con timeout: `functions/api/_mp_client.js`.
- Verificación Turnstile: `functions/api/_turnstile.js`.
- Validación y reglas comerciales: `functions/api/_orders_logic.js`.
- Tests: `functions/api/__tests__/orders.test.js`.
- Migración: `migrations/0001_orders.sql`.
- Carrito (frontend): `astro-front/src/pages/carrito.astro`.

## Reglas que la base refuerza

- moneda `UYU`;
- retiro con envío cero;
- envío con descuento de retiro cero;
- costo de envío solamente `0` o `250`;
- total pagable consistente con subtotal, retiro y envío;
- campos de entrega obligatorios para `shipping`;
- un producto por orden después de consolidar cantidades;
- claves foráneas para ítems y eventos.
