// Promociones de Amado Libros por API, por título (Job A de agentes-ml).
//
//   ACCION=estado    ITEM=MLU...                      lee promos de la cuenta y de una publicación
//   ACCION=sumar     ITEM=MLU... PROMOCION="Amado 15" [PRECIO=2090] [PEDIDO_SEBA=true]
//   ACCION=sacar     ITEM=MLU... PROMOCION="Amado 15"
//   ACCION=seleccion [PROMOCION="Amado 15"] [DIAS_VENTAS=60] [LIMITE=50]   títulos con ventas y visitas
//   ACCION=ads-gasto                                  gasto de Product Ads del mes contra el tope
//
// Modo: AGENTES_ML_MODO=real escribe (sólo sumar y sacar); si no, prueba: muestra qué
// haría. Toda escritura pasa por evaluarEscritura; después de escribir se relee
// sale_price y, si el visible pasa del 16 %, se saca el ítem. Product Ads: sólo GET.
// El log de Actions es público: se imprimen ids, títulos, precios y promos propios
// (ya visibles en Mercado Libre); nunca unidades vendidas, visitas ni montos de Ads.
import { readFileSync, appendFileSync } from 'node:fs';
import { CUENTA, SITE_ID, fechaMontevideo, fechaCorrida } from './config.mjs';
import { crearCliente } from './ml.mjs';
import { texto, elegir, detalleError } from './sanear.mjs';
import { modoDeEscritura, evaluarEscritura, aplicarPedidoSeba, verificarPostEscritura, cuponVigente, evaluarGastoAds, LIMITES } from './guardas.mjs';
import { buscarPromo, entradaEnPromo, precioObjetivo, cuerpoPost, cuponesVigentes, unidadesPorItem, armarSeleccion, gastoDelMes, primerDiaDelMes, bucketPct, TIPOS_ESCRIBIBLES, TIPOS_PROHIBIDOS } from './promos-logica.mjs';
import { fuenteTokenD1 } from '../../precio-ganador/src/token.mjs';
import { bulkItemsPath, bulkEntryItem } from '../../worker-sync/meli-bulk.js';

const V2 = 'app_version=v2';
const ADS = version => ({ headers: { 'Api-Version': String(version) } });
const env = process.env;
const ACCION = String(env.ACCION ?? 'estado').trim();
const ITEM = String(env.ITEM ?? '').trim().toUpperCase().replace(/^#?(\d+)$/, 'MLU$1');
const PROMOCION = String(env.PROMOCION ?? 'Amado 15').trim();
const PRECIO = env.PRECIO ? Number(env.PRECIO) : null;
const PEDIDO_SEBA = String(env.PEDIDO_SEBA ?? '').toLowerCase() === 'true';
const DIAS_VENTAS = Math.min(180, Math.max(7, Number(env.DIAS_VENTAS) || 60));
const LIMITE = Math.min(200, Math.max(1, Number(env.LIMITE) || 50));
const modo = modoDeEscritura(env);
const config = JSON.parse(readFileSync(new URL('../config/exclusiones.json', import.meta.url), 'utf8'));
const ID_RE = /^MLU\d{6,15}$/;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const lista = j => Array.isArray(j) ? j : Array.isArray(j?.results) ? j.results : [];

const salida = {};
function imprimir(titulo, valor) { salida[titulo] = valor; console.log(`\n## ${titulo}\n` + JSON.stringify(valor, null, 1)); }
function resumen(md) { if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, md + '\n'); console.log(md); }
const fallo = (code, extra = {}) => { imprimir('resultado', { ok: false, error: code, ...extra }); process.exitCode = 1; };

const escribe = modo === 'real' && ['sumar', 'sacar'].includes(ACCION);
const ml = crearCliente(fuenteTokenD1(CUENTA), { intentos: 4, concurrencia: 4, soloLectura: !escribe });
const CAMPOS_ITEM = 'id,title,price,base_price,original_price,available_quantity,sold_quantity,status,sub_status,catalog_listing,catalog_product_id,date_created,last_updated,listing_type_id';

