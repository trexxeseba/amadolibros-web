// Relevamiento por segmentos de Mercado Ads (Amado Libros): ¿dónde rinde la publicidad?
//
//   node poda/src/relevamiento-segmentos.mjs [--dias 30]
//
// Sólo LEE y manda el informe por mail. Log público: sólo cantidades.
// Corta el gasto de los últimos N días por: campaña, precio, demanda previa del libro
// (ventas en la tienda en los 120 días anteriores), ganador de catálogo, tipo de anuncio,
// costo por clic y antigüedad del anuncio. También compara contra el total de la tienda.
import { CUENTA, fechaMontevideo, fechaCorrida } from '../../agentes-ml/src/config.mjs';
import { crearCliente } from '../../agentes-ml/src/ml.mjs';
import { fuenteTokenD1 } from '../../precio-ganador/src/token.mjs';
import { crearD1 } from './d1.mjs';
import { enviarMail } from './mesa.mjs';

const ADV = 51659, SITE = 'MLU', H = { headers: { 'Api-Version': '2' } };
const CAMPANIA_FANTASMA = '301999953';
const DIA = 86400000;
const num = v => (v === null || v === undefined || !Number.isFinite(Number(v))) ? 0 : Number(v);
const $ = v => `$${Math.round(v).toLocaleString('es-UY')}`;
const pct = v => Number.isFinite(v) ? `${(v * 100).toFixed(v < 0.1 ? 1 : 0)} %` : '?';

export function agregar(lista) {
  const t = { n: lista.length, gasto: 0, clics: 0, directas: 0, indirectas: 0, montoDirecto: 0 };
  for (const g of lista) { t.gasto += g.gasto; t.clics += g.clics; t.directas += g.directas; t.indirectas += g.indirectas; t.montoDirecto += g.montoDirecto; }
  return t;
}
export function lineaSegmento(nombre, lista) {
  const t = agregar(lista);
  return `- ${nombre}: ${t.n} anuncios | gasto ${$(t.gasto)} | ${t.clics} clics | clic ${t.clics ? $(t.gasto / t.clics) : '?'} | directas ${t.directas} | indirectas ${t.indirectas} | 1 venta directa cada ${t.directas ? Math.round(t.clics / t.directas) : '∞'} clics | costo por venta directa ${t.directas ? $(t.gasto / t.directas) : 'sin ventas'} | gasto/venta directa ${t.montoDirecto ? pct(t.gasto / t.montoDirecto) : '?'}`;
}
const cortar = (lista, fn, orden) => {
  const m = new Map();
  for (const g of lista) { const k = fn(g); m.set(k, [...(m.get(k) ?? []), g]); }
  const claves = orden ?? [...m.keys()].sort((a, b) => agregar(m.get(b)).gasto - agregar(m.get(a)).gasto);
  return claves.filter(k => m.has(k)).map(k => lineaSegmento(k, m.get(k)));
};

async function enLotes(items, n, fn) { for (let i = 0; i < items.length; i += n) await Promise.all(items.slice(i, i + n).map(fn)); }

