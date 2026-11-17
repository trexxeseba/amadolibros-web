// Relevamiento de Mercado Ads de Amado Libros: ¿qué ventas trae de verdad cada anuncio?
//
//   node poda/src/relevamiento.mjs [--dias 30]
//
// Sólo LEE (Mercado Ads, precios y las órdenes de la tienda en D1) y manda el informe por
// mail. No toca anuncios ni el registro de la poda. Log público: sólo cantidades.
//
// Para cada anuncio separa:
//   directas    compraron ESE libro después de hacer clic en el anuncio (lo que trae el anuncio)
//   indirectas  hicieron clic y compraron OTRO libro nuestro (suma, pero no es mérito del libro)
//   tienda      todas las órdenes del libro en la tienda (anuncio + orgánico)
//   orgánicas   tienda - directas: se vendieron sin pasar por el anuncio
//   antes       ventas por mes del libro en los 60 días previos a que existiera el anuncio
//               (sólo si el anuncio es nuevo): si ya vendía igual, el anuncio no agrega
//   deja        precio - comisión de ML (de las órdenes reales), antes del costo del libro y del envío
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
const pct = v => `${Math.round(v * 100)} %`;

// Clasificación de un anuncio (función pura; se testea).
export function clasificar(a, { maxCostoVenta = 0.20 } = {}) {
  if (a.gasto <= 0) return { clase: 'sin_gasto' };
  if (a.directas === 0) return { clase: a.indirectas > 0 ? 'solo_indirectas' : 'nada', motivo: a.indirectas > 0 ? 'Ninguna venta del libro por el anuncio; sólo otros libros después del clic.' : 'Ninguna venta por el anuncio.' };
  const porVenta = a.gasto / a.directas;
  const base = a.deja > 0 ? a.deja : a.precio;
  if (!base) return { clase: 'sin_precio', porVenta };
  const peso = porVenta / base;
  if (a.antesMes !== null && a.antesMes >= a.tiendaMes && a.tiendaMes > 0) return { clase: 'no_incremental', porVenta, peso, motivo: 'Ya vendía lo mismo o más antes del anuncio.' };
  if (peso > maxCostoVenta) return { clase: 'caro', porVenta, peso };
  return { clase: 'rinde', porVenta, peso };
}

