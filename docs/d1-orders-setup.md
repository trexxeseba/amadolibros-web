# Configuración D1 — amadolibros-orders

Pasos a ejecutar **cuando el usuario autorice** crear el recurso remoto.
**No ejecutar sin autorización explícita.**

## 1. Crear la base de datos D1

```bash
wrangler d1 create amadolibros-orders
```

El comando imprime el `database_id` real. Guardarlo para el paso 3.

## 2. Aplicar la migración

### Local (para desarrollo con `wrangler pages dev`)

```bash
wrangler d1 execute ORDERS_DB --local --file migrations/0001_orders.sql
```

### Remoto (producción)

```bash
wrangler d1 execute ORDERS_DB --remote --file migrations/0001_orders.sql
```

## 3. Agregar binding en wrangler.toml

Una vez creada la base, agregar este bloque **al final** de `wrangler.toml`
reemplazando `<DATABASE_ID_REAL>` con el ID obtenido en el paso 1:

```toml
[[d1_databases]]
binding = "ORDERS_DB"
database_name = "amadolibros-orders"
database_id = "<DATABASE_ID_REAL>"
```

## Referencias

- Base prevista: `amadolibros-orders`
- Binding en código: `ORDERS_DB`
- Migración: `migrations/0001_orders.sql`
- Endpoint: `POST /api/orders` → `functions/api/orders.js`
- Handler (testeable con DI): `functions/api/_orders_handler.js`
- Lógica pura: `functions/api/_orders_logic.js`
