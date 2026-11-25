# Endpoints de Mercado Libre confirmados con llamadas reales

Sondeo del 10/11/2026 (`src/sondeo.mjs`, workflow `agentes-ml-sondeo.yml`), con el
token de la app de Amado Libros leído de D1. Solo GET. Lo que difiere de lo que
decía la documentación o la consigna está marcado con **Difiere**.

## Autenticación y aplicación

- `GET /users/me`: 200, `site_id` MLU, el id coincide con la cuenta.
- `GET /applications/{APP_ID}`: 200. Scopes de la app: `read`, `write`,
  `offline_access`, `urn:ml:mktp:offers:/read-write` (promociones),
  `urn:ml:mktp:ads:/read-write` (publicidad), `urn:ml:mktp:publish-sync`,
  `urn:ml:mktp:orders-shipments`, `urn:ml:mktp:invoices`, comunicación y los
  `urn:global:admin:*`. **Ningún scope `urn:mp:`** (Mercado Pago). 18.000
  pedidos por hora como máximo declarado (`max_requests_per_hour`).
- El token lo renueva el Worker en D1 `ml_oauth` (lock + compare-and-swap);
  los jobs solo lo leen, como Precio Ganador.

## Publicaciones

- `GET /users/{id}/items/search?status=active&search_type=scan&limit=100`: 200,
  `paging.total` 6.886 activas, `scroll_id` para paginar.
- `GET /users/{id}/items/search?status=active&catalog_listing=true&limit=50`:
  200, 3.072 publicaciones de catálogo. Sirve para acotar `price_to_win`.
- `GET /items/bulk?ids=...&attributes=status_code,body.id,body.price,...` (20 por
  llamada): 200. `available_quantity` llega **entero exacto** en las 160 leídas
  (nunca rango). `original_price` viene `null` aun con promo: no usarlo.
  `deal_ids` viene vacío también en publicaciones con promo activa: no sirve
  para saber si está en promo.

## Precio visible y competencia

- `GET /items/{id}/sale_price` (con o sin `?context=channel_marketplace`, misma
  respuesta): 200. `amount` (precio que ve el comprador), `regular_amount`
  (precio de lista; `null` si no hay promo), `metadata.campaign_id`
  (`P-MLU...`), `metadata.promotion_id` (`OFFER-...`), `metadata.promotion_type`
  (`campaign`). Ejemplo real: amount 2056,40 sobre regular 2650 = 22,4 % visible
  en una publicación de Ciberlunes.
- `GET /items/{id}/price_to_win?version=v2`: 200. Catálogo: `status`
  (`winning`, `competing`, `sharing_first_place`...), `price_to_win`,
  `current_price`, `winner.price`, `boosts`, `competitors_sharing_first_place`,
  `visit_share`. **Difiere**: en publicaciones sin catálogo (3.800 de las
  6.886) responde `status: not_listed`, `reason: item_not_opted_in`: no hay dato
  de competencia por este camino.

## Promociones (`app_version=v2`)

- `GET /seller-promotions/users/{id}?app_version=v2`: 200, `results` con
  `id`, `type`, `sub_type`, `status`, `name`, `start_date`, `finish_date`,
  `deadline_date`. Hoy: 14 promociones, tipos `SMART`, `SMART_LIGHTNING`,
  `SELLER_COUPON_CAMPAIGN` (5 cupones), `SELLER_CAMPAIGN` (Amado 15), `DEAL`
  (Ciberlunes activa, dos pendientes), `VOLUME`.
  **Difiere**: no aparece ninguna invitación `LIGHTNING`; la relámpago es
  `SMART_LIGHTNING` ("Relámpagos compartidas", con aporte de ML).
- `GET /seller-promotions/promotions/{id}/items?promotion_type=X&app_version=v2&limit=50[&status=started]`:
  200. **Difiere**: la clave de paginación es `paging.searchAfter` (camelCase),
  no `search_after`. Campos según tipo:
  - `SMART` / `SMART_LIGHTNING`: `price` (precio final que propone ML),
    `original_price`, `meli_percentage`, `seller_percentage`, `offer_id`
    (`CANDIDATE-...`), y en relámpago `stock: {min, max}`.
  - `SELLER_CAMPAIGN`, `DEAL`, `PRICE_DISCOUNT`: `min_discounted_price`,
    `max_discounted_price`, `suggested_discounted_price`.
  - `SELLER_COUPON_CAMPAIGN`: `fixed_amount` (monto del cupón, por ejemplo 300),
    `sub_type`. **Difiere**: el monto de los cupones sí se lee por API.
  - `VOLUME`: `buy_quantity`, `discount_percentage`, `allow_combination`.