async function main() {
  const dias = Number(process.argv[process.argv.indexOf('--dias') + 1]) || 30;
  const hoy = fechaMontevideo(), desde = fechaCorrida(-dias);
  const ml = crearCliente(fuenteTokenD1(CUENTA), { intentos: 4, concurrencia: 4 });
  const d1 = crearD1();
  const yo = await ml.get('/users/me');
  if (String(yo?.id) !== CUENTA.sellerId) throw new Error('token_de_otra_cuenta');

  // Anuncios con métricas del período (activos y pausados).
  const base = `/advertising/${SITE}/advertisers/${ADV}/product_ads`;
  const METRICAS = 'CLICKS,PRINTS,COST,DIRECT_UNITS_QUANTITY,INDIRECT_UNITS_QUANTITY,DIRECT_AMOUNT,INDIRECT_AMOUNT';
  const grupos = [];
  for (const estado of ['active', 'paused']) {
    for (let off = 0; off < 9950; off += 50) {
      const r = await ml.get(`${base}/ad_groups/search?limit=50&offset=${off}&date_from=${desde}&date_to=${hoy}&metrics=${METRICAS}&filters[statuses]=${estado}`, H);
      for (const g of r?.results ?? []) {
        if (String(g.campaign_id) === CAMPANIA_FANTASMA) continue;
        const m = g.metrics ?? {};
        grupos.push({ id: String(g.id), estado: String(g.status).toUpperCase(), titulo: g.title ?? '', tipo: g.ad_group_type, creado: g.date_created ?? null,
          item_ids: g.ad_group_type === 'ITEM' && g.ad_group_external_id ? [g.ad_group_external_id] : [],
          gasto: num(m.cost), clics: num(m.clicks), prints: num(m.prints), directas: num(m.direct_units_quantity), indirectas: num(m.indirect_units_quantity),
          montoDirecto: num(m.direct_amount), montoIndirecto: num(m.indirect_amount) });
      }
      if ((r?.results ?? []).length < 50) break;
    }
  }

  // Totales de la cuenta.
  const T = grupos.reduce((t, g) => ({ gasto: t.gasto + g.gasto, clics: t.clics + g.clics, directas: t.directas + g.directas, indirectas: t.indirectas + g.indirectas, montoDirecto: t.montoDirecto + g.montoDirecto, montoIndirecto: t.montoIndirecto + g.montoIndirecto }), { gasto: 0, clics: 0, directas: 0, indirectas: 0, montoDirecto: 0, montoIndirecto: 0 });
  const conGasto = grupos.filter(g => g.gasto > 0);
  const gastoSinDirecta = conGasto.filter(g => g.directas === 0).reduce((s, g) => s + g.gasto, 0);

  // Órdenes de la tienda: 150 días, con comisión, para orgánico, línea base y lo que deja.
  const desde150 = Date.now() - 150 * DIA, corte = Date.now() - dias * DIA;
  const filas = await d1.query(`SELECT i.item_id AS item, o.date_created_ms AS ms, i.quantity AS q, i.unit_price AS p, i.sale_fee AS fee FROM ml_sales_items i JOIN ml_sales_orders o ON o.order_id = i.order_id WHERE o.date_created_ms >= ${desde150} AND o.status != 'cancelled'`);
  const porItem = new Map();
  for (const f of filas) { const a = porItem.get(f.item) ?? []; a.push({ ms: num(f.ms), q: num(f.q) || 1, p: num(f.p), fee: num(f.fee) }); porItem.set(f.item, a); }

  // A fondo: los anuncios que gastaron $150 o más en el período.
  const fondo = conGasto.filter(g => g.gasto >= 150).sort((a, b) => b.gasto - a.gasto);
  for (const g of fondo) {
    try {
      if (!g.item_ids.length) {
        const a = await ml.get(`/advertising/${SITE}/product_ads/ad_groups/${g.id}/ads`, H);
        g.item_ids = (a?.results ?? []).map(x => x.item_id).filter(Boolean);
      }
      const precios = [];
      for (const it of g.item_ids.slice(0, 6)) { const sp = await ml.sonda(`/items/${it}/sale_price`); if (sp.ok && num(sp.json?.amount) > 0) precios.push(num(sp.json.amount)); }
      g.precio = precios.length ? Math.max(...precios) : null;
    } catch { g.precio = null; }
    const ords = g.item_ids.flatMap(it => porItem.get(it) ?? []);
    const enPeriodo = ords.filter(o => o.ms >= corte);
    g.tienda = enPeriodo.reduce((s, o) => s + o.q, 0);
    g.tiendaMes = g.tienda * 30 / dias;
    g.organicas = Math.max(0, g.tienda - g.directas);
    const conFee = enPeriodo.filter(o => o.p > 0);
    g.deja = conFee.length ? conFee.reduce((s, o) => s + (o.p - o.fee), 0) / conFee.length : (g.precio ? g.precio * 0.85 : 0);
    // Línea base: sólo si el anuncio nació hace menos de 90 días y hay 60 días de historia antes.
    const nacio = g.creado ? Date.parse(g.creado) : NaN;
    g.antesMes = Number.isFinite(nacio) && Date.now() - nacio < 90 * DIA && nacio - 60 * DIA >= desde150
      ? ords.filter(o => o.ms >= nacio - 60 * DIA && o.ms < nacio).reduce((s, o) => s + o.q, 0) / 2 : null;
    g.c = clasificar(g);
  }

  const grupoDe = clase => fondo.filter(g => g.c.clase === clase);
  const linea = g => `- ${g.titulo.slice(0, 60)} | ${g.estado === 'ACTIVE' ? 'activo' : 'pausado'} | precio ${g.precio ? $(g.precio) : '?'} | deja ${g.deja ? $(g.deja) : '?'} | gasto ${$(g.gasto)} | ${g.clics} clics | directas ${g.directas} | indirectas ${g.indirectas} | tienda ${g.tienda} (orgánicas ${g.organicas})${g.antesMes !== null ? ` | antes ${g.antesMes.toFixed(1)}/mes` : ''}${g.c.porVenta ? ` | ${$(g.c.porVenta)} por venta directa${g.c.peso ? ` = ${pct(g.c.peso)} de lo que deja` : ''}` : ''}`;
  const sec = (t, arr, nota = '') => arr.length ? [`${t} (${arr.length}, gasto ${$(arr.reduce((s, g) => s + g.gasto, 0))})${nota ? `\n${nota}` : ''}`, ...arr.map(linea), ''] : [];

  // Qué pausaría cada umbral, contando sólo ventas directas y sobre lo que deja.
  const umbrales = [0.15, 0.20, 0.25, 0.30].map(u => {
    const p = fondo.filter(g => g.estado === 'ACTIVE' && g.directas > 0 && g.deja > 0 && g.gasto / g.directas / g.deja > u);
    return `- ${pct(u)}: pausaría ${p.length} anuncios con venta, que gastaron ${$(p.reduce((s, g) => s + g.gasto, 0))}`;
  });

  const texto = [
    `Relevamiento de Mercado Ads, últimos ${dias} días (${desde} a ${hoy})`, '',
    'CUENTA',
    `- Gasto total: ${$(T.gasto)} en ${conGasto.length} anuncios con gasto (${T.clics} clics).`,
    `- Ventas directas (el libro del anuncio, después del clic): ${T.directas} unidades, ${$(T.montoDirecto)}. ACOS directo ${T.montoDirecto ? pct(T.gasto / T.montoDirecto) : '?'}.`,
    `- Ventas indirectas (otro libro después del clic): ${T.indirectas} unidades, ${$(T.montoIndirecto)}.`,
    `- Costo por venta directa: ${T.directas ? $(T.gasto / T.directas) : '?'}.`,
    `- Gasto en anuncios SIN ninguna venta directa: ${$(gastoSinDirecta)} (${T.gasto ? pct(gastoSinDirecta / T.gasto) : '?'} del total).`, '',
    'QUÉ PAUSARÍA CADA UMBRAL (costo por venta directa sobre lo que deja la venta después de la comisión)', ...umbrales, '',
    `DETALLE DE LOS ${fondo.length} ANUNCIOS QUE GASTARON $150 O MÁS`, '',
    ...sec('CARO: venden por el anuncio, pero cada venta cuesta más del 20 % de lo que deja', grupoDe('caro')),
    ...sec('NO INCREMENTAL: el libro ya vendía lo mismo o más antes del anuncio', grupoDe('no_incremental')),
    ...sec('SOLO INDIRECTAS: el libro no se vendió por el anuncio; compraron otra cosa', grupoDe('solo_indirectas')),
    ...sec('NADA: ninguna venta por el anuncio', grupoDe('nada')),
    ...sec('SIN PRECIO LEGIBLE', grupoDe('sin_precio')),
    ...sec('RINDE: venden por el anuncio a un costo razonable', grupoDe('rinde')),
    'Notas: "tienda" son todas las órdenes del libro (anuncio + orgánico). "Deja" es el precio menos la comisión de Mercado Libre en las órdenes reales; no descuenta el costo del libro ni el envío. "Antes" sólo aparece si el anuncio tiene menos de 90 días.',
  ].join('\n');

  const mail = await enviarMail({ asunto: `Relevamiento Mercado Ads ${hoy}`, texto });
  console.log(`Relevamiento: ${grupos.length} anuncios, ${conGasto.length} con gasto, ${fondo.length} a fondo. Clases: ${['caro', 'no_incremental', 'solo_indirectas', 'nada', 'sin_precio', 'rinde'].map(c => `${c} ${grupoDe(c).length}`).join(', ')}. Mail: ${mail.ok ? 'ok' : mail.motivo}.`);
  if (!mail.ok) process.exit(1);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) main().catch(e => { console.error(`Relevamiento fallido: ${e.code ?? e.message}${e.status ? ` HTTP ${e.status}` : ''}`); process.exit(1); });
