# Promociones de Amado Libros por API (camino de respaldo)

Sirve cuando las tareas programadas no tienen Chrome. Cuenta: **Amado Libros
(440298103)**, MLU. No publica ni cambia precios: solo lee promociones, saca
publicaciones de una promo y suma a la oferta relámpago.

## Qué token usa y qué permisos tiene

- **App:** la única que ya existe, `4741021817925208` (`APP_ID` en
  `worker-sync/wrangler.toml`). No se crea otra.
- **Dónde vive el token de Libros:** tabla D1 `ml_oauth`, que renueva el Worker con
  `worker-sync/meli-auth.js` (access token con su vencimiento real y refresh token
  rotativo). `APP_ID` y `CLIENT_SECRET` están como variables del Worker. GitHub
  Actions no tiene token de Mercado Libre: el único secreto con ese nombre,
  `MELI_TOKEN`, lo usa solo el viejo `sync-catalog.yml`. Por eso el workflow nuevo
  llama al Worker (como `mlu-atributos-auditoria.yml`) con `SYNC_SECRET`.
- **Scopes:** el repo no los guarda ni los registra. Mercado Libre decide el acceso
  a `seller-promotions` por los permisos de la aplicación y por lo que autorizó la
  cuenta. Desde acá no se puede saber sin llamar a la API, así que la acción
  `auditar` empieza por una llamada de prueba (`GET /seller-promotions/users/{id}`)
  y deja en el JSON el estado HTTP exacto.

| Resultado de `auditar` | Qué significa |
| --- | --- |
| `acceso.ok = true` | Alcanza para leer promociones. Falta comprobar el permiso de escritura: el primer `aplicar_tope` o `relampago` con confirm lo prueba. |
| `ml_status 403` (`ml_forbidden`) | El token no tiene permiso de promociones: hay que re-autorizar la misma app (abajo). |
| `ml_status 401` | El token ya no vale (`auth_invalid_grant`): re-autorizar igual. |
| Error "falta desplegar el Worker" | Este cambio todavía no está desplegado: `deploy-worker-sync`. |

### Si hace falta re-autorizar (misma app, sin crear otra)

1. En Mercado Libre Developers, aplicación `4741021817925208`: confirmar que tiene
   habilitado el permiso de promociones en lectura y escritura. No regenerar la
   clave de la app ni borrar la Redirect URI `https://www.amadolibros.com/meli-callback`.
2. Volver a autorizar la cuenta de Amado Libros con esa misma app, para que el
   refresh token nuevo incluya el permiso.
3. Cargar el refresh token nuevo en `ml_oauth` como indica
   `worker-sync/docs/publication-queue.md` (sección "Autorización de Mercado Libre").
   En el repo no hay una ruta que haga el paso 2 y 3 sola para Libros (la de
   `meli-vintage-callback` es solo de Vintage y rechaza este seller).

## Cómo se usa

Workflow **Mercado Libre — promociones (Amado Libros)** (`meli-promos.yml`, manual):

| Acción | Qué hace |
| --- | --- |
| `auditar` | Solo lectura. Lista promos activas o programadas, el % de cada publicación y las que superan el máximo (por defecto 16). |
| `aplicar_tope` | Saca de la promo a las que superan el máximo. Solo "salir de la promo". |
| `relampago` | Suma a la oferta relámpago los MLU indicados (`titulos`) si lo que ML exige como mínimo de descuento es menor o igual al máximo. Usa el precio más alto que ML acepta y nunca más alto que el actual. |

- **Dry-run por defecto.** Solo escribe con `confirm=true`, y `confirm=true` solo se
  permite corriendo desde `main`. El Worker vuelve a exigir `confirm` en cada pedido
  de escritura.
- **Resultado:** en el log (resumen del job) y en el artefacto `meli-promos-<run>`
  con `resultado.json`, que guarda por publicación el % y la decisión.

## Reglas que no se rompen

- Tope 16 %.
- Excepción de Seba del 29 al 31/10/2026 (hora de Uruguay): hasta 20 % si el
  descuento de la promo más el del cupón es de $750 o menos y el stock es 3 o más.
  Se lee el cupón de la propia API; si no se puede comprobar el monto del cupón o el
  stock, la publicación **no se quita**: queda en `revisar`.
- Nunca subir precios, pausar ni borrar publicaciones. Salir de una promo hace que
  vuelva a verse el precio de lista: es el efecto buscado, no un cambio de precio.
- No usar Amado Liquidacion 40/30/20: ni sumar ni sacar. Lo que haya ahí se reporta
  como `liquidacion_no_se_toca`.
- No tocar cupones ni publicidad: el Worker rechaza por tipo cualquier escritura sobre
  ellos.

## Supuesto a confirmar con el primer dry-run

"Promo + cupón <= $750" se calculó como la suma en pesos del descuento de la promo
(precio de lista menos precio con promo) más el monto del cupón. Los nombres exactos
de los campos de la API de promociones (por ejemplo `max_discounted_price` y
`min_stock` en relámpago, o el monto del cupón) se leyeron de la documentación y no
se pudieron probar contra Mercado Libre desde esta sesión: el primer `auditar` y el
primer `relampago` en dry-run lo confirman antes de escribir nada.
