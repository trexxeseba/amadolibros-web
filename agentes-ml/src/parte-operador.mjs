// Parte del Operador MELI (pedido de Seba, 26/11/2026). SÓLO LECTURA: el cliente sólo hace GET.
//
//   node agentes-ml/src/parte-operador.mjs --salida DIR
//
// Completa lo que no trae el diagnóstico del día: descuento visible real de cada publicación activa
// (sale_price contra precio regular, libro o no libro), condiciones de precio de lo que no es libro
// (para ver Meli+), reputación, reclamos abiertos, catálogo y User Product, Envíos Flex y Mercado Ads
// por campaña y por anuncio (7 y 30 días, y los últimos 3 días uno por uno).
// El repo es público: el log sólo dice qué pasos terminaron. Los números van al archivo de salida.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CUENTA, fechaMontevideo } from './config.mjs';
import { crearCliente } from './ml.mjs';
import { fuenteTokenD1 } from '../../precio-ganador/src/token.mjs';
import { bulkItemsPath, bulkEntryItem } from '../../worker-sync/meli-bulk.js';

const DIA = 86400000;
const ADV = 51659, SITE = 'MLU', H = { headers: { 'Api-Version': '2' } };
const FANTASMA = '301999953';

// Descuento visible en % (función pura, exportada para el test).
export function pctVisible(regular, final) {
  const r = Number(regular), f = Number(final);
  if (!(r > 0) || !(f > 0) || f >= r) return 0;
  return Math.round((1 - f / r) * 1000) / 10;
}

// Tramos de descuento para contar.
export function tramo(p) { return p <= 0 ? '0' : p <= 16 ? '1-16' : p <= 20 ? '16-20' : p <= 26 ? '20-26' : p <= 30 ? '26-30' : '30+'; }

const fecha = off => fechaMontevideo(new Date(Date.now() + off * DIA));

