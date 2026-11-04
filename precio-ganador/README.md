# Precio Ganador (Amado Libros)

Baja automáticamente al precio ganador las publicaciones de **Amado Libros
(440298103)** que Mercado Libre marca como perdedoras, con un tope de 360 pesos, y
las vuelve a subir cuando dejan de estar marcadas. Amado Vintage **no** corre acá:
su precio lo maneja el motor de la PC (`scripts/vintage-local/stock-sync.mjs`).

## Qué hace en cada corrida

1. Lee todas las publicaciones activas. Esta lectura no cambia nada.
2. Consulta la competencia de cada una:
   - **Con catálogo**: `GET /items/{id}/price_to_win?version=v2`. Está marcada
     ("Precio para ganar") si el estado es `competing` y el precio para ganar es
     menor al suyo.
   - **Sin catálogo**: `GET /suggestions/items/{id}/details`. Está marcada
     ("Precio alto") si el estado contiene `high` y el precio sugerido es menor.
3. Qué hace con cada marcada:
   - si la diferencia es menor a 360, baja al precio ganador, redondeado hacia abajo al peso;
   - si es de 360 o más, no la toca;
   - si tiene una promoción activa (`/seller-promotions/items/{id}`), la saltea;
   - si no puede confirmar si tiene promoción, también la saltea;
   - si tiene variaciones o el precio no está en pesos, la saltea.
4. Qué hace con las que el sistema bajó antes:
   - si siguen marcadas, sigue al ganador, sin pasar nunca el precio original;
   - si el ganador bajó 360 o más desde el original, la deja donde está;
   - si dejaron de estar marcadas, las sube hasta un peso por debajo del competidor
     más barato, o hasta el original si no hay competidor más barato;
   - si alguien les cambió el precio a mano, las saca del sistema y no las vuelve a tocar.
5. Las publicaciones que el sistema nunca tocó no se modifican nunca. El stock de
   Libros no se toca nunca.

Piso opcional por publicación: `pisos/libros.json`, con el formato `{ "MLU123": 900 }`.

## Horarios

09:00, 15:00 y 21:00 de Montevideo. El mail de resumen del día sale a
undiaes@gmail.com con la corrida de las 21:00. Si un día no llega, algo se rompió.
Si una corrida falla entera, GitHub manda su mail de falla.

## Estado

Está en la rama `estado/precio-ganador`, no en `main`, para no disparar el deploy del sitio:

- `state/libros.json`: por cada publicación bajada, el precio original, el precio
  aplicado y las fechas. Se graba después de cada cambio.
- `state/diario/`: los contadores de cada corrida del día.
- `ultima/`: el detalle de la última corrida.
- `pruebas/`: las corridas de prueba.

## Secretos que usa (solo nombres)

- `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ADMIN_API_TOKEN` y `CLOUDFLARE_API_TOKEN`:
  para leer de D1 (`ml_oauth`) el token de Mercado Libre que mantiene el Worker.
- `RESEND_API_KEY`: para el mail.

El token **nunca se renueva desde acá**. Lo renueva el Worker cada 5 minutos, y un
segundo renovador le rompería la conexión. Si el token no está vigente, la corrida
espera 8 minutos y después falla.

## Cómo pausarlo

- Variable del repo `PRECIO_GANADOR_DRY_RUN`: con `false` cambia precios; con
  cualquier otro valor, o sin la variable, solo informa (DRY_RUN).
- También se puede desactivar el workflow **Precio Ganador** en Actions.

## Cómo volver todo al precio original

En Actions, **Precio Ganador**, *Run workflow*, con acción `restaurar`:

- en modo real, devuelve cada publicación del estado a su `precio_original`;
- solo toca las publicaciones que siguen con el precio que puso el sistema;
- en DRY_RUN solo lista lo que haría.

Desde una PC: `node precio-ganador/src/restaurar.mjs --cuenta libros --estado <carpeta>`,
agregando `--real` para que aplique los cambios.

## Frenos

- Más de 400 cambios en una corrida: no aplica nada y falla.
- El token tiene que ser de la cuenta 440298103.
- Ante 429 o 5xx reintenta con espera. Una publicación que falla no frena a las demás.

Tests: `node --test precio-ganador/test/*.test.mjs`
