# Motor local de precios de Amado Libros (MLU)

Baja al 99 % del competidor las publicaciones de Amado Libros (440298103) que compiten con
otro vendedor por menos de 400 pesos. Corre en la PC de Seba (Programador de tareas de
Windows), sin modelos de IA. **Hoy corre sólo en simulación**: no escribe nada en Mercado
Libre hasta el GO de Seba. Diagnóstico y decisiones pendientes: `DIAGNOSTICO.md`.

## Regla

`P` = precio efectivo actual (`sale_price`), `C` = precio del competidor externo válido, `D = P − C`.

| Caso | Qué hace |
| --- | --- |
| `0 < D < 400` | objetivo = `C × 0,99`, hacia abajo al peso |
| `D >= 400` | no toca |
| `D <= 0` | no inicia una baja |

- El umbral se mide antes del 1 %: el descuento total puede pasar de 400 (el informe lo marca).
- `C` sale siempre del competidor externo, nunca de descontar 1 % al precio propio.
- Competidor válido: otro vendedor, misma ficha de catálogo (mismo ISBN y edición), mismo
  estado (nuevo/usado), en pesos. Si el ISBN de la publicación no coincide con el de la
  ficha, o falta el estado, queda en revisión. Sin catálogo: revisión, nunca se toca sola.
- Piso rentable: `(costo puesto en UY + envío a cargo + cargo fijo) / (1 − comisión − margen)`.
  Sin piso, no se toca. Si el objetivo queda debajo del piso, se omite: no se usa otro precio.
- Límite acumulado propuesto: la rebaja contra el precio base aprobado no pasa del 20 % ni de
  500 pesos.

Se excluyen: promociones activas o programadas (`/seller-promotions`, `/items/{id}/prices`,
`sale_price`), las que no se pudieron confirmar, automatización nativa activa o sin confirmar,
precio administrado por ML, variaciones, moneda distinta de UYU, otro seller o sitio.

## Recuperación (propuesta, apagada)

Para las que el motor ya bajó (`REGLA.recuperacionHabilitada = false` hasta el GO):

- **El competidor sube**: subir hasta `min(precio base, C × 0,99)`, si el salto es de 10 pesos o más.
- **La competencia desaparece**: volver al precio base, pero sólo si dos corridas seguidas leen
  bien la ficha y no hay otro vendedor. Un error, un timeout o un dato faltante no cuentan.
- **El precio actual no es el último que puso el motor**: la publicación se detiene (cambio
  manual o de otro sistema) y no se vuelve a tocar.
- Antes de recuperar se vuelven a revisar piso, promociones y automatización.
- Guardar un precio no restaura promociones que se hayan quitado.

Mientras está apagada, el informe muestra `propuesta_recuperar` o `propuesta_recuperar_base`.

## Escrituras (sólo en modo real)

- Antes de escribir relee la publicación, la ficha, el precio efectivo, las promociones y la
  automatización, y recalcula. Si cambió algo, no escribe.
- `PUT /items/{id}` `{price}`. Si hay timeout o error de red, primero consulta el precio y no
  repite si ya quedó. Ante un 409 relee y recalcula. Ante 429 o 5xx hace reintentos limitados
  con espera creciente. Otro 4xx se rechaza.
- Después verifica `price` y `sale_price`. Si quedó otro precio, detiene la corrida.
- Frenos: lock contra corridas simultáneas, 10 cambios por corrida en el piloto, y corta ante
  un error de token, otra cuenta, un precio inesperado o fallos de más del 5 %.

Para escribir hacen falta las dos cosas: `--real` y `datos/modo.json` con `{"modo":"real"}`.

## Token

Nunca renueva ni guarda tokens. Toma el que encuentra primero:

1. `ML_ACCESS_TOKEN`: un access token pegado a mano, para la simulación (dura unas 6 horas).
2. El Worker: `GET https://amadolibros-sync.undiaes.workers.dev/pricing/token` con
   `Authorization: Bearer <PRICING_TOKEN_SECRET>`. Devuelve sólo el access token y su
   `expires_in` real; la renovación sigue a cargo de `meli-auth.js`. Esta ruta está en un PR sin
   mergear y, sin `PRICING_TOKEN_SECRET` cargado en el Worker, responde 404.

