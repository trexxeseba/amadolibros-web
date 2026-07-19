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

## Referencias internas

- Endpoint: `POST /api/orders` → `functions/api/orders.js`.
- Handler con inyección de dependencias: `functions/api/_orders_handler.js`.
- Validación y reglas comerciales: `functions/api/_orders_logic.js`.
- Tests: `functions/api/__tests__/orders.test.js`.
- Migración: `migrations/0001_orders.sql`.

## Reglas que la base refuerza

- moneda `UYU`;
- retiro con envío cero;
- envío con descuento de retiro cero;
- costo de envío solamente `0` o `250`;
- total pagable consistente con subtotal, retiro y envío;
- campos de entrega obligatorios para `shipping`;
- un producto por orden después de consolidar cantidades;
- claves foráneas para ítems y eventos.
