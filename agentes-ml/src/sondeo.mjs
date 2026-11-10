// Sondeo de SOLO LECTURA de la API de Mercado Libre para los agentes diarios.
//
//   node agentes-ml/src/sondeo.mjs
//
// Confirma con una llamada real cada endpoint que van a usar los jobs de
// Promociones y de medición de Product Ads, con el token que ya tiene la app de
// Amado Libros (D1 ml_oauth, renovado por el Worker). Imprime código HTTP y la
// forma de cada respuesta (claves y tipos). Ningún POST, PUT ni DELETE: el
// cliente se crea en modo solo lectura y rechaza cualquier escritura.
//
// El log de Actions es público: no se imprimen montos de ventas, visitas,
// métricas de publicidad ni datos de otros vendedores. Sí precios y promociones
// de nuestras publicaciones (ya visibles en Mercado Libre) para verificar campos.
import { CUENTA, APP_ID, SITE_ID, fechaCorrida, fechaMontevideo } from './config.mjs';
import { crearCliente } from './ml.mjs';
import { forma, texto, mascara, elegir, detalleError } from './sanear.mjs';
import { fuenteTokenD1 } from '../../precio-ganador/src/token.mjs';
import { bulkItemsPath, bulkEntryItem } from '../../worker-sync/meli-bulk.js';

const V2 = 'app_version=v2';
const ADS = version => ({ headers: { 'Api-Version': String(version) } });
const salida = {};
const imprimir = (titulo, valor) => { salida[titulo] = valor; console.log(`\n## ${titulo}\n` + JSON.stringify(valor, null, 1)); };
const lista = j => Array.isArray(j) ? j : Array.isArray(j?.results) ? j.results : [];

async function seccion(nombre, fn) {
  try { imprimir(nombre, await fn()); }
  catch (e) { imprimir(nombre, { fallo: detalleError(e) }); }
}
// Una sonda: código HTTP, forma de la respuesta y mensaje de error saneado.
const tapar = s => texto(String(s).replace(/\d{4,}/g, m => mascara(m)));
const detalle = json => tapar(JSON.stringify(json ?? {}).slice(0, 400));
async function sondar(ml, path, opciones = {}, conValores = null) {
  const r = await ml.sonda(path, opciones);
  const out = { http: r.status, path: tapar(path) };
  if (!r.ok) out.detalle = detalle(r.json);
  else { out.forma = forma(r.json); if (conValores) out.valores = conValores(r.json); }
  return out;
}