## Uso

Requiere Node 22.13 o más nuevo (usa `node:sqlite`, sin dependencias).

```bash
node precios-libros-local/src/sonda.mjs
```
```bash
node precios-libros-local/src/run.mjs --limite 300
```
```bash
node precios-libros-local/src/run.mjs
```

- `sonda.mjs`: prueba de sólo lectura de los ocho endpoints sobre 15 publicaciones (5 de
  catálogo, 5 tradicionales con ficha y 5 sin catálogo). Guarda las respuestas completas y un
  resumen sin montos en `datos/sonda-<fecha>/`.
- `run.mjs`: simulación completa. El informe por publicación queda en
  `datos/informes/<corrida>/informe.csv` y `informe.md`, con precio base, actual,
  competidor, diferencia, objetivo al 99 %, piso, descuento acumulado y motivo. Incluye el
  impacto del límite acumulado (sin límite, 10 %, 15 % y 20 %).

`datos/` no va al repo: guarda `estado.sqlite`, `costos.csv`, `piso.json`, `modo.json`,
informes, sondas y logs.

### Piso

`datos/piso.json`:

```json
{ "comisionPct": 0.0, "cargoFijoUyu": 0, "envioUyu": 0, "margenMinPct": 0.0 }
```

`datos/costos.csv`: `item_id,costo_uyu,envio_uyu` (el envío por publicación es opcional).

## Windows

```bash
powershell -ExecutionPolicy Bypass -File precios-libros-local\windows\instalar-tareas.ps1
```

Crea tres tareas: 09:30, 14:30 y 20:30 (la PC tiene que estar en hora de Montevideo).

- Si la PC estaba apagada o suspendida a esa hora, la tarea corre **una vez** al volver
  (Windows no acumula las perdidas). El motor anota las franjas que no corrieron y avisa.
- Nunca dos corridas a la vez: `MultipleInstances IgnoreNew` y el lock propio, que vence a
  las 2 horas por si la PC se suspendió en medio de una corrida.
- No despierta a la PC.
- Los secretos van en `%LOCALAPPDATA%\AmadoPrecios\secretos.cmd`, fuera del repo
  (ver `windows/correr.cmd`).

## Alertas

Por mail al destino que fija `ALERTA_DESTINO` (el mail de Seba, en `secretos.cmd`; no va en el repo), por SMTP de Gmail. Pasos:

1. En la cuenta de Google que envía: Seguridad → Verificación en dos pasos (activada) →
   Contraseñas de aplicaciones → crear una con el nombre "Motor de precios".
2. En `secretos.cmd`: `set ALERTA_SMTP_USER=<esa cuenta>` `set ALERTA_SMTP_PASS=<la contraseña de 16 letras>` y `set ALERTA_DESTINO=<mail de Seba>`.

Sin esas tres variables, las alertas quedan en `datos/alertas.log`. Se avisa ante: corrida
detenida, precio inesperado, publicación cambiada fuera del motor, freno de cambios y
franjas que no corrieron.

**Una PC apagada no puede avisar de sí misma.** El motor detecta las franjas perdidas recién
cuando vuelve a correr. Para enterarse a tiempo hace falta un vigía externo, por ejemplo un
cron del Worker que mire la hora de la última corrida (la PC la informaría en cada corrida).
Es un servicio nuevo: queda como propuesta, no está hecho.

## Automatización nativa de ML (sólo evaluación)

`sonda.mjs` consulta `/pricing-automation/items/{id}/rules` y `/automation` sobre publicaciones
propias, y `/pricing-automation/users/440298103/items` paginado. La regla `INT` no garantiza
quedar 1 % abajo, ni respetar el umbral de 400, ni volver al precio base cuando desaparece la
competencia. Si no reproduce eso, no cumple la regla aprobada. Además, una publicación con
automatización activa queda fuera de este motor: ML rechaza el PUT de precio.

## Tests

```bash
node --experimental-sqlite --test precios-libros-local/test/*.test.mjs
```