async function leerItems(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 20) {
    const d = await ml.get(bulkItemsPath(ids.slice(i, i + 20), CAMPOS_ITEM));
    for (const e of Array.isArray(d) ? d : []) { const it = bulkEntryItem(e); if (it) out.push(it); }
  }
  return out;
}
const leerItem = async id => (await leerItems([id]))[0] ?? null;
const leerSalePrice = id => ml.sonda(`/items/${id}/sale_price`).then(r => r.ok ? r.json : null);
const leerPromosCuenta = () => ml.get(`/seller-promotions/users/${CUENTA.sellerId}?${V2}`).then(lista);
const leerPromosItem = id => ml.sonda(`/seller-promotions/items/${id}?${V2}`).then(r => r.ok ? lista(r.json) : []);
const leerPtw = id => ml.sonda(`/items/${id}/price_to_win?version=v2`).then(r => r.ok ? r.json : { http: r.status });

// Cupones vigentes: el monto sale de los items de cada campaña de cupón (fixed_amount).
async function leerCupones(promos) {
  const montos = {};
  for (const p of promos.filter(p => p?.type === 'SELLER_COUPON_CAMPAIGN')) {
    const r = await ml.sonda(`/seller-promotions/promotions/${encodeURIComponent(p.id)}/items?promotion_type=SELLER_COUPON_CAMPAIGN&${V2}&limit=1`);
    const it = lista(r.json)[0];
    if (r.ok && it) montos[p.id] = { fixed_amount: it.fixed_amount ?? null };
  }
  return cuponesVigentes(promos, montos);
}
const resumenPromo = p => elegir(p, ['id', 'type', 'sub_type', 'status', 'name', 'start_date', 'finish_date', 'deadline_date']);
const resumenEntrada = e => elegir(e ?? {}, ['id', 'type', 'status', 'name', 'price', 'original_price', 'offer_id', 'min_discounted_price', 'max_discounted_price', 'suggested_discounted_price', 'meli_percentage', 'seller_percentage', 'start_date', 'finish_date', 'end_date', 'stock']);

async function fichaItem(id) {
  const [item, venta, promosItem, ptw] = await Promise.all([leerItem(id), leerSalePrice(id), leerPromosItem(id), leerPtw(id)]);
  return { item: item ? elegir(item, ['id', 'title', 'price', 'available_quantity', 'status', 'catalog_listing', 'date_created']) : null, itemCompleto: item, venta: venta ? elegir(venta, ['amount', 'regular_amount', 'currency_id', 'metadata']) : null, promos: promosItem.map(resumenEntrada), promosCrudas: promosItem, competencia: ptw ? { status: ptw.status ?? null, reason: ptw.reason ?? null, http: ptw.http ?? 200 } : null, ptw };
}

async function estado() {
  const promos = await leerPromosCuenta();
  imprimir('promociones_cuenta', { cantidad: promos.length, promociones: promos.map(resumenPromo) });
  if (ITEM) {
    if (!ID_RE.test(ITEM)) return fallo('item_invalido');
    const f = await fichaItem(ITEM);
    imprimir('publicacion', { item: f.item, precio_visible: f.venta, promos: f.promos, competencia: f.competencia });
    if (PROMOCION) {
      const b = buscarPromo(promos, PROMOCION);
      imprimir('promo_destino', b.promo ? { ...resumenPromo(b.promo), entrada_del_item: resumenEntrada(entradaEnPromo(f.promosCrudas, b.promo)) } : b);
    }
  }
  imprimir('resultado', { ok: true, modo, accion: ACCION });
}