async function main() {
  const hoy = fechaMontevideo(), hace7 = fechaCorrida(-7), hace30 = fechaCorrida(-30), hace150 = fechaCorrida(-150);
  const ml = crearCliente(fuenteTokenD1(CUENTA), { intentos: 3, concurrencia: 2 });
  console.log(`Sondeo ${new Date().toISOString()} (fecha Montevideo ${hoy}). Solo GET.`);

  // 1. Identidad y aplicación
  const yo = await ml.get('/users/me');
  if (String(yo?.id) !== CUENTA.sellerId) throw Object.assign(new Error('token_de_otra_cuenta'), { fatal: true });
  imprimir('identidad', { seller_ok: true, site_id: yo.site_id, user_type: yo.user_type ?? null, tags: yo.tags ?? null });
  await seccion('aplicacion', async () => sondar(ml, `/applications/${APP_ID}`, {}, j => elegir(j, ['active', 'site_id', 'scopes', 'max_requests_per_hour', 'sandbox_mode'])));

  // 2. Publicaciones: scan y bulk (stock exacto)
  let ids = [], items = [];
  await seccion('items_search_scan', async () => {
    const r = await ml.sonda(`/users/${CUENTA.sellerId}/items/search?status=active&search_type=scan&limit=100`);
    ids = lista(r.json);
    let scroll = r.json?.scroll_id, paginas = 1;
    // Hasta 3 páginas más para encontrar publicaciones de catálogo en la muestra.
    while (scroll && paginas < 4) {
      const p = await ml.sonda(`/users/${CUENTA.sellerId}/items/search?status=active&search_type=scan&limit=100&scroll_id=${encodeURIComponent(scroll)}`);
      ids.push(...lista(p.json)); scroll = p.json?.scroll_id; paginas++;
    }
    return { http: r.status, forma: forma(r.json), total: r.json?.paging?.total ?? null, con_scroll_id: typeof r.json?.scroll_id === 'string', paginas, ids_leidos: ids.length };
  });
  await seccion('items_bulk', async () => {
    if (!ids.length) return { omitido: 'sin ids' };
    const campos = 'id,price,currency_id,available_quantity,initial_quantity,sold_quantity,status,sub_status,catalog_listing,catalog_product_id,date_created,last_updated,listing_type_id,condition,category_id,seller_custom_field,tags,deal_ids,variations,sale_terms,health,original_price,base_price';
    let primera = null, entradasTotal = 0;
    // Lotes de 20 hasta juntar 3 de catálogo (tope de 8 lotes).
    for (let i = 0; i < ids.length && i < 160 && items.filter(x => x.catalog_listing).length < 3; i += 20) {
      const r = await ml.sonda(bulkItemsPath(ids.slice(i, i + 20), campos));
      const entradas = Array.isArray(r.json) ? r.json : [];
      primera ??= { http: r.status, forma_entrada: forma(entradas[0]) };
      entradasTotal += entradas.length;
      items.push(...entradas.map(bulkEntryItem).filter(Boolean));
    }
    const stock = items.map(i => i.available_quantity);
    return {
      ...primera, entradas: entradasTotal, items_ok: items.length, de_catalogo: items.filter(i => i.catalog_listing).length,
      stock_exacto: stock.every(q => Number.isInteger(q)), stock_tipos: [...new Set(stock.map(q => typeof q))],
      con_deal_ids: items.filter(i => Array.isArray(i.deal_ids) && i.deal_ids.length).length,
      muestra: [...items.filter(i => i.catalog_listing).slice(0, 3), ...items.slice(0, 2)].map(i => elegir(i, ['id', 'price', 'original_price', 'base_price', 'available_quantity', 'sold_quantity', 'status', 'catalog_listing', 'catalog_product_id', 'date_created', 'listing_type_id', 'deal_ids', 'tags'])),
    };
  });
  const catalogo = items.filter(i => i.catalog_listing).slice(0, 3), tradicional = items.filter(i => !i.catalog_listing).slice(0, 2);
  const muestraIds = [...catalogo, ...tradicional].map(i => i.id);
  const conDeal = items.filter(i => Array.isArray(i.deal_ids) && i.deal_ids.length).slice(0, 2).map(i => i.id);

  // 4. Promociones
  let promos = [];
  await seccion('promociones_usuario', async () => {
    const r = await ml.sonda(`/seller-promotions/users/${CUENTA.sellerId}?${V2}`);
    promos = lista(r.json);
    return {
      http: r.status, forma: forma(r.json), cantidad: promos.length,
      por_tipo: promos.reduce((a, p) => ({ ...a, [`${p?.type}|${p?.status}`]: (a[`${p?.type}|${p?.status}`] ?? 0) + 1 }), {}),
      promociones: promos.slice(0, 25).map(p => elegir(p, ['id', 'type', 'sub_type', 'status', 'name', 'start_date', 'finish_date', 'deadline_date', 'benefits'])),
      ...(r.ok ? {} : { detalle: detalle(r.json) }),
    };
  });
  const promoIds = new Set(); let enPromo = [];
  const CAMPOS_ITEM = ['id', 'status', 'price', 'original_price', 'offer_id', 'meli_percentage', 'seller_percentage', 'start_date', 'end_date', 'finish_date', 'stock', 'min_discounted_price', 'max_discounted_price', 'suggested_discounted_price', 'min_stock', 'max_stock', 'suggested_stock', 'fixed_amount', 'sub_type', 'buy_quantity', 'discount_percentage', 'allow_combination'];
  await seccion('promociones_items', async () => {
    const out = [];
    const elegidas = [...new Map(promos.filter(p => p?.id && p?.type).map(p => [p.type, p])).values()].slice(0, 7);
    for (const p of elegidas) {
      const r = await ml.sonda(`/seller-promotions/promotions/${encodeURIComponent(p.id)}/items?promotion_type=${encodeURIComponent(p.type)}&${V2}&limit=50`);
      const its = lista(r.json);
      for (const it of its.slice(0, 2)) if (it?.id) promoIds.add(it.id);
      const estados = its.reduce((a, i) => ({ ...a, [i?.status]: (a[i?.status] ?? 0) + 1 }), {});
      out.push({ promo: elegir(p, ['id', 'type', 'sub_type', 'status', 'name']), http: r.status, forma: forma(r.json), total: r.json?.paging?.total ?? null, estados_pagina: estados,
        paginacion: elegir(r.json?.paging ?? {}, ['limit', 'offset', 'total']), clave_search_after: Object.keys(r.json?.paging ?? {}).filter(k => /search/i.test(k)),
        muestra: its.slice(0, p.type === 'SMART_LIGHTNING' ? 5 : 3).map(i => elegir(i, CAMPOS_ITEM)), ...(r.ok ? {} : { detalle: detalle(r.json) }) });
    }
    // Publicaciones que YA están en una promo (status=started) de la DEAL activa, para ver sale_price con descuento.
    const activa = promos.find(p => p?.type === 'DEAL' && p?.status === 'started') ?? promos.find(p => p?.status === 'started' && /SMART|DEAL|SELLER_CAMPAIGN/.test(p?.type));
    if (activa) {
      const r = await ml.sonda(`/seller-promotions/promotions/${encodeURIComponent(activa.id)}/items?promotion_type=${encodeURIComponent(activa.type)}&${V2}&status=started&limit=50`);
      const its = lista(r.json);
      enPromo = its.filter(i => i?.status === 'started').slice(0, 3).map(i => i.id);
      out.push({ filtro_started: elegir(activa, ['id', 'type', 'name']), http: r.status, total: r.json?.paging?.total ?? null, estados_pagina: its.reduce((a, i) => ({ ...a, [i?.status]: (a[i?.status] ?? 0) + 1 }), {}), muestra: its.slice(0, 3).map(i => elegir(i, CAMPOS_ITEM)), ...(r.ok ? {} : { detalle: detalle(r.json) }) });
    }
    return out;
  });
  await seccion('promociones_por_item', async () => {
    const out = [];
    for (const id of [...new Set([...enPromo, ...promoIds, ...muestraIds])].slice(0, 6)) {
      out.push({ id, ...(await sondar(ml, `/seller-promotions/items/${id}?${V2}`, {}, j => lista(j).map(p => elegir(p, ['id', 'type', 'status', 'name', 'price', 'original_price', 'offer_id', 'start_date', 'finish_date', 'end_date', 'min_discounted_price', 'max_discounted_price', 'suggested_discounted_price', 'min_stock', 'max_stock', 'meli_percentage', 'seller_percentage'])))) });
    }
    return out;
  });

  // 3. Precio que ve el comprador y competencia
  await seccion('sale_price', async () => {
    const out = [];
    for (const id of [...new Set([...enPromo, ...conDeal, ...muestraIds])].slice(0, 5)) {
      out.push({ id, sin_context: await sondar(ml, `/items/${id}/sale_price`, {}, j => j), marketplace: await sondar(ml, `/items/${id}/sale_price?context=channel_marketplace`, {}, j => j) });
    }
    return out;
  });
  await seccion('price_to_win', async () => {
    const out = [];
    for (const id of muestraIds) {
      out.push({ id, catalogo: catalogo.some(i => i.id === id), ...(await sondar(ml, `/items/${id}/price_to_win?version=v2`, {}, j => ({
        status: j?.status, price_to_win: j?.price_to_win ?? null, current_price: j?.current_price ?? null, winner_price: j?.winner?.price ?? null,
        reason: j?.reason ?? null, boosts: (j?.boosts ?? []).map(b => `${b?.id}:${b?.status}`), competitors_sharing: j?.competitors_sharing_first_place ?? null, visit_share: j?.visit_share ?? null,
      }))) });
    }
    return out;
  });

  // 5. Ventas (solo cantidades y forma) y visitas (solo forma)
  await seccion('orders_search', async () => {
    const desde = `${hace7}T00:00:00.000-03:00`, hasta = `${hoy}T23:59:59.999-03:00`;
    const r = await ml.sonda(`/orders/search?seller=${CUENTA.sellerId}&order.date_created.from=${encodeURIComponent(desde)}&order.date_created.to=${encodeURIComponent(hasta)}&sort=date_desc&limit=1`);
    const primera = r.json?.results?.[0];
    const viejo = await ml.sonda(`/orders/search?seller=${CUENTA.sellerId}&order.date_created.from=${encodeURIComponent(fechaCorrida(-365) + 'T00:00:00.000-03:00')}&order.date_created.to=${encodeURIComponent(fechaCorrida(-335) + 'T23:59:59.999-03:00')}&limit=1`);
    return { ultimos_7_dias: { http: r.status, total: r.json?.paging?.total ?? null, forma_orden: forma(primera), forma_item: forma(primera?.order_items?.[0]?.item) }, hace_11_a_12_meses: { http: viejo.status, total: viejo.json?.paging?.total ?? null } };
  });
  await seccion('visitas', async () => ({
    items_visits_150d: await sondar(ml, `/users/${CUENTA.sellerId}/items_visits?date_from=${hace150}&date_to=${hoy}`),
    item_time_window_30d: muestraIds[0] ? await sondar(ml, `/items/${muestraIds[0]}/visits/time_window?last=30&unit=day`) : { omitido: 'sin item' },
    item_time_window_150d: muestraIds[0] ? await sondar(ml, `/items/${muestraIds[0]}/visits/time_window?last=150&unit=day`) : { omitido: 'sin item' },
  }));

  // 6. Product Ads (solo lectura; solo formas, nunca valores)
  let advertiser = null;
  await seccion('ads_advertisers', async () => {
    const r = await ml.sonda('/advertising/advertisers?product_id=PADS', ADS(1));
    const advs = Array.isArray(r.json?.advertisers) ? r.json.advertisers : [];
    advertiser = advs.find(a => a?.site_id === SITE_ID) ?? advs[0] ?? null;
    return { http: r.status, forma: forma(r.json), cantidad: advs.length, sites: advs.map(a => a?.site_id), ...(r.ok ? {} : { detalle: detalle(r.json) }) };
  });
  if (advertiser?.advertiser_id) {
    const adv = advertiser.advertiser_id, site = advertiser.site_id ?? SITE_ID;
    const metricas = 'clicks,prints,ctr,cost,cpc,acos,roas,units_quantity,direct_units_quantity,indirect_units_quantity,direct_amount,indirect_amount,total_amount';
    const rango = `date_from=${hace7}&date_to=${hoy}`;
    // Prueba cada candidata y devuelve la primera que responde 200 (con todos los códigos).
    async function candidatas(lista) {
      const out = {}; let ganadora = null;
      for (const [nombre, path, v] of lista) {
        const r = await ml.sonda(path, ADS(v));
        const res = lista2(r.json);
        out[nombre] = { http: r.status, api_version: v, path: tapar(path), forma: forma(r.json), ...(res.length ? { cantidad: res.length } : {}), ...(r.ok ? {} : { detalle: detalle(r.json) }) };
        if (r.ok && !ganadora) ganadora = { nombre, json: r.json, res };
      }
      return { out, ganadora };
    }
    const lista2 = j => Array.isArray(j) ? j : Array.isArray(j?.results) ? j.results : Array.isArray(j?.campaigns) ? j.campaigns : Array.isArray(j?.ad_groups) ? j.ad_groups : Array.isArray(j?.ads) ? j.ads : [];
    let campanias = [], campaniaId = null;
    await seccion('ads_campanias', async () => {
      const base = `/advertising/advertisers/${adv}/product_ads/campaigns`;
      const { out, ganadora } = await candidatas([
        ['adv_v2_metricas', `${base}?limit=50&offset=0&${rango}&metrics=${metricas}&metrics_summary=true`, 2],
        ['adv_v2', `${base}?limit=50&offset=0`, 2],
        ['adv_v1', `${base}?limit=50&offset=0`, 1],
        ['adv_search_v2', `${base}/search?limit=50&offset=0&${rango}&metrics=${metricas}`, 2],
        ['site_v1_viejo', `/advertising/${site}/product_ads/campaigns?limit=50&offset=0`, 1],
        ['site_v2_viejo', `/advertising/${site}/product_ads/campaigns?limit=50&offset=0`, 2],
      ]);
      campanias = ganadora?.res ?? [];
      const activa = campanias.find(c => String(c?.status).toLowerCase() === 'active') ?? campanias[0];
      campaniaId = activa?.id ?? activa?.campaign_id ?? null;
      return { ...out, ganadora: ganadora?.nombre ?? null, campanias: campanias.slice(0, 10).map(c => ({ id: mascara(c?.id ?? c?.campaign_id), status: c?.status, strategy: c?.strategy ?? c?.strategy_type ?? null, campos: Object.keys(c ?? {}), metricas: Object.keys(c?.metrics ?? {}) })) };
    });
    if (campaniaId) {
      let adGroupId = null;
      await seccion('ads_campania_detalle', async () => {
        const { out } = await candidatas([
          ['adv_detalle_v2', `/advertising/advertisers/${adv}/product_ads/campaigns/${campaniaId}?${rango}&metrics=${metricas},lost_impression_share_by_budget,lost_impression_share_by_ad_rank`, 2],
          ['detalle_v2', `/advertising/product_ads/campaigns/${campaniaId}?${rango}&metrics=${metricas}`, 2],
          ['adv_detalle_diario_v2', `/advertising/advertisers/${adv}/product_ads/campaigns/${campaniaId}?${rango}&metrics=clicks,cost,direct_amount,indirect_amount,units_quantity&aggregation_type=DAILY`, 2],
          ['adv_metrics_diario_v2', `/advertising/advertisers/${adv}/product_ads/campaigns/${campaniaId}/metrics?${rango}&metrics=clicks,cost&aggregation_type=DAILY`, 2],
          ['adv_detalle_v1', `/advertising/advertisers/${adv}/product_ads/campaigns/${campaniaId}?${rango}&metrics=clicks,cost`, 1],
        ]);
        return out;
      });
      await seccion('ads_ad_groups', async () => {
        const mlu = muestraIds[0] ?? '';
        const { out, ganadora } = await candidatas([
          ['adv_ad_groups_search_campania', `/advertising/advertisers/${adv}/product_ads/ad_groups/search?limit=50&offset=0&${rango}&metrics=clicks,cost,direct_amount,indirect_amount,units_quantity&filters[campaign_id]=${campaniaId}`, 2],
          ['adv_ad_groups_search', `/advertising/advertisers/${adv}/product_ads/ad_groups/search?limit=5&offset=0`, 2],
          ['adv_ad_groups', `/advertising/advertisers/${adv}/product_ads/ad_groups?limit=5&offset=0&campaign_id=${campaniaId}`, 2],
          ['adv_campania_ad_groups', `/advertising/advertisers/${adv}/product_ads/campaigns/${campaniaId}/ad_groups?limit=5&offset=0`, 2],
          ['adv_ads_search_campania', `/advertising/advertisers/${adv}/product_ads/ads/search?limit=5&offset=0&${rango}&metrics=clicks,cost&filters[campaign_id]=${campaniaId}`, 2],
          ['adv_ads_search_item', `/advertising/advertisers/${adv}/product_ads/ads/search?limit=5&offset=0&filters[item_ids]=${mlu}`, 2],
          ['adv_ad_groups_search_item', `/advertising/advertisers/${adv}/product_ads/ad_groups/search?limit=5&offset=0&filters[item_ids]=${mlu}`, 2],
          ['adv_campania_items_v1', `/advertising/advertisers/${adv}/product_ads/campaigns/${campaniaId}/items?limit=5&offset=0`, 1],
        ]);
        const grupos = ganadora?.res ?? [];
        adGroupId = grupos[0]?.id ?? grupos[0]?.ad_group_id ?? null;
        const extra = { ganadora: ganadora?.nombre ?? null, grupos: grupos.slice(0, 5).map(g => ({ id: mascara(g?.id ?? g?.ad_group_id), status: g?.status, type: g?.type ?? g?.ad_group_type ?? null, external_id: g?.ad_group_external_id ? tapar(g.ad_group_external_id) : null, campos: Object.keys(g ?? {}), metricas: Object.keys(g?.metrics ?? {}) })) };
        if (adGroupId) {
          const { out: out2 } = await candidatas([
            ['adv_ad_group_diario_v2', `/advertising/advertisers/${adv}/product_ads/ad_groups/${adGroupId}?date_from=${hace30}&date_to=${hoy}&metrics=clicks,cost,direct_amount,indirect_amount,units_quantity&aggregation_type=DAILY`, 2],
            ['ad_group_diario_v2', `/advertising/product_ads/ad_groups/${adGroupId}?date_from=${hace30}&date_to=${hoy}&metrics=clicks,cost&aggregation_type=DAILY`, 2],
            ['adv_ad_group_metrics_diario_v2', `/advertising/advertisers/${adv}/product_ads/ad_groups/${adGroupId}/metrics?date_from=${hace30}&date_to=${hoy}&metrics=clicks,cost&aggregation_type=DAILY`, 2],
            ['adv_ad_groups_search_diario', `/advertising/advertisers/${adv}/product_ads/ad_groups/search?limit=5&offset=0&date_from=${hace30}&date_to=${hoy}&metrics=clicks,cost&aggregation_type=DAILY&filters[campaign_id]=${campaniaId}`, 2],
          ]);
          Object.assign(extra, { diario: out2 });
        }
        return { ...out, ...extra };
      });
    }
  }
  imprimir('estadisticas_cliente', ml.stats);
}

main().catch(e => { console.error('Sondeo cortado:', texto(e?.code ?? e?.message)); process.exit(1); });