- `GET /seller-promotions/items/{MLU}?app_version=v2`: 200, **array** (no
  `results`) con todas las promos de la publicación y su `status`
  (`candidate`, `started`, `pending`). La entrada `PRICE_DISCOUNT` viene sin
  `id` y con `name` vacío.

## Ventas y visitas

- `GET /orders/search?seller={id}&order.date_created.from=...&order.date_created.to=...&sort=date_desc&limit=1`:
  200, `paging.total`, `order_items[].item.id`, `quantity`, `unit_price`,
  `status`, `date_created`. Confirmado hasta 12 meses atrás (380 órdenes entre
  11 y 12 meses atrás).
- `GET /users/{id}/items_visits?date_from&date_to` (150 días): 200,
  `total_visits`, `visits_detail`.
- `GET /items/{id}/visits/time_window?last=30&unit=day`: 200 con
  `total_visits`, pero `results` vacío (sin detalle por día) en la muestra.

## Product Ads (header `api-version: 2`, salvo anunciantes)

Rutas tomadas de la documentación "Product Ads para Catálogo y User Products
(lectura)" y confirmadas con 200. Las rutas sin el site en el path y las
viejas `/advertising/MLU/product_ads/campaigns` responden 404.

- `GET /advertising/advertisers?product_id=PADS` (header `Api-Version: 1`): 200,
  un anunciante, site MLU.
- `GET /advertising/MLU/advertisers/{ADV}/product_ads/campaigns/search?limit&offset[&filters[status]=active][&date_from&date_to&metrics=...&metrics_summary=true]`:
  200. 14 campañas (2 activas). Campos: `id`, `name`, `status`, `strategy`
  (`PROFITABILITY`), `budget`, `daily_budget`, `automatic_budget`,
  `roas_target`, `acos_target`, `acos_top_search_target`, `date_created`,
  `last_updated`, `channel`. Métricas: `clicks`, `prints`, `cost`, `cpc`, `ctr`,
  `direct_amount`, `indirect_amount`, `total_amount`, `direct_units_quantity`,
  `indirect_units_quantity`, `units_quantity`, `acos`, `cvr`, `roas`, `sov`...
  Con `aggregation_type=DAILY` devuelve una fila por día (`date`).
- `GET /advertising/MLU/product_ads/campaigns/{ID}?date_from&date_to&metrics=...`:
  200, incluye `impression_share`, `top_impression_share`,
  `lost_impression_share_by_budget`, `lost_impression_share_by_ad_rank`,
  `acos_benchmark`. Con `aggregation_type=DAILY`, una fila por día.
- `GET /advertising/MLU/advertisers/{ADV}/product_ads/ad_groups/search?limit&offset&date_from&date_to&metrics=CLICKS,COST,...&filters[campaign_id]={ID}`:
  200. 45 ad groups en la campaña activa. Campos: `id`, `campaign_id`,
  `status` (`ACTIVE`, `PAUSED`, `HOLD`), `ad_group_type` (`CATALOG`, `FAMILY`),
  `ad_group_external_id`, `catalog_listing`, `title`, `date_created`,
  `metrics`.
- `GET /advertising/MLU/product_ads/ad_groups/{AD_GROUP_ID}?date_from&date_to&metrics=...&aggregation_type=daily`:
  200, **una fila por día por ad group** (31 filas para 30 días) con `clicks`,
  `cost`, `direct_amount`, `indirect_amount`, `units_quantity`, `date`.
  Confirmado: sirve para "3 días con gasto y sin venta".
- `GET /advertising/MLU/product_ads/ad_groups/{AD_GROUP_ID}/ads?date_from&date_to&metrics=...`:
  200, los anuncios (MLU) del ad group.
- `GET /advertising/MLU/advertisers/{ADV}/product_ads/ads/search?filters[item_ids]=MLU...`
  o `filters[item_id]=`: 200, devuelve `item_id`, `campaign_id`, `ad_group_id`,
  `status`, `buy_box_winner`, `has_discount`. Sirve para saber si un título
  tiene anuncio y en qué campaña.
- `GET .../campaigns/{ID}/ads/metrics?date_from&date_to`: 400 si el rango pasa
  de un día sin `filters[item_ids]`.
- Escrituras de Product Ads: no se probaron ni se van a probar.