async function sumar() {
  if (!ID_RE.test(ITEM)) return fallo('item_invalido');
  const promos = await leerPromosCuenta();
  const b = buscarPromo(promos, PROMOCION);
  if (!b.promo) return fallo('promo_' + b.error, { candidatas: b.candidatas ?? [] });
  const promo = b.promo;
  if (TIPOS_PROHIBIDOS.has(promo.type) || !TIPOS_ESCRIBIBLES.has(promo.type)) return fallo('tipo_no_permitido', { tipo: promo.type });
  const f = await fichaItem(ITEM);
  if (!f.itemCompleto) return fallo('item_no_leido');
  const entrada = entradaEnPromo(f.promosCrudas, promo);
  if (entrada && String(entrada.status).toLowerCase() === 'started') { imprimir('resultado', { ok: true, ya_estaba: true, promo: resumenPromo(promo), entrada: resumenEntrada(entrada) }); return; }
  const objetivo = precioObjetivo({ entrada, precioPedido: PRECIO, precioActual: f.itemCompleto.price });
  const cupones = await leerCupones(promos);
  const cupon = cuponVigente({ cuponesApi: cupones });
  imprimir('lectura', { promo: resumenPromo(promo), item: f.item, precio_visible: f.venta, entrada: resumenEntrada(entrada), objetivo, cupon, competencia: f.competencia, cupones_vigentes: cupones.filter(c => ['started', 'active'].includes(String(c.status).toLowerCase())).length });
  if (objetivo.error) return fallo('precio_' + objetivo.error, { min: objetivo.min ?? null, max: objetivo.max ?? null, fijo: objetivo.fijo ?? null });
  const ctx = { modo, ahora: new Date(), config, item: f.itemCompleto, venta: f.venta, promo: { id: promo.id, type: promo.type, name: promo.name, price: objetivo.precio, seller_percentage: entrada?.seller_percentage ?? null }, cupon, competencia: f.ptw };
  let r = evaluarEscritura(['SMART_LIGHTNING', 'LIGHTNING'].includes(promo.type) ? 'lightning' : 'unirse_promo', ctx);
  if (PEDIDO_SEBA) r = aplicarPedidoSeba(r);
  imprimir('guardas', { permitido: r.permitido, alerta: r.alerta, saltadas_por_pedido_de_seba: r.saltadas ?? [], fallas: r.fallas.map(x => ({ guarda: x.guarda, tipo: x.tipo, motivo: x.motivo })) });
  if (!r.permitido) { imprimir('resultado', { ok: false, modo, accion: ACCION, haria: modo !== 'real' ? cuerpoPost(promo, objetivo.precio, entrada) : null, frenado_por: r.fallas.map(x => x.guarda) }); if (r.alerta) process.exitCode = 1; return; }
  const body = cuerpoPost(promo, objetivo.precio, entrada);
  let post;
  try { post = await ml.post(`/seller-promotions/items/${ITEM}?${V2}`, body); }
  catch (e) { return fallo('post_fallo', { detalle: detalleError(e), body }); }
  imprimir('escritura', { body, respuesta: elegir(post ?? {}, ['id', 'type', 'status', 'price', 'original_price', 'start_date', 'finish_date', 'end_date', 'message']) });
  await sleep(8000);
  const [venta2, promos2] = await Promise.all([leerSalePrice(ITEM), leerPromosItem(ITEM)]);
  const despues = entradaEnPromo(promos2, promo);
  const check = verificarPostEscritura(venta2 ?? {});
  // Si la promo todavía no impacta en sale_price (pending), se juzga por el precio que se mandó.
  const regular = Number(venta2?.regular_amount ?? venta2?.amount ?? f.venta?.amount);
  const visibleEsperado = regular > 0 ? Math.round((1 - objetivo.precio / regular) * 10000) / 100 : null;
  imprimir('verificacion', { precio_visible: venta2 ? elegir(venta2, ['amount', 'regular_amount', 'metadata']) : null, entrada: resumenEntrada(despues), relectura: check, visible_esperado_pct: visibleEsperado });
  if (!check.ok || (visibleEsperado !== null && visibleEsperado > LIMITES.visibleMaxPct)) {
    let del = null;
    try { del = await ml.delete(`/seller-promotions/items/${ITEM}?promotion_type=${encodeURIComponent(promo.type)}&promotion_id=${encodeURIComponent(promo.id)}&${V2}`); } catch (e) { del = { error: detalleError(e) }; }
    return fallo('visible_alto_se_saco', { relectura: check, delete: del });
  }
  imprimir('resultado', { ok: true, modo, accion: ACCION, item: ITEM, promo: resumenPromo(promo), deal_price: objetivo.precio, visible_pct: check.visiblePct || visibleEsperado, estado_entrada: despues?.status ?? null });
}

