# Precio Ganador (Amado Libros y Amado Vintage)

Baja automáticamente al precio ganador las publicaciones que Mercado Libre marca
como perdedoras y las vuelve a subir cuando dejan de estar marcadas.

| | Amado Libros (440298103) | Amado Vintage (2341378249) |
|---|---|---|
| Baja si la diferencia con el precio para ganar es | menor a 360 | menor o igual a 400 |
| Precio nuevo | el precio para ganar | el 99 % del precio para ganar, hacia abajo al peso |
| Contra qué ganadores | cualquiera | sólo a demanda: si el ganador entrega de inmediato, o no se pudo leer su plazo, no se toca |
| Tope de porcentaje | 30 % | sin tope |
| Piso | el de `pisos/libros.json`, si existe | nunca menos de UYU 1.200 |
| Stock | no se toca | a demanda: stock 5 al bajar, se restaura al revertir |
| Freno de cambios por corrida | 400 | 5.000 |

El plazo del ganador se lee por `/items/{id}/shipping_options` (destino Cordón), con
la misma lectura que el panel de competencia (`worker-sync/ml-competition.js`).
Una publicación que el sistema bajó sigue al ganador a demanda al 99 %; si el
ganador de hoy entrega de inmediato, vuelve hacia su precio original. Las subidas
se limitan al 99 % del competidor a demanda más barato y sólo se hacen si el salto
es de 10 pesos o más.

Vintage corre acá desde el 05/11/2026 porque el motor de la PC no está andando.
Si el motor se vuelve a prender hay que apagar uno de los dos: se pisarían.

## Qué hace en cada corrida

1. Lee todas las publicaciones activas. Esta lectura no cambia nada.
2. Consulta la competencia de cada una:
   - **Con catálogo**: `GET /items/{id}/price_to_win?version=v2`. Está marcada
     ("Precio para ganar") si el estado es `competing` y el precio para ganar es
     menor al suyo.
   - **Sin catálogo**: `GET /suggestions/items/{id}/details`. Está marcada
     ("Precio alto") si el estado contiene `high` y el precio sugerido es menor.
3. Qué hace con cada marcada:
   - si la diferencia es menor a 360 y la baja no pasa el 30 %, baja al precio
     ganador, redondeado hacia abajo al peso;
   - si la diferencia es de 360 o más, o la baja pasa el 30 %, no la toca;
   - si tiene una promoción activa (`/seller-promotions/items/{id}`), la saltea;
   - si no puede confirmar si tiene promoción, también la saltea;
   - si tiene variaciones o el precio no está en pesos, la saltea.
4. Qué hace con las que el sistema bajó antes:
   - si siguen marcadas, sigue al ganador, sin pasar nunca el precio original;
   - si el ganador quedó 360 o más (o más del 30 %) por debajo del original, la deja donde está;
   - si dejaron de estar marcadas, las sube hasta un peso por debajo del competidor
     más barato, o hasta el original si no hay competidor más barato;
   - si alguien les cambió el precio a mano, las saca del sistema y no las vuelve a tocar.
5. Las publicaciones que el sistema nunca tocó no se modifican nunca. El stock de
   Libros no se toca nunca.

Piso opcional por publicación: `pisos/libros.json`, con el formato `{ "MLU123": 900 }`.

## Horarios

Libros: 09:00, 15:00 y 21:00 de Montevideo. Vintage: dos veces por día, a las 09:00 y a las 21:00 (Seba, 05/11/2026: con tres corridas iba y venía, una bajaba unas 1.500 y la siguiente las volvía a subir). El mail de resumen del día sale a
undiaes@gmail.com con la corrida de las 21:00. Si un día no llega, algo se rompió.
Si una corrida falla entera, GitHub manda su mail de falla.

## Estado

Está en la rama `estado/precio-ganador`, no en `main`, para no disparar el deploy del sitio:

- `state/libros.json`: por cada publicación bajada, el precio original, el precio
  aplicado y las fechas. Se graba después de cada cambio.
- `state/diario/`: los contadores de cada corrida del día.
- `ultima/`: el detalle de la última corrida.
- `pruebas/`: las corridas de prueba (DRY_RUN previo a la activación).

## Lo que no cubre

"Precio alto" (publicaciones sin catálogo): el endpoint de precios de referencia
(`/suggestions/items/{id}/details`) responde 404 para toda la cuenta en Mercado Libre Uruguay.
Hoy el sistema actúa sólo sobre las de catálogo ("Precio para ganar").

## Secretos que usa (solo nombres)

- `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ADMIN_API_TOKEN` y `CLOUDFLARE_API_TOKEN`:
  para leer de D1 (`ml_oauth`) el token de Mercado Libre que mantiene el Worker.
- `RESEND_API_KEY`: para el mail.

El token **nunca se renueva desde acá**. Lo renueva el Worker cada 5 minutos, y un
segundo renovador le rompería la conexión. Si el token no está vigente, la corrida
espera 8 minutos y después falla.

## Cómo pausarlo

- `precio-ganador/modo.json`: `"real"` cambia precios; cualquier otro valor solo informa.
- Variable del repo `PRECIO_GANADOR_DRY_RUN` = `true`: pausa sin tocar código (solo informa).
- También se puede desactivar el workflow **Precio Ganador** en Actions.

## Cómo volver todo al precio original

En Actions, **Precio Ganador**, *Run workflow*, con acción `restaurar`:

- en modo real, devuelve cada publicación del estado a su `precio_original`;
- solo toca las publicaciones que siguen con el precio que puso el sistema;
- en DRY_RUN solo lista lo que haría.

Desde una PC: `node precio-ganador/src/restaurar.mjs --cuenta libros --estado <carpeta>`,
agregando `--real` para que aplique los cambios.

## Auditoría independiente

Después de cada corrida, `src/auditoria.mjs` revisa lo hecho sin usar el código del
motor (recalcula la regla desde cero). Sólo lee:

1. 10 publicaciones de catálogo al azar: relee el estado en la ficha y las ofertas de
   los otros vendedores, y confirma si gana o pierde y contra quién.
2. Todas las que el sistema bajó: el precio en ML es el registrado, nunca supera el
   original y nunca bajó 360 o más ni más del 30 %.
3. Todas las marcadas de la corrida: la regla recalculada da la misma acción.

Resultado en `ultima/<cuenta>-auditoria.md` de la rama de estado. Cualquier
discrepancia se avisa por mail con los IDs. El job falla sólo si es serio: más de
2 de la muestra de 10, una decisión que no coincide con la regla, más de 10
publicaciones del estado con otro precio, o errores de aplicación por encima del
2 % de los intentos (mínimo 3). El vigía (`precio-ganador-vigia.yml`, cada 3 horas)
distingue "no corrió" de "corrió con avisos" y lo dice en el mail. Para correrla sola,
sin tocar precios: Run workflow con acción `auditar`.

## Frenos

- Después de cada cambio vuelve a leer la publicación y verifica el precio.

- Más de 400 cambios en una corrida: no aplica nada y falla.
- El token tiene que ser de la cuenta 440298103.
- Ante 429 o 5xx reintenta con espera. Una publicación que falla no frena a las demás.

Tests: `node --test precio-ganador/test/*.test.mjs`
