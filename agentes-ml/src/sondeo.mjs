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
    // Filtro catalog_listing del search: si responde, trae publicaciones de catálogo para price_to_win.
    const c = await ml.sonda(`/users/${CUENTA.sellerId}/items/search?status=active&catalog_listing=true&limit=50`);
    const idsCatalogo = lista(c.json);
    ids = [...idsCatalogo.slice(0, 20), ...ids];
    return { http: r.status, forma: forma(r.json), total: r.json?.paging?.total ?? null, con_scroll_id: typeof r.json?.scroll_id === 'string', paginas, ids_leidos: ids.length,
      filtro_catalog_listing: { http: c.status, total: c.json?.paging?.total ?? null, cantidad: idsCatalogo.length, ...(c.ok ? {} : { detalle: detalle(c.json) }) } };
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
    // Rutas de la documentación "Product Ads para Catálogo y User Products (lectura)":
    // siempre con el site en el path, header api-version: 2, búsquedas con /search.
    const adv = advertiser.advertiser_id, site = advertiser.site_id ?? SITE_ID;
    const metricas = 'clicks,prints,ctr,cost,cpc,acos,roas,cvr,sov,units_quantity,direct_units_quantity,indirect_units_quantity,direct_amount,indirect_amount,total_amount,organic_units_quantity,advertising_items_quantity';
    const rango7 = `date_from=${hace7}&date_to=${hoy}`, rango30 = `date_from=${hace30}&date_to=${hoy}`;
    const lista2 = j => Array.isArray(j) ? j : Array.isArray(j?.results) ? j.results : [];
    // Prueba cada candidata y se queda con la primera que responde 200 (informa todos los códigos).
    async function candidatas(lista) {
      const out = {}; let ganadora = null;
      for (const [nombre, path, v = 2] of lista) {
        const r = await ml.sonda(path, ADS(v));
        const res = lista2(r.json);
        out[nombre] = { http: r.status, api_version: v, path: tapar(path), forma: forma(r.json), ...(res.length ? { cantidad: res.length } : {}), ...(r.ok ? {} : { detalle: detalle(r.json) }) };
        if (r.ok && !ganadora) ganadora = { nombre, json: r.json, res };
      }
      return { out, ganadora };
    }
    const resumenCampania = c => ({ id: mascara(c?.id ?? c?.campaign_id), status: c?.status, strategy: c?.strategy ?? null, channel: c?.channel ?? null, tiene: { budget: c?.budget !== undefined, roas_target: c?.roas_target !== undefined, acos_target: c?.acos_target !== undefined, date_created: c?.date_created !== undefined, last_updated: c?.last_updated !== undefined }, campos: Object.keys(c ?? {}), metricas: Object.keys(c?.metrics ?? {}) });
    let campanias = [], campaniaId = null;
    await seccion('ads_campanias', async () => {
      const base = `/advertising/${site}/advertisers/${adv}/product_ads/campaigns/search`;
      const { out, ganadora } = await candidatas([
        ['search', `${base}?limit=50&offset=0`],
        ['search_activas', `${base}?limit=50&offset=0&filters[status]=active`],
        ['search_metricas_resumen', `${base}?limit=50&offset=0&${rango30}&metrics=${metricas}&metrics_summary=true`],
        ['search_diario', `${base}?limit=2&offset=0&${rango7}&metrics=clicks,cost,direct_amount,indirect_amount,units_quantity&aggregation_type=DAILY`],
      ]);
      campanias = ganadora?.res ?? [];
      const activa = campanias.find(c => String(c?.status).toLowerCase() === 'active') ?? campanias[0];
      campaniaId = activa?.id ?? activa?.campaign_id ?? null;
      return { ...out, ganadora: ganadora?.nombre ?? null, total: ganadora?.json?.paging?.total ?? null, campanias: campanias.slice(0, 12).map(resumenCampania), metrics_summary_claves: Object.keys(ganadora?.json?.metrics_summary ?? {}) };
    });
    if (campaniaId) {
      let adGroupId = null;
      await seccion('ads_campania_detalle', async () => {
        const base = `/advertising/${site}/product_ads/campaigns/${campaniaId}`;
        const { out } = await candidatas([
          ['detalle_30d', `${base}?${rango30}&metrics=${metricas},impression_share,top_impression_share,lost_impression_share_by_budget,lost_impression_share_by_ad_rank,acos_benchmark`],
          ['detalle_diario_7d', `${base}?${rango7}&metrics=clicks,cost,direct_amount,indirect_amount,units_quantity&aggregation_type=DAILY`],
        ]);
        return out;
      });
      await seccion('ads_ad_groups', async () => {
        const mlu = muestraIds[0] ?? '';
        const base = `/advertising/${site}/advertisers/${adv}/product_ads`;
        const { out, ganadora } = await candidatas([
          ['ad_groups_search_campania_30d', `${base}/ad_groups/search?limit=50&offset=0&${rango30}&sort=desc&sort_by=clicks&metrics=CLICKS,PRINTS,COST,CPC,CTR,DIRECT_AMOUNT,INDIRECT_AMOUNT,TOTAL_AMOUNT,DIRECT_UNITS_QUANTITY,INDIRECT_UNITS_QUANTITY,UNITS_QUANTITY&filters[campaign_id]=${campaniaId}`],
          ['ad_groups_search_todos', `${base}/ad_groups/search?limit=5&offset=0&${rango30}&metrics=CLICKS,COST,UNITS_QUANTITY`],
          ['ads_search_campania', `${base}/ads/search?limit=5&offset=0&${rango30}&metrics=clicks,cost,units_quantity,direct_amount,indirect_amount&filters[campaign_id]=${campaniaId}`],
          ['ads_search_item_ids', `${base}/ads/search?limit=5&offset=0&filters[item_ids]=${mlu}`],
          ['ads_search_item_id', `${base}/ads/search?limit=5&offset=0&filters[item_id]=${mlu}`],
          ['campania_ads_metrics_7d', `${base}/campaigns/${campaniaId}/ads/metrics?${rango7}&metrics=clicks,prints,cost,direct_amount,indirect_amount,units_quantity`],
        ]);
        const grupos = ganadora?.res ?? [];
        adGroupId = grupos[0]?.id ?? grupos[0]?.ad_group_id ?? null;
        const extra = { ganadora: ganadora?.nombre ?? null, total: ganadora?.json?.paging?.total ?? null, grupos: grupos.slice(0, 5).map(g => ({ id: mascara(g?.id ?? g?.ad_group_id), status: g?.status, type: g?.type ?? g?.ad_group_type ?? null, external_id: g?.ad_group_external_id ? tapar(g.ad_group_external_id) : null, campos: Object.keys(g ?? {}), metricas: Object.keys(g?.metrics ?? {}) })) };
        if (adGroupId) {
          const { out: out2 } = await candidatas([
            ['ad_group_detalle_30d', `/advertising/${site}/product_ads/ad_groups/${adGroupId}?${rango30}&metrics=CLICKS,PRINTS,COST,CPC,CTR,DIRECT_AMOUNT,INDIRECT_AMOUNT,TOTAL_AMOUNT,DIRECT_UNITS_QUANTITY,INDIRECT_UNITS_QUANTITY,UNITS_QUANTITY`],
            ['ad_group_diario_30d', `/advertising/${site}/product_ads/ad_groups/${adGroupId}?${rango30}&metrics=CLICKS,COST,DIRECT_AMOUNT,INDIRECT_AMOUNT,UNITS_QUANTITY&aggregation_type=daily`],
            ['ad_group_diario_30d_MAYUS', `/advertising/${site}/product_ads/ad_groups/${adGroupId}?${rango30}&metrics=CLICKS,COST,UNITS_QUANTITY&aggregation_type=DAILY`],
            ['ad_groups_search_diario', `${base}/ad_groups/search?limit=2&offset=0&${rango7}&metrics=CLICKS,COST,UNITS_QUANTITY&aggregation_type=DAILY&filters[campaign_id]=${campaniaId}`],
            ['ad_group_ads_30d', `/advertising/${site}/product_ads/ad_groups/${adGroupId}/ads?${rango30}&metrics=clicks,cost,units_quantity,direct_amount,indirect_amount`],
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
