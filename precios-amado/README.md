# Precios Amado

Analiza la competencia de las publicaciones activas de Amado Libros en Mercado
Libre Uruguay, avisa cuando perdemos la oferta destacada de catálogo frente a un
vendedor más barato **que declara plazo de preparación**, y detecta libros donde
la entrega inmediata justifica revisar el precio.

**Sólo lee.** No cambia precios ni crea, cierra, pausa o desvincula publicaciones.
No usa IA ni scraping: sólo la API oficial de Mercado Libre.

## Cómo corre

- GitHub Actions, workflow `Precios Amado` (`.github/workflows/precios-amado.yml`):
  08:40, 13:10 y 18:40 de Montevideo. También se lanza a mano (`workflow_dispatch`,
  con `limit` y `sin_correo` opcionales).
- Correo a sebastian@amadolibros.com por Resend (mismo remitente verificado que
  los informes): **resumen** en la primera corrida del día; en las otras, correo
  sólo si aparece un caso nuevo o cambia uno existente (precio, ganador, plazo).
- Reporte y estado en el bucket **privado** de R2 `amadolibros-reports`:
  - `precios-amado/ultimo.html` y `precios-amado/reportes/<fecha>-<run>.html`
  - `precios-amado/state.tgz` — historial de precios, avisos ya mandados, métricas
  - `precios-amado/config.json` — opcional, techos comerciales (ver abajo)
- Los logs de Actions son públicos (repo público): el script imprime sólo conteos.

En la PC también corre (`node precios-amado/src/run.mjs --limit 300 --sin-correo`),
con estado en `%USERPROFILE%\.amado-precios`. Ahí usa el token de aplicación, que
**no** lee plazos de terceros (ver Límites).

## Token de Mercado Libre

| Fuente | Dónde | Qué puede |
| --- | --- | --- |
| `worker` (Actions) | `ml_oauth` en D1 del Worker de sync, leída por la API de Cloudflare | Todo lo necesario, incluido `/items/bulk` de terceros (plazos) |
| `app` (PC) | `~/.amado-precios/credentials.json` o `ML_PRECIOS_APP_ID` / `ML_PRECIOS_CLIENT_SECRET`. App de `mlu-monitor/.env` (`ML_CLIENT_ID`, `ML_CLIENT_SECRET`) | Nuestras publicaciones, fichas, `price_to_win`. `/items/bulk` de terceros: 403 |

El token del Worker **nunca se renueva desde acá**: el refresh token es rotativo y
de un solo uso, y lo administra `worker-sync/meli-auth.js` con lock en D1. Si está
por vencer, el script espera (hasta 7 minutos) a que el Worker lo renueve.

## Qué se compara

- Mismo libro = misma ficha de catálogo (`catalog_product_id`). Las publicaciones
  sin ficha se buscan por ISBN en `/products/search` y la ficha tiene que declarar
  el mismo ISBN (ISBN-10 e ISBN-13 normalizados). La búsqueda general
  `/sites/MLU/search` responde 403 para esta cuenta.
- Se excluyen nuestras publicaciones, los usados frente a un nuevo, los
  internacionales, otra moneda, y las ofertas verificadas como pausadas o sin stock.
- Plazo: `MANUFACTURING_TIME` en `sale_terms` de `/items/bulk`. El listado de la
  ficha (`/products/{id}/items`) **no lo trae** (0 de 1.490 ofertas de terceros el
  03/11/2026), así que una oferta sin verificar queda con plazo desconocido, nunca
  como "inmediata". Sin plazo declarado ≠ entrega inmediata comprobada.

Estados por publicación: `sin_competidores`, `solo_con_plazo`,
`con_sin_plazo_declarado`, `plazo_no_verificado`, `insuficiente` (consulta fallida
o incompleta). Un error de consulta nunca produce una oportunidad.

## Oportunidades de subida

- Sólo activas, con stock, sin plazo propio, y que no estén perdiendo la ficha.
- Una por ficha (la de catálogo y su tradicional gemela son el mismo libro).
- **Sugerido** sólo con referencia observada: el competidor a pedido más barato,
  si está por encima de nuestro precio, acotado por el techo si existe. Si no hay
  referencia: "oportunidad para revisar", sin importe.
- **Máximo observado**: dato histórico desde el inicio del seguimiento, no un techo.
- Techos comerciales: `config.json` en R2 → `{ "techos": { "MLU123": 1500 } }`.

## Catálogo: qué verificamos (03/11/2026)

- `MLU-BOOKS` está en `/catalog/dumps/domains/MLU/catalog_required` desde el
  21/07/2023: en Uruguay, Libros tiene catálogo obligatorio.
- Cada publicación de catálogo nuestra tiene una tradicional vinculada por
  `item_relations` con `stock_relation: 1` (stock compartido, mismo precio).
  `catalog_listing_eligibility`: la de catálogo `COMPETING`, la tradicional
  `ALREADY_OPTED_IN`.
- Por lo tanto: salir del catálogo no es una opción y crear otra tradicional no
  la saca de la ficha. Las palancas son condiciones (las mejoras que
  `price_to_win` marca como `opportunity`: Full, envío gratis, etc.), precio, y
  soporte cuando el ganador no es más barato y ML no explica por qué.
- Falta comprobar: cuánta exposición tiene la tradicional gemela en listados
  cuando perdemos la ficha (no se puede medir por API sin búsqueda).

## Costo

- GitHub Actions: repo público → minutos de runners estándar sin costo.
- R2: estado de pocos cientos de KB y un HTML por corrida; muy por debajo de los
  10 GB gratuitos. Operaciones: 6 por corrida.
- Resend: ya contratado/configurado; 1 a 3 correos por día.
- Cloudflare D1: 1 lectura por corrida (más si espera la renovación).
- Sin IA en la ejecución.

## Tests

`node --test precios-amado/test/*.test.mjs`