async function main() {
  const dias = Number(process.argv[process.argv.indexOf('--dias') + 1]) || 30;
  const hoy = fechaMontevideo(), desde = fechaCorrida(-dias);
  const ml = crearCliente(fuenteTokenD1(CUENTA), { intentos: 4, concurrencia: 4 });
  const d1 = crearD1();
  const yo = await ml.get('/users/me');
  if (String(yo?.id) !== CUENTA.sellerId) throw new Error('token_de_otra_cuenta');
  const base = `/advertising/${SITE}/advertisers/${ADV}/product_ads`;

  // Campañas con su configuración.
  const campanias = new Map();
  for (let off = 0; off <= 500; off += 50) {
    const r = await ml.get(`${base}/campaigns/search?limit=50&offset=${off}&date_from=${desde}&date_to=${hoy}&metrics=cost,clicks,direct_units_quantity,indirect_units_quantity,direct_amount`, H);
    for (const c of r?.results ?? []) campanias.set(String(c.id), c);
    if ((r?.results ?? []).length < 50) break;
  }

  // Anuncios (ad groups) con métricas.
  const METRICAS = 'CLICKS,PRINTS,COST,DIRECT_UNITS_QUANTITY,INDIRECT_UNITS_QUANTITY,DIRECT_AMOUNT,INDIRECT_AMOUNT';
  const todos = [];
  for (const estado of ['active', 'paused']) {
    for (let off = 0; off < 9950; off += 50) {
      const r = await ml.get(`${base}/ad_groups/search?limit=50&offset=${off}&date_from=${desde}&date_to=${hoy}&metrics=${METRICAS}&filters[statuses]=${estado}`, H);
      for (const g of r?.results ?? []) {
        if (String(g.campaign_id) === CAMPANIA_FANTASMA) continue;
        const m = g.metrics ?? {};
        todos.push({ id: String(g.id), estado: String(g.status).toUpperCase(), titulo: g.title ?? '', tipo: g.ad_group_type ?? '?', creado: g.date_created ?? null, campaign_id: String(g.campaign_id),
          item_ids: g.ad_group_type === 'ITEM' && g.ad_group_external_id ? [g.ad_group_external_id] : [],
          gasto: num(m.cost), clics: num(m.clicks), prints: num(m.prints), directas: num(m.direct_units_quantity), indirectas: num(m.indirect_units_quantity), montoDirecto: num(m.direct_amount) });
      }
      if ((r?.results ?? []).length < 50) break;
    }
  }
  const activos = todos.filter(g => g.estado === 'ACTIVE');
  const conGasto = todos.filter(g => g.gasto > 0);

  // Detalle de cada anuncio con gasto: publicaciones, precio, ganador de catálogo.
  let fallidos = 0;
  await enLotes(conGasto, 4, async g => {
    try {
      const a = await ml.get(`/advertising/${SITE}/product_ads/ad_groups/${g.id}/ads`, H);
      const ads = a?.results ?? [];
      if (!g.item_ids.length) g.item_ids = ads.map(x => x.item_id).filter(Boolean);
      const precios = ads.map(x => num(x.price)).filter(p => p > 0);
      g.precio = precios.length ? Math.max(...precios) : null;
      g.catalogo = ads.some(x => x.catalog_listing === true);
      g.ganador = ads.some(x => x.buy_box_winner === true);
    } catch { fallidos++; g.precio = null; }
  });

  // Órdenes de la tienda (150 días).
  const desde150 = Date.now() - 150 * DIA, corte = Date.now() - dias * DIA;
  const filas = await d1.query(`SELECT i.item_id AS item, o.date_created_ms AS ms, i.quantity AS q, i.unit_price AS p FROM ml_sales_items i JOIN ml_sales_orders o ON o.order_id = i.order_id WHERE o.date_created_ms >= ${desde150} AND o.status != 'cancelled'`);
  const porItem = new Map(); let primera = Infinity;
  const tienda = { unidades: 0, monto: 0, items: new Set() };
  for (const f of filas) {
    const o = { ms: num(f.ms), q: num(f.q) || 1, p: num(f.p) };
    primera = Math.min(primera, o.ms);
    porItem.set(f.item, [...(porItem.get(f.item) ?? []), o]);
    if (o.ms >= corte) { tienda.unidades += o.q; tienda.monto += o.q * o.p; tienda.items.add(f.item); }
  }
  for (const g of conGasto) {
    const ords = g.item_ids.flatMap(it => porItem.get(it) ?? []);
    g.antes = ords.filter(o => o.ms < corte).reduce((s, o) => s + o.q, 0);
    g.tienda = ords.filter(o => o.ms >= corte).reduce((s, o) => s + o.q, 0);
  }
  // Publicaciones que vendieron en el período y NO tienen anuncio con gasto.
  const itemsConAnuncio = new Set(conGasto.flatMap(g => g.item_ids));
  let unidadesSinAnuncio = 0;
  for (const [item, ords] of porItem) if (!itemsConAnuncio.has(item)) unidadesSinAnuncio += ords.filter(o => o.ms >= corte).reduce((s, o) => s + o.q, 0);

  const T = agregar(conGasto);
  const edad = g => { const d = g.creado ? (Date.now() - Date.parse(g.creado)) / DIA : NaN; return !Number.isFinite(d) ? 'sin fecha' : d < 30 ? 'menos de 30 días' : d < 90 ? '30 a 90 días' : 'más de 90 días'; };
  const tramoPrecio = g => g.precio === null ? 'sin precio' : g.precio < 1500 ? 'menos de $1.500' : g.precio < 2500 ? '$1.500 a $2.500' : g.precio < 4000 ? '$2.500 a $4.000' : '$4.000 o más';
  const tramoClic = g => { const c = g.clics ? g.gasto / g.clics : 0; return !g.clics ? 'sin clics' : c < 10 ? 'clic menor a $10' : c < 20 ? 'clic $10 a $20' : c < 35 ? 'clic $20 a $35' : 'clic $35 o más'; };
  const tramoGasto = g => g.gasto < 50 ? 'gastó menos de $50' : g.gasto < 150 ? 'gastó $50 a $150' : g.gasto < 400 ? 'gastó $150 a $400' : 'gastó $400 o más';

  const lineasCamp = [...campanias.values()].map(c => {
    const m = c.metrics ?? {}, propios = todos.filter(g => g.campaign_id === String(c.id));
    return { gasto: num(m.cost), txt: `- ${c.name} | ${c.status} | presupuesto ${c.budget ?? '?'} | estrategia ${c.strategy ?? '?'} | objetivo ROAS ${c.roas_target ?? '?'} / ACOS ${c.acos_target ?? '?'} | ${propios.filter(g => g.estado === 'ACTIVE').length} anuncios activos | gasto ${$(num(m.cost))} | ${num(m.clicks)} clics | directas ${num(m.direct_units_quantity)} | indirectas ${num(m.indirect_units_quantity)} | venta directa ${$(num(m.direct_amount))} | gasto/venta directa ${num(m.direct_amount) ? pct(num(m.cost) / num(m.direct_amount)) : 'sin ventas'}` };
  }).sort((a, b) => b.gasto - a.gasto).map(x => x.txt);

  const top = [...conGasto].sort((a, b) => b.gasto - a.gasto);
  const texto = [
    `Relevamiento por segmentos de Mercado Ads, últimos ${dias} días (${desde} a ${hoy})`, '',
    'LA TIENDA COMPLETA EN EL PERÍODO',
    `- Vendió ${tienda.unidades} unidades por ${$(tienda.monto)} en ${tienda.items.size} publicaciones distintas.`,
    `- Por anuncio (directas): ${T.directas} unidades = ${tienda.unidades ? pct(T.directas / tienda.unidades) : '?'} de las unidades.`,
    `- Unidades vendidas de publicaciones SIN anuncio con gasto: ${unidadesSinAnuncio}.`,
    `- Gasto en publicidad: ${$(T.gasto)} = ${tienda.monto ? pct(T.gasto / tienda.monto) : '?'} de toda la venta de la tienda.`,
    `- Historia de órdenes disponible desde ${Number.isFinite(primera) ? new Date(primera).toISOString().slice(0, 10) : '?'}.`, '',
    'LOS ANUNCIOS',
    `- Activos hoy: ${activos.length}. Con algún gasto en el período: ${conGasto.length}. Con alguna venta directa: ${conGasto.filter(g => g.directas > 0).length}.`,
    `- Los 10 que más gastaron suman ${$(top.slice(0, 10).reduce((s, g) => s + g.gasto, 0))}; los 50 primeros, ${$(top.slice(0, 50).reduce((s, g) => s + g.gasto, 0))}.`,
    lineaSegmento('TOTAL', conGasto), '',
    'POR CAMPAÑA', ...lineasCamp, '',
    'POR DEMANDA PREVIA (¿el libro se vendió en la tienda en los 120 días anteriores al período?)', ...cortar(conGasto, g => g.antes >= 2 ? 'vendió 2 o más antes' : g.antes === 1 ? 'vendió 1 antes' : 'no vendió antes', ['vendió 2 o más antes', 'vendió 1 antes', 'no vendió antes']), '',
    'POR CATÁLOGO', ...cortar(conGasto, g => g.catalogo ? (g.ganador ? 'catálogo, ganando' : 'catálogo, perdiendo') : 'publicación tradicional'), '',
    'POR PRECIO', ...cortar(conGasto, tramoPrecio, ['menos de $1.500', '$1.500 a $2.500', '$2.500 a $4.000', '$4.000 o más', 'sin precio']), '',
    'POR COSTO DEL CLIC', ...cortar(conGasto, tramoClic, ['clic menor a $10', 'clic $10 a $20', 'clic $20 a $35', 'clic $35 o más', 'sin clics']), '',
    'POR CUÁNTO GASTÓ CADA ANUNCIO', ...cortar(conGasto, tramoGasto, ['gastó menos de $50', 'gastó $50 a $150', 'gastó $150 a $400', 'gastó $400 o más']), '',
    'POR ANTIGÜEDAD DEL ANUNCIO', ...cortar(conGasto, edad, ['menos de 30 días', '30 a 90 días', 'más de 90 días', 'sin fecha']), '',
    'POR TIPO DE ANUNCIO', ...cortar(conGasto, g => g.tipo), '',
    'POR ESTADO HOY', ...cortar(conGasto, g => g.estado === 'ACTIVE' ? (String(campanias.get(g.campaign_id)?.status).toLowerCase() === 'active' ? 'activo' : 'activo en campaña pausada') : 'pausado'), '',
    'TODOS LOS ANUNCIOS CON VENTA DIRECTA',
    ...conGasto.filter(g => g.directas > 0).sort((a, b) => a.gasto / a.directas - b.gasto / b.directas).map(g => `- ${g.titulo.slice(0, 55)} | ${campanias.get(g.campaign_id)?.name ?? '?'} | precio ${g.precio ? $(g.precio) : '?'} | gasto ${$(g.gasto)} | ${g.clics} clics | directas ${g.directas} | ${$(g.gasto / g.directas)} por venta | antes ${g.antes} | ${g.catalogo ? (g.ganador ? 'catálogo ganando' : 'catálogo perdiendo') : 'tradicional'}`),
    '', `Lecturas de detalle fallidas: ${fallidos}.`,
  ].join('\n');

  const mail = await enviarMail({ asunto: `Relevamiento por segmentos Mercado Ads ${hoy}`, texto });
  console.log(`Segmentos: ${todos.length} anuncios, ${conGasto.length} con gasto, ${campanias.size} campañas, fallidos ${fallidos}. Mail: ${mail.ok ? 'ok' : mail.motivo}.`);
  if (!mail.ok) process.exit(1);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) main().catch(e => { console.error(`Segmentos fallido: ${e.code ?? e.message}${e.status ? ` HTTP ${e.status}` : ''}`); process.exit(1); });