async function sacar() {
  if (!ID_RE.test(ITEM)) return fallo('item_invalido');
  const promos = await leerPromosCuenta();
  const b = buscarPromo(promos, PROMOCION);
  if (!b.promo) return fallo('promo_' + b.error, { candidatas: b.candidatas ?? [] });
  const promo = b.promo;
  if (TIPOS_PROHIBIDOS.has(promo.type)) return fallo('tipo_no_permitido', { tipo: promo.type });
  const f = await fichaItem(ITEM);
  const entrada = entradaEnPromo(f.promosCrudas, promo);
  imprimir('lectura', { promo: resumenPromo(promo), item: f.item, precio_visible: f.venta, entrada: resumenEntrada(entrada) });
  if (!entrada || !['started', 'pending', 'scheduled'].includes(String(entrada.status).toLowerCase())) { imprimir('resultado', { ok: true, no_estaba: true }); return; }
  const r = evaluarEscritura('sacar_de_promo', { modo, item: f.itemCompleto, promo: { id: promo.id, type: promo.type, name: promo.name } });
  imprimir('guardas', { permitido: r.permitido, fallas: r.fallas.map(x => ({ guarda: x.guarda, tipo: x.tipo, motivo: x.motivo })) });
  if (!r.permitido) { imprimir('resultado', { ok: false, modo, frenado_por: r.fallas.map(x => x.guarda) }); if (r.alerta) process.exitCode = 1; return; }
  let del;
  try { del = await ml.delete(`/seller-promotions/items/${ITEM}?promotion_type=${encodeURIComponent(promo.type)}&promotion_id=${encodeURIComponent(promo.id)}&${V2}`); }
  catch (e) { return fallo('delete_fallo', { detalle: detalleError(e) }); }
  await sleep(5000);
  const despues = entradaEnPromo(await leerPromosItem(ITEM), promo);
  imprimir('resultado', { ok: true, modo, accion: ACCION, item: ITEM, promo: resumenPromo(promo), respuesta: elegir(del ?? {}, ['status', 'message']), estado_entrada: despues?.status ?? 'sin_entrada' });
}

async function seleccion() {
  const hoy = fechaMontevideo(), desde = fechaCorrida(-DIAS_VENTAS);
  const ordenes = [];
  for (let offset = 0, pagina = 0; pagina < 80; offset += 50, pagina++) {
    const d = await ml.get(`/orders/search?seller=${CUENTA.sellerId}&order.date_created.from=${encodeURIComponent(desde + 'T00:00:00.000-03:00')}&order.date_created.to=${encodeURIComponent(hoy + 'T23:59:59.999-03:00')}&sort=date_desc&limit=50&offset=${offset}`);
    const res = lista(d); ordenes.push(...res);
    if (res.length < 50 || offset + 50 >= Math.min(10000, Number(d?.paging?.total) || 0)) break;
  }
  const unidades = unidadesPorItem(ordenes);
  const ranking = [...unidades.entries()].sort((a, b) => b[1] - a[1]).slice(0, Math.max(150, LIMITE * 3)).map(([id]) => id);
  const items = await leerItems(ranking);
  const visitas = new Map();
  await Promise.all(items.map(async it => { const r = await ml.sonda(`/items/${it.id}/visits/time_window?last=30&unit=day`); if (r.ok) visitas.set(it.id, r.json?.total_visits ?? 0); }));
  const promos = await leerPromosCuenta();
  const b = buscarPromo(promos, PROMOCION);
  const enPromo = new Set();
  if (b.promo) {
    let cursor = null;
    for (let pagina = 0; pagina < 40; pagina++) {
      const q = new URLSearchParams({ promotion_type: b.promo.type, app_version: 'v2', limit: '50', status: 'started' });
      if (cursor) { q.set('search_after', cursor); q.set('searchAfter', cursor); }
      const r = await ml.sonda(`/seller-promotions/promotions/${encodeURIComponent(b.promo.id)}/items?${q}`);
      if (!r.ok) break;
      const its = lista(r.json); for (const it of its) if (it?.id) enPromo.add(it.id);
      const sig = r.json?.paging?.searchAfter ?? r.json?.paging?.search_after ?? null;
      if (!its.length || !sig || sig === cursor) break;
      cursor = sig;
    }
  }
  const sel = armarSeleccion({ items, unidades, visitas, config, enPromo, limite: LIMITE });
  // Log público: sin unidades ni visitas; el puntaje ordena.
  imprimir('seleccion', { ventana_dias: DIAS_VENTAS, ordenes_leidas: ordenes.length, publicaciones_con_ventas: unidades.size, leidas: items.length, candidatos: sel.candidatos, fuera: sel.fuera, promo_destino: b.promo ? resumenPromo(b.promo) : b, ya_en_promo: enPromo.size,
    titulos: sel.seleccion.map((s, i) => ({ n: i + 1, id: s.id, title: s.title, price: s.price, stock: s.available_quantity, catalogo: s.catalog_listing, puntaje: s.puntaje })) });
  resumen(`### Selección de ${sel.seleccion.length} títulos (${DIAS_VENTAS} días de ventas, ${hoy})\n\n| # | MLU | Título | Precio | Stock | Puntaje |\n|---|---|---|---|---|---|\n` + sel.seleccion.map((s, i) => `| ${i + 1} | ${s.id} | ${texto(s.title)} | ${s.price} | ${s.available_quantity} | ${s.puntaje} |`).join('\n'));
  imprimir('resultado', { ok: true, modo, accion: ACCION, seleccionados: sel.seleccion.length });
}