async function main() {
  const args = process.argv.slice(2);
  const salida = args[args.indexOf('--salida') + 1] || '.';
  const ml = crearCliente(fuenteTokenD1(CUENTA), { intentos: 4, concurrencia: 6 });
  const yo = await ml.get('/users/me');
  if (String(yo?.id) !== CUENTA.sellerId) throw Object.assign(new Error('token_de_otra_cuenta'), { fatal: true });
  const S = CUENTA.sellerId;
  const out = { generado: new Date().toISOString(), hoy: fechaMontevideo(new Date()) };
  const paso = (n, f) => f().then(v => { out[n] = v; console.log('ok', n); }, e => { out[n] = { error: e?.status ?? e?.message }; console.log('fallo', n, e?.status ?? ''); });
  const sondas = async rutas => { const o = {}; for (const r of rutas) { const x = await ml.sonda(r); o[r.replace(S, '{S}')] = { status: x.status, json: x.ok ? x.json : (x.json ?? null) }; } return o; };

  // 1. Reputación y reclamos.
  await paso('reputacion', async () => { const u = await ml.get(`/users/${S}`); return { seller_reputation: u?.seller_reputation ?? null, status: u?.status ?? null, tags: u?.tags ?? null }; });
  await paso('reclamos', () => sondas([
    `/post-purchase/v1/claims/search?status=opened&limit=50`,
    `/post-purchase/v1/claims/search?status=opened&player_role=respondent&player_user_id=${S}&limit=50`,
    `/post-purchase/v1/claims/search?limit=50&sort=date_created:desc`,
  ]));
  await paso('flex_sondas', () => sondas([
    `/users/${S}/shipping_preferences`,
    `/shipping/flex/sites/${SITE}/users/${S}/subscriptions/v1`,
    `/flex/sites/${SITE}/users/${S}/subscriptions/v1`,
    `/users/${S}/shipping_modes`,
  ]));
  await paso('moderacion_sondas', () => sondas([
    `/moderations/infractions/${S}`,
    `/users/${S}/items/search?status=paused&sub_status=moderation_penalty&limit=1`,
    `/users/${S}/items/search?status=under_review&limit=50`,
    `/users/${S}/items/search?status=inactive&limit=50`,
  ]));

  // 2. Publicaciones activas y pausadas: dominio, catálogo, User Product, logística, etiquetas.
  const ids = async estado => { const o = []; let scroll = null; for (let i = 0; i < 300; i++) { const d = await ml.get(`/users/${S}/items/search?status=${estado}&search_type=scan&limit=100${scroll ? `&scroll_id=${encodeURIComponent(scroll)}` : ''}`); const r = d?.results ?? []; if (!r.length) break; o.push(...r); scroll = d?.scroll_id; if (!scroll) break; } return [...new Set(o)]; };
  const campos = 'id,title,price,original_price,base_price,available_quantity,status,sub_status,domain_id,category_id,catalog_listing,catalog_product_id,user_product_id,item_relations,shipping,tags,listing_type_id';
  const leer = async l => { const r = []; for (let i = 0; i < l.length; i += 20) { const d = await ml.get(bulkItemsPath(l.slice(i, i + 20), campos)); for (const e of Array.isArray(d) ? d : []) { const it = bulkEntryItem(e); if (it) r.push(it); } } return r; };
  let activas = [], pausadas = [];
  await paso('publicaciones', async () => {
    activas = await leer(await ids('active')); pausadas = await leer(await ids('paused'));
    const cuenta = (l, f) => { const o = {}; for (const x of l) for (const k of [].concat(f(x) ?? 'nada')) o[k] = (o[k] ?? 0) + 1; return Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 40)); };
    return {
      activas: activas.length, pausadas: pausadas.length,
      activas_libros: activas.filter(a => /-BOOKS$/i.test(a.domain_id ?? '')).length,
      activas_por_dominio: cuenta(activas, a => a.domain_id ?? 'sin_dominio'),
      activas_catalogo: activas.filter(a => a.catalog_listing).length,
      activas_con_user_product: activas.filter(a => a.user_product_id).length,
      activas_con_relaciones: activas.filter(a => a.item_relations?.length).length,
      activas_logistica: cuenta(activas, a => a.shipping?.logistic_type ?? 'sin_dato'),
      activas_modo_envio: cuenta(activas, a => a.shipping?.mode ?? 'sin_dato'),
      activas_etiquetas: cuenta(activas, a => a.tags ?? []),
      activas_etiquetas_envio: cuenta(activas, a => a.shipping?.tags ?? []),
      pausadas_motivo: cuenta(pausadas, p => p.sub_status?.length ? p.sub_status : ['sin_motivo']),
      pausadas_etiquetas: cuenta(pausadas, p => p.tags ?? []),
      catalogo_detalle: activas.filter(a => a.catalog_listing || a.item_relations?.length).map(a => ({ id: a.id, titulo: a.title, catalogo: !!a.catalog_listing, producto: a.catalog_product_id ?? null, up: a.user_product_id ?? null, relaciones: a.item_relations ?? null, precio: a.price, stock: a.available_quantity })),
    };
  });

  // 3. Descuento visible real de cada activa (sale_price) y por qué promo.
  await paso('descuentos', async () => {
    const filas = [];
    await Promise.all(activas.map(async a => {
      const r = await ml.sonda(`/items/${a.id}/sale_price?context=channel_marketplace`);
      const j = r.ok ? r.json : null;
      const regular = j?.regular_amount ?? a.original_price ?? a.price, final = j?.amount ?? a.price;
      filas.push({ id: a.id, titulo: a.title, libro: /-BOOKS$/i.test(a.domain_id ?? ''), dominio: a.domain_id ?? null, regular, final, pct: pctVisible(regular, final), tipo: j?.metadata?.promotion_type ?? null, promo: j?.metadata?.promotion_id ?? j?.metadata?.campaign_id ?? null, http: r.status });
    }));
    const resumen = {};
    for (const f of filas) { const k = `${f.libro ? 'libro' : 'no_libro'} ${tramo(f.pct)}`; resumen[k] = (resumen[k] ?? 0) + 1; }
    const porTipo = {}; for (const f of filas) if (f.pct > 0) { const k = `${f.libro ? 'libro' : 'no_libro'} ${f.tipo ?? 'sin_tipo'} ${tramo(f.pct)}`; porTipo[k] = (porTipo[k] ?? 0) + 1; }
    return { leidas: filas.length, fallidas: filas.filter(f => f.http !== 200).length, resumen, por_tipo: porTipo, mas_de_16_libro: filas.filter(f => f.libro && f.pct > 16).length, mas_de_20_no_libro: filas.filter(f => !f.libro && f.pct > 20).length, mas_de_30: filas.filter(f => f.pct > 30), filas };
  });

  // 4. Condiciones de precio de lo que no es libro (Meli+ / audiencias) y una muestra de libros.
  await paso('precios_no_libro', async () => {
    const noLibros = activas.filter(a => !/-BOOKS$/i.test(a.domain_id ?? ''));
    const muestraLibros = activas.filter(a => /-BOOKS$/i.test(a.domain_id ?? '')).slice(0, 150);
    const leerPrecios = async l => { const o = []; await Promise.all(l.map(async a => { const r = await ml.sonda(`/items/${a.id}/prices`); o.push({ id: a.id, titulo: a.title, http: r.status, precios: r.ok ? (r.json?.prices ?? []).map(p => ({ tipo: p.type, monto: p.amount, regular: p.regular_amount, condiciones: p.conditions ?? null, metadata: p.metadata ?? null })) : null }); })); return o; };
    const nl = await leerPrecios(noLibros), ml_ = await leerPrecios(muestraLibros);
    const condiciones = l => { const o = {}; for (const x of l) for (const p of x.precios ?? []) { const k = JSON.stringify({ tipo: p.tipo, ctx: p.condiciones?.context_restrictions ?? null, aud: p.condiciones?.eligible ?? p.condiciones?.audience ?? null, promo: p.metadata?.promotion_type ?? null }); o[k] = (o[k] ?? 0) + 1; } return o; };
    return { no_libros: noLibros.length, condiciones_no_libro: condiciones(nl), condiciones_muestra_libros: condiciones(ml_), detalle_no_libro: nl };
  });

  // 5. Catálogo: precio para ganar en las de catálogo.
  await paso('catalogo_price_to_win', async () => {
    const cat = activas.filter(a => a.catalog_listing).slice(0, 400);
    const o = []; await Promise.all(cat.map(async a => { const r = await ml.sonda(`/items/${a.id}/price_to_win?siteId=${SITE}&version=v2`); o.push({ id: a.id, http: r.status, status: r.json?.status ?? null, precio_para_ganar: r.json?.price_to_win ?? null, precio: r.json?.current_price ?? a.price, competidores: r.json?.competitors_sharing_first_place ?? null, razones: r.json?.reason ?? null }); }));
    const est = {}; for (const x of o) { const k = x.http === 200 ? (x.status ?? 'sin_estado') : `http_${x.http}`; est[k] = (est[k] ?? 0) + 1; }
    return { leidas: o.length, por_estado: est, detalle: o };
  });

  // 6. Mercado Ads: campañas y anuncios con métricas.
  const METRICAS = 'clicks,prints,cost,cpc,units_quantity,direct_units_quantity,indirect_units_quantity,direct_amount,indirect_amount,total_amount,roas,acos';
  const base = `/advertising/${SITE}/advertisers/${ADV}/product_ads`;
  const campanias = async (desde, hasta) => { const o = []; for (let off = 0; off < 500; off += 50) { const r = await ml.sonda(`${base}/campaigns/search?limit=50&offset=${off}&date_from=${desde}&date_to=${hasta}&metrics=${METRICAS}`, H); if (!r.ok) return { http: r.status, error: r.json ?? null }; o.push(...(r.json?.results ?? [])); if ((r.json?.results ?? []).length < 50) break; } return o; };
  const grupos = async (desde, hasta, estado) => { const o = []; for (let off = 0; off < 9950; off += 50) { const r = await ml.sonda(`${base}/ad_groups/search?limit=50&offset=${off}&date_from=${desde}&date_to=${hasta}&metrics=${METRICAS}&filters[statuses]=${estado}`, H); if (!r.ok) return { http: r.status, error: r.json ?? null }; for (const g of r.json?.results ?? []) if (String(g.campaign_id) !== FANTASMA) o.push({ id: g.id, item: g.ad_group_external_id ?? null, titulo: g.title ?? null, campania: g.campaign_id, estado: g.status, m: g.metrics ?? {} }); if ((r.json?.results ?? []).length < 50) break; } return o; };
  await paso('ads', async () => {
    const hoy = fecha(0);
    const c7 = await campanias(fecha(-7), hoy), c30 = await campanias(fecha(-30), hoy);
    const g30 = await grupos(fecha(-30), hoy, 'active'), g7 = await grupos(fecha(-7), hoy, 'active');
    const dias = {}; for (const d of [-1, -2, -3]) dias[fecha(d)] = await grupos(fecha(d), fecha(d), 'active');
    return { campanias_7d: c7, campanias_30d: c30, grupos_activos_30d: g30, grupos_activos_7d: g7, grupos_activos_por_dia: dias };
  });

  mkdirSync(salida, { recursive: true });
  writeFileSync(join(salida, 'parte-operador.json'), JSON.stringify(out));
  console.log('Parte guardado');
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) main().catch(e => { console.error('parte:', e?.code ?? e?.message); process.exit(1); });
