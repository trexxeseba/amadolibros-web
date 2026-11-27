# Cuentas de Mercado Libre: qué camino publica en cuál

**Regla (Seba, 26/10/2026): las altas automáticas van SOLO a Amado Vintage.**
Amado Vintage y Global Emporium son la misma cuenta: en Mercado Libre la cuenta se
llama AMADO VINTAGE y sus publicaciones muestran "Vendido por GLOBAL EMPORIUM". En Amado Libros no se crean publicaciones automáticas, salvo pedido
explícito de Seba.

| Camino | Código | Cuenta (seller_id) | Estado |
| --- | --- | --- | --- |
| Motor local en la PC de Seba (tarea `AmadoVintagePublisher`) | `scripts/vintage-local/`, `scripts/vintage_autorun.py` | **Amado Vintage / Global Emporium (2341378249)** | Publica cuando `campaign.json` dice `"ejecutor": "pc"` |
| Publicador en la nube (workflow `Vintage publicador (nube)`) | `scripts/vintage-cloud/`, `.github/workflows/vintage-nube.yml` | **Amado Vintage / Global Emporium (2341378249)** | Publica sólo con `"ejecutor": "nube"` y `"nube.modo": "real"`; hoy en prueba. Ver `docs/vintage-nube.md` |
| Ejecutor web de Vintage (Pages) | `functions/_shared/meli-vintage-bulk.js`, `meli-vintage-pilot.js` | Amado Vintage / Global Emporium (2341378249) | Queda en pausa mientras la PC tiene la conexión |
| Hermes (republicar fichas de catálogo, `hermes-monitor/`) | `hermes-monitor/publicar.mjs`, `chequeo.mjs` | **Amado Vintage (2341378249)** | Verifica el dueño del token con `/users/me` antes de escribir; un test exige que nunca apunte a Amado Libros |
| Cola de altas del Worker | `worker-sync/publication-*.js` (`USER_ID` en `worker-sync/wrangler.toml`) | Amado Libros (440298103) | **Solo lectura**: `ML_PUBLISHER_MODE = "disabled"`, `ML_PUBLISH_QUEUE_ENABLED = "false"` |
| Sincronización del catálogo del sitio | `worker-sync/index.js` | Amado Libros (440298103) | Lee publicaciones para la web; no crea nada |

## Para cualquier sesión de Claude

- Antes de tocar algo que publique, mirá esta tabla. Si el código usa `SELLER_ID`
  de `worker-sync/publication-policy.js` o `USER_ID` del Worker, es Amado Libros:
  ahí no se publica.
- Lo que sea de Amado Vintage (precio competitivo, objetivo de la campaña, stock)
  va en el motor local: `scripts/vintage-local/` y `worker-sync/vintage-pricing.js`.
  Estado de la campaña: workflow `Vintage status` (`.github/workflows/vintage-status.yml`).
- Reactivar la cola del Worker (Amado Libros) solo con pedido explícito de Seba.
  El test `worker-sync/__tests__/libros-publishing-read-only.test.js` falla si
  alguien la vuelve a prender sin cambiarlo a propósito.

## Desenganche de las dos cuentas (Seba, 27/11/2026)

Ningún código hace que Amado Libros (440298103) y Amado Vintage (2341378249) se comuniquen o crucen
datos por la API de Mercado Libre. Libros se queda con la app actual (4741021817925208); el código de
Vintage se muda más adelante a `amadovintage-web` (Fase 2).

Fase 1 (hecha en este repo):

- Lo que mira datos de Libros usa el token de Libros, sólo GET: la foto de competencia
  (`scripts/mercadolibre/catalogo-competidor.mjs`, `sondeo-competidor.mjs`) y la auditoría de propiedad
  intelectual (`scripts/mercadolibre/auditoria-pi-libros.mjs`). Un 403 con ese token queda como
  "no disponible" y la corrida sigue; nunca se vuelve al token de Vintage.
- Lo de Vintage usa sólo Vintage: `scripts/vintage-cloud/moderadas.mjs` ya no mira el estado de Libros.
- El lector de tokens (`precio-ganador/src/token.mjs`, y `precios-amado/src/token.mjs` para Libros)
  exige una cuenta explícita y verifica con `/users/me` que el token sea de ese seller; si no, aborta.
- Precio Ganador y Precio manual: un workflow por cuenta, con cola, estado, vigía, control y alarmas
  propios (`precio-ganador*.yml`, `precio-manual*.yml`).
- El Worker de sync es de Libros y ya no dispara trabajos de Vintage ni lee sus datos: el publicador en
  la nube, Arnoia/Hermes, el guardián y el vigía de propiedad intelectual corren con su propio cron de
  GitHub, y el latido de la campaña pasó a `vintage-latido.yml`.
- `HOUSE_SELLERS` (`worker-sync/ml-competition.js`) sigue nombrando a Vintage: es una constante para no
  competir contra la propia cuenta, no una conexión.
- El test `functions/__tests__/cuentas-separadas.test.js` falla si un workflow o un job usa las dos
  cuentas, si el código de una carpeta nombra la otra cuenta, o si el Worker vuelve a disparar Vintage.

Pendiente para Fase 2/3: el callback OAuth y las rutas de Vintage en amadolibros.com
(`functions/meli-vintage-callback.js`, `functions/operations/vintage*.js`,
`functions/_shared/meli-vintage-*.js`, `vintage-renew.js`; el publicador en la nube renueva el token de
Vintage por `/operations/vintage-renew`), el motor de altas compartido que vive en `worker-sync/`
(`publication-*.js`, `vintage-pricing.js`, usado por las funciones de Vintage), la base D1
compartida (tablas `ml_oauth` y `ml_oauth_sellers` en la misma base), los secretos de Cloudflare
compartidos, el remitente de mail y Airtable.
