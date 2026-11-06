# Diagnóstico: motor local de precios de Amado Libros (06/11/2026)

Separado en hechos comprobados (con la fuente que lo prueba), hipótesis y bloqueos.
Sin montos ni IDs de venta: el repo es público. Los números por publicación quedan en
la PC (`precios-libros-local/datos/`).

## 1. Hechos comprobados

### Ya hay un motor de precios escribiendo en Amado Libros

| Hecho | Prueba |
| --- | --- |
| **Precio Ganador** cambia precios de Amado Libros en modo real, tres veces por día (09:00, 15:00 y 21:00 de Montevideo), desde GitHub Actions. | `precio-ganador/modo.json` (`"libros": "real"`), `.github/workflows/precio-ganador.yml`, corridas de Actions del 05 y 06/11 (`schedule` y `workflow_dispatch`, la mayoría `success`) |
| Su regla es otra: baja al `price_to_win` si la diferencia es menor a 360, con tope del 30 %, sin el 1 % adicional. | `precio-ganador/src/config.mjs` (`umbral: 360`, `topePct: 0.30`), `decision.mjs` |
| Corre sin piso por costo para Libros: `pisos/libros.json` está vacío y `minimo` es null. | `precio-ganador/pisos/libros.json` (0 entradas), `config.mjs` |
| Lo dispara también el Worker de producción (cron de Cloudflare). | `worker-sync/precio-ganador-trigger.js`, importado en `worker-sync/index.js` |
| Guarda su estado (precio original y aplicado por publicación) y los reportes **en la rama pública** `estado/precio-ganador`. | `git ls-tree origin/estado/precio-ganador`: `state/libros.json`, `ultima/libros-filas.json`, `ultima/libros-detalle.md` |
| Hoy gestiona 30 publicaciones de Libros. | `state/libros.json` de esa rama |

**Consecuencia:** si el motor local y Precio Ganador corren a la vez sobre las mismas
publicaciones, se pisan. El motor local vería el precio que puso Precio Ganador como
"cambio externo" y detendría esas publicaciones, y Precio Ganador haría lo mismo con
las del motor local (su regla `liberar_editada`). Ver la decisión 1 al final.

### Resultados de llamadas reales (las hizo Precio Ganador en producción, 06/11/2026 18:04 UTC)

Fuente: `ultima/libros-resumen.json` y `ultima/libros-muestras-api.json` de la rama de estado.

| Dato | Valor |
| --- | ---: |
| Publicaciones activas revisadas | 6.897 |
| `price_to_win` respondió para todas | 7.378 de 7.381 llamadas con 200; 3 con 429 |
| `competing` (compiten y pierden) | 50 |
| `winning` | 2.964 |
| `sharing_first_place` | 61 |
| `not_listed`, motivo `item_not_opted_in` | 3.822 |
| Con precio administrado por ML (`dynamic_standard_price`) | 1 |

- `GET /items/{id}/price_to_win?version=v2` devuelve `status`, `price_to_win`,
  `winner.item_id`, `winner.price`, `boosts`, `reason`, `catalog_product_id`.
- `GET /products/{id}/items` responde con `results[].item_id/price/seller_id` y `paging`.
- `GET /seller-promotions/items/{id}?app_version=v2` responde con la lista de promociones
  de la publicación (`DEAL`, `PRICE_DISCOUNT`, `SELLER_COUPON_CAMPAIGN`, estado `candidate`
  en la muestra), con `start_date`/`finish_date`.
- `PUT /items/{id}` con `{price}` funciona en MLU: 19 cambios verificados en esa corrida, 0 errores.
- El README de Precio Ganador documenta que `/suggestions/items/{id}/details` respondió
  404 para toda la cuenta. No lo verifiqué yo: está en su README, no en una muestra guardada.

### Estimación con datos reales de esa corrida (aproximada)

Aplicando la regla nueva a las 50 marcadas, con `C = price_to_win` (el ganador) y el precio
original como base:

| Resultado | Publicaciones |
| --- | ---: |
| D >= 400: no tocar | 31 |
| 0 < D < 400: bajar al 99 % | 18 |
| Bloqueada por el límite acumulado propuesto (20 % y 500) | 1 |
| Descuento total mayor a 400 por el 1 % adicional | 1 |
| Entra con el umbral de 400 y no con el de 360 | 1 |

Con el piso como está hoy (sin costos cargados) las 19 quedarían en `omitir_sin_piso`.

### Autenticación