async function adsGasto() {
  const hoy = fechaMontevideo(), desde = primerDiaDelMes(hoy);
  const r = await ml.sonda('/advertising/advertisers?product_id=PADS', ADS(1));
  const advs = Array.isArray(r.json?.advertisers) ? r.json.advertisers : [];
  const adv = advs.find(a => a?.site_id === SITE_ID) ?? advs[0];
  if (!r.ok || !adv?.advertiser_id) return fallo('sin_anunciante', { http: r.status });
  const c = await ml.sonda(`/advertising/${adv.site_id ?? SITE_ID}/advertisers/${adv.advertiser_id}/product_ads/campaigns/search?limit=50&offset=0&date_from=${desde}&date_to=${hoy}&metrics=cost,clicks,units_quantity&metrics_summary=true`, ADS(2));
  if (!c.ok) return fallo('campanias_no_leidas', { http: c.status, detalle: texto(JSON.stringify(c.json ?? {}).slice(0, 200)) });
  const gasto = gastoDelMes(c.json);
  const ev = evaluarGastoAds(gasto);
  const camps = lista(c.json);
  // Log público: estado y franja del tope, nunca el monto.
  const publico = { periodo: `${desde} a ${hoy}`, campanias: camps.length, activas: camps.filter(x => String(x?.status).toLowerCase() === 'active').length, tope_mensual: ev.tope, estado: ev.estado, franja_del_tope: bucketPct(ev.pct), con_metrics_summary: c.json?.metrics_summary !== undefined };
  imprimir('ads_gasto_mes', publico);
  resumen(`### Product Ads, mes en curso (${desde} a ${hoy})\n\nEstado frente al tope de $${ev.tope}: **${ev.estado}** (franja ${bucketPct(ev.pct) ?? 'sin dato'}). Campañas: ${publico.campanias}, activas: ${publico.activas}.`);
  imprimir('resultado', { ok: ev.estado !== 'no_leido', modo, accion: ACCION, estado: ev.estado });
  if (ev.estado === 'no_leido') process.exitCode = 1;
}

async function main() {
  console.log(`Promos ${new Date().toISOString()} | accion=${ACCION} modo=${modo} escribe=${escribe} item=${ITEM || '-'} promocion="${texto(PROMOCION)}" precio=${PRECIO ?? '-'} pedido_seba=${PEDIDO_SEBA}`);
  const yo = await ml.get('/users/me');
  if (String(yo?.id) !== CUENTA.sellerId) throw Object.assign(new Error('token_de_otra_cuenta'), { fatal: true });
  const acciones = { estado, sumar, sacar, seleccion, 'ads-gasto': adsGasto };
  if (!acciones[ACCION]) return fallo('accion_desconocida', { acciones: Object.keys(acciones) });
  await acciones[ACCION]();
  imprimir('estadisticas_cliente', ml.stats);
}
main().catch(e => { console.error('Promos cortado:', texto(e?.code ?? e?.message), JSON.stringify(detalleError(e))); process.exit(1); });
