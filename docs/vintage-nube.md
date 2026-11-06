# Publicador de Amado Vintage en la nube

Reemplaza a la PC (`scripts/vintage_autorun.py` + tarea `AmadoVintagePublisher`). Publica
**sólo en Amado Vintage (seller 2341378249)**, nunca en Amado Libros (440298103).

- Workflow: **Vintage publicador (nube)** (`.github/workflows/vintage-nube.yml`).
- Código: `scripts/vintage-cloud/run.mjs`. Usa el mismo motor que la PC
  (`scripts/vintage-local/engine.mjs`, `renew.mjs`, `stock-sync.mjs`), así que las mismas
  guardas siguen valiendo: reserva por ISBN en D1, lectura de cada alta, piso de precio,
  18 días de disponibilidad, una creación por vez.

## Qué dependía de la PC y dónde quedó

| Antes (PC) | Ahora (nube) |
| --- | --- |
| Usuario y clave de SBS en `private/sbs.json` | Secretos de GitHub `SBS_EMAIL` y `SBS_PASSWORD`. El portal de SBS responde desde GitHub (probado el 05/11/2026: login 200). |
| `VINTAGE_RENEW_SECRET` en `private/renew-secret.txt` | Ya no hace falta: cada corrida genera una clave al azar, guarda su hash en D1 (`ml_vintage_cloud_keys`, vence en 4 h) y la borra al terminar (`scripts/vintage-cloud/key.mjs`). El sitio la acepta igual que el secreto. Quien puede escribir en D1 ya tiene los tokens de Mercado Libre, así que no abre nada nuevo. |
| Token de Mercado Libre pedido por la PC | Lo sigue renovando Cloudflare (`functions/_shared/meli-vintage-token.js`). La acción nueva `keepalive` de `/operations/vintage-renew` lo rota si le quedan menos de 3 horas; el workflow la llama cada 2 horas, aun en prueba o apagado, para que Precio Ganador lo encuentre vigente. Nunca devuelve el token. |
| SQLite local (`publisher.sqlite`) | Se arma de cero en cada corrida con lo que devuelve el servidor (recibos, inventario, identificadores). La reserva por ISBN ya estaba en D1. El estado de pausas (qué pausamos nosotros y desde cuándo falta un libro) se guarda en D1, tabla `ml_vintage_cloud_stock_sync`. |
| Proceso largo con la PC despierta | Corridas cortas cada 2 horas (`37 1-23/2 * * *`, hora UTC), con tope de minutos. |
| Tarea programada y vigía de Windows | GitHub Actions. Con `"ejecutor": "nube"` la PC queda en espera sola: no renueva, no sincroniza, no publica. |

Las altas que quedaron dudosas en otra corrida se reconcilian por SKU como siempre. Como no
se sabe qué precio se envió (y Precio Ganador puede haberlo cambiado), en ese caso se verifica
la identidad del alta (vendedor, ISBN, moneda, piso de 1.200, 18 días) y no el precio exacto.

## Llaves (`scripts/vintage-local/campaign.json`)

```json
{
  "target_total": 80000,
  "ejecutor": "nube",
  "nube": { "modo": "real", "tanda": 1000, "tope_diario": 8000, "minutos": 50, "intervalo_ms": 250, "clasificadores": 4 }
}
```

- `ejecutor`: `pc` o `nube`. Decide quién publica; nunca los dos a la vez.
- `nube.modo`: `prueba` (default), `real` o `apagado`.
- Publica de verdad **sólo** con `"ejecutor": "nube"` y `"modo": "real"` a la vez.
- `tanda`: altas máximas por corrida (tope duro 1.000). `tope_diario`: altas por día de
  Montevideo, contando todas las del día (tope duro 10.000, el mismo del servidor). `minutos`: tiempo máximo del motor.
- `target_total`: meta total de la campaña, igual que en la PC.

Para correr a mano: Actions, **Vintage publicador (nube)**, *Run workflow*:

