# Poda de anuncios de Mercado Ads (Amado Libros)

Cada día lee la API de Mercado Ads, aplica las reglas de poda del 11/11/2026 y deja en la mesa
de decisiones la lista de anuncios a pausar y a reactivar. **El Agente único ejecuta esa lista
en la consola sin calcular ni decidir.**

## Por qué no pausa solo

La documentación oficial de Product Ads (actualizada el 19/10/2026) sólo publica consultas, y
el 11/11 toda escritura en Ads por API respondió 401. Por eso este proceso **sólo lee**: el
cliente rechaza cualquier método que no sea GET. Si Mercado Libre habilita el cambio de estado
de un anuncio, se enchufa acá sin tocar las reglas.

## Qué hace en cada corrida

1. Lee anuncios (grupos de anuncios) y sus métricas de 30 días por campaña.
2. Cruza con las órdenes de la tienda en D1 (sin canceladas). Si no están frescas (6 horas),
   no propone ninguna pausa.
3. Para los candidatos lee el precio (`sale_price`; con promoción usa el de lista).
4. Aplica las reglas (`src/reglas.mjs`) y el ciclo de vida del registro (`src/estado.mjs`).
5. En modo `real`: graba en D1 (`poda_registro`). Siempre: guarda el detalle en `poda_corridas`
   y actualiza la fila `poda|AAAA-MM-DD` de la mesa.

## Reglas

| | |
|---|---|
| Tope de gasto sin venta | 10 % del precio, piso $150, techo $400 |
| Clics que se aguantan | tope ÷ costo por clic, mínimo 5. Nunca se pausa con menos de 5 clics |
| Se pausa | al llegar al tope de gasto o de clics sin ninguna venta atribuida en 30 días |
| No se pausa | con una venta en 30 días, atribuida o no (órdenes sin canceladas) |
| Se reactiva | venta atribuida tarde o en órdenes (regla 5); cambio de precio o promoción (regla 6, el gasto cuenta de cero) |
| Clic caro | costo por clic mayor al 4 % del precio: sólo se informa |
| Excepciones | campañas protegidas, sin precio legible, deshabilitados, y lo que pausó otra persona |

Frenos: 25 pausas por corrida y 60 por día (los excedentes no se proponen y se alerta).
Si una lectura clave falla, la corrida no escribe nada y deja una fila de Error en la mesa.

## Operación

- **Apagar:** `poda/modo.json` en `"off"`, o desactivar el workflow en Actions.
- **Prueba:** `modo.json` en `"dry-run"` (el valor de arranque) o la variable del repo `PODA_DRY_RUN=true`.
  No registra nada: sólo informa. Pasa a `"real"` con el sí de Seba.
- **Auditar:** Actions, *Poda de anuncios*, acción `auditar`. No propone pausas; sí reactivaciones.
- **Restaurar:** acción `restaurar`. Propone reactivar todo lo que pausó la poda.
- **Protegidas:** `poda/protegidas.json` (`campanas` y `items_sin_poda` con fecha límite).
- **Pausados a mano antes de la poda:** `poda/semillas.json`. Entran al registro y no se reactivan
  salvo regla 5 o 6.

## Horarios

11:30 de Montevideo: corrida del día. 21:30: auditoría (ventas tardías). Las dispara el Worker
(`worker-sync/poda-trigger.js`) y el cron de GitHub queda de respaldo. Fuera de 08:00 a 23:00
se saltea. El latido (`poda-anuncios-vigia.yml`) avisa por mail si pasadas las 13:00 no hay una
corrida exitosa de hoy.

## Datos y secretos

El repo y los logs son públicos: por stdout sólo salen cantidades. Montos, títulos y precios
van a D1 y a la mesa. Secretos (sólo nombres): `CLOUDFLARE_*` (token de ML y D1),
`AIRTABLE_TOKEN` (fila de la mesa; sin él el detalle va por mail a Seba), `RESEND_API_KEY`.

Tests: `node --test poda/test/*.test.mjs`