| Hecho | Prueba |
| --- | --- |
| `meli-auth.js` es el único gestor: guarda el par en D1 `ml_oauth`, usa `expires_in` de la respuesta, lock en D1 con `UPDATE ... RETURNING` y reemplazo del refresh token con compare-and-swap. | `worker-sync/meli-auth.js`, `worker-sync/__tests__/meli-auth.test.js` |
| Precio Ganador lee el access token directo de D1 con la API de Cloudflare (secretos de Actions). No renueva. | `precio-ganador/src/token.mjs` |
| No había una ruta del Worker que entregara sólo el access token. | `worker-sync/index.js` |

### Trabajo previo

- **PR #529 `agent/meli-promos`** (abierto): auditar promociones, sacar las que pasan el
  tope (16 %) y sumar a la relámpago, vía Worker con `SYNC_SECRET`. No toca precios. Se
  reutiliza su criterio de estados (`started` = activa, `pending` = programada).
- **Rama `agent/ledger`**: diagnóstico de permisos de plata ML/MP (`money-probe.js`) y una
  versión vieja de Precio Ganador. No hay nada de precios que no esté ya en `main`.
- **PR #541 `agent/precios-amado`** (abierto): competencia y alertas, sólo lectura.
- **PR #402 `agent/price-watch-fase0`** (borrador): diagnóstico de la API, sólo lectura.

### Red de esta sesión

Desde el contenedor de la sesión, `api.mercadolibre.com` está bloqueado (el proxy responde
403 al CONNECT). La documentación oficial (`developers.mercadolibre.com.ar`) tampoco
resolvió. Las llamadas reales tienen que salir de la PC (`src/sonda.mjs`).

## 2. Validación contra la documentación (parcial)

Sólo se pudieron leer fragmentos de las páginas oficiales en un buscador, no las páginas
completas.

| Ruta | Documentada | Notas |
| --- | --- | --- |
| `GET /items/{id}/prices` | sí | precios `standard` y `promotion` con `conditions.start_time/end_time` (sólo con token del dueño) |
| `GET /items/{id}/sale_price?context=channel_marketplace` | sí | `amount`, `regular_amount`, `metadata` si hay promo |
| `GET /items/{id}/price_to_win?version=v2` | sí | además comprobada en producción |
| `GET /suggestions/user/{id}/items`, `/suggestions/items/{id}/details` | sí | MLU no figura en la lista de países encontrada |
| `GET /pricing-automation/items/{id}/rules` y `/automation` | sí | desde el 18/03/2026 un PUT de precio sobre un ítem automatizado se rechaza; si el PUT trae otros campos, ignora el precio sin error |
| `GET /pricing-automation/users/{id}/items` | sí | pagina con `offset` y `limit` |
| `GET /seller-promotions/items/{id}` | parcial | comprobada en producción; `pending` = aprobada que todavía no empezó |
| `GET /products/{id}/items` | no encontrada | comprobada en producción |
| `PUT /items/{id}` `{price}` | sí | comprobada en producción |

## 3. Hipótesis (sin comprobar)

- Las 3.822 `not_listed / item_not_opted_in` no tienen competidor comparable confirmado por
  API. Que no estén en catálogo no quiere decir que sean User Products ni que no tengan
  ficha: `src/sonda.mjs` lee `user_product_id` y `catalog_product_id` de cada una.
- `ganador` y `más barata` pueden diferir: la auditoría de Precio Ganador muestra
  publicaciones que ganan con un competidor más barato en la ficha.
- `/suggestions/items/{id}/details` puede seguir dando 404 en MLU.
- Elegibilidad de automatización nativa en la cuenta: sin comprobar (necesita `sonda.mjs`).

## 4. Bloqueos

1. **Conflicto con Precio Ganador** (decisión de Seba, abajo).
2. **Sin piso confiable**: no hay costos de Libros accesibles para el motor local sin entrar a
   D1. Hasta cargar `datos/costos.csv` y `datos/piso.json`, toda baja queda en `omitir_sin_piso`.
3. **Sin llamadas reales desde la sesión** (red). Se resuelve corriendo `sonda.mjs` en la PC.
4. **Rama de estado pública**: Precio Ganador publica precios e IDs en `estado/precio-ganador`,
   en contra de la regla de no commitear montos.

## 5. Decisiones para Seba

1. Qué motor queda en Libros: apagar Precio Ganador en Libros (`modo.json` `"libros"` distinto
   de `"real"`) antes del piloto, o excluir del piloto las publicaciones que gestiona.
2. `C`: el más barato comparable de la ficha (por defecto) o el ganador de la ficha.
3. Si se baja también cuando ya ganamos la ficha (la regla aprobada no lo distingue).
4. Comisión, envío a cargo, cargo fijo y margen mínimo para el piso.
5. Límite acumulado: 20 % y 500 pesos sobre el precio base (15 % bloquea el ejemplo de la regla).
