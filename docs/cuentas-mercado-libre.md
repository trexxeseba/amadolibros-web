# Cuentas de Mercado Libre: qué camino publica en cuál

**Regla (Seba, 26/10/2026): las altas automáticas van SOLO a Amado Vintage.**
Amado Vintage y Global Emporium son la misma cuenta: en Mercado Libre la cuenta se
llama AMADO VINTAGE y sus publicaciones muestran "Vendido por GLOBAL EMPORIUM". En Amado Libros no se crean publicaciones automáticas, salvo pedido
explícito de Seba.

| Camino | Código | Cuenta (seller_id) | Estado |
| --- | --- | --- | --- |
| Motor local en la PC de Seba (tarea `AmadoVintagePublisher`) | `scripts/vintage-local/`, `scripts/vintage_autorun.py` | **Amado Vintage / Global Emporium (2341378249)** | **Activo: único camino que publica** |
| Ejecutor web de Vintage (Pages) | `functions/_shared/meli-vintage-bulk.js`, `meli-vintage-pilot.js` | Amado Vintage / Global Emporium (2341378249) | Queda en pausa mientras la PC tiene la conexión |
| Cola de altas del Worker | `worker-sync/publication-*.js` (`USER_ID` en `worker-sync/wrangler.toml`) | Amado Libros (440298103) | **Solo lectura**: `ML_PUBLISHER_MODE = "disabled"`, `ML_PUBLISH_QUEUE_ENABLED = "false"` |
| Sincronización del catálogo del sitio | `worker-sync/index.js` | Amado Libros (440298103) | Lee publicaciones para la web; no crea nada |
| Promociones por API (`meli-promos.yml`, `worker-sync/seller-promotions.js`) | `scripts/mercadolibre/promos.mjs` | Amado Libros (440298103) | Lee promociones; con `confirm=true` solo saca publicaciones de una promo o suma a la oferta relámpago. No publica ni cambia precios. Ver `docs/meli-promos.md` |

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