| Acción | Qué hace | ¿Toca Mercado Libre? |
| --- | --- | --- |
| `numeros` | Baja la lista de SBS, la carga en D1 y cuenta: con stock, publicados, candidatos, precios. | No |
| `prueba` | `numeros` + qué pausaría o reactivaría + 5 altas preparadas con título y precio. | Sólo lecturas (GET). Nunca `POST /items`. |
| `clasificar` | Revisa candidatos en paralelo (`nube.clasificar`: 4 a la vez, una consulta cada 0,25 s) y los deja validados, con la publicación preparada, o descartados con su motivo. Sirve para medir y deja trabajo hecho para la próxima publicación. | Sólo lecturas. Nunca `POST /items` ni reservas. |
| `publicar` | Pausa lo agotado, reactiva lo que volvió y publica una tanda. Con `nube.clasificadores` mayor a 0, los clasificadores trabajan al lado y el publicador toma primero los validados. | Sí. Exige las dos llaves. |
| `keepalive` | Sólo mantiene vigente el token. | Sólo la renovación del token |

El resultado queda en el resumen de la corrida y en el artefacto `vintage-nube-<id>`
(`reporte.md` y `reporte.json`, sin claves ni tokens).

## Clasificador

El publicador revisaba un candidato por vez y 4 de cada 5 se descartan (categoría que no es libro,
ISBN distinto, sin ficha, stock dudoso). El clasificador (`classify` en
`worker-sync/publication-engine.js`) hace los mismos controles que el publicador hasta preparar la
publicación, en paralelo y sin reservar ni crear. El publicador toma primero los `validated`; si el
precio no cambió reusa lo preparado y sólo vuelve a mirar el SKU, reserva el ISBN en el servidor y
crea. Las altas siguen saliendo de a una: el riesgo de duplicar no cambia. El clasificador escribe
sólo si el trabajo sigue pendiente y el publicador no toma un candidato que se esté clasificando.

## Avisos por mail

Después de cada corrida, `scripts/vintage-cloud/aviso.mjs` manda (con Resend, al mismo destinatario
que Precio Ganador):

- **Cierre del día**: la primera corrida después de la medianoche de Montevideo avisa cuántas altas
  hubo el día anterior y el total de la campaña. Una vez por día.
- **Alarma**: si la corrida falló, o si publicó 0 sin haber llegado al tope diario. Como mucho una
  cada 3 horas por motivo.

Lo avisado queda en D1 (`ml_vintage_cloud_alerts`).

## Convivencia con Precio Ganador

Precio Ganador (`precio-ganador/`) maneja los precios de Vintage tres veces por día. El
publicador de la nube **no toca precios**: la sincronización corre en modo `stock_only`
(pausa y reactiva, nunca cambia un precio) y no hay pasada de corrección. El precio de
cada alta nueva sale de la política aprobada, como en la PC; después lo maneja Precio Ganador.
Si Precio Ganador está corriendo cuando toca publicar, esa vuelta sólo cuida el token.

## Secretos en GitHub

Sólo dos, los del portal de SBS. Se cargan en
https://github.com/trexxeseba/amadolibros-web/settings/secrets/actions/new, uno por vez:

1. Name `SBS_EMAIL`, Secret: el usuario de ag.sbs.com.ar (el de `private\sbs.json` en la PC).
2. Name `SBS_PASSWORD`, Secret: su clave.

Los de Cloudflare ya estaban. Sin los de SBS, el workflow igual mantiene vivo el token de Vintage.

## Cómo se prende, paso a paso

1. Seba carga los dos secretos de SBS.
2. Corrida `prueba` a mano: se revisan los números y las 5 altas de muestra.
3. Con el OK de Seba: `"ejecutor": "nube"` y `"modo": "real"` en `campaign.json`, mergear.
   Desde ahí cada 2 horas publica una tanda, con el tope diario. La PC, si está prendida,
   toma el cambio con su `git pull` y queda en espera.
4. Con unos días andando: desinstalar la tarea de Windows (`schtasks /Delete /TN AmadoVintagePublisher /F`).

Para frenar: `"modo": "apagado"` (o `"prueba"`), o desactivar el workflow en Actions.
Para volver a la PC: `"ejecutor": "pc"`.
