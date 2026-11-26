// Diagnóstico del día de Amado Libros en Mercado Libre (pedido de Seba, 26/11/2026). SÓLO LECTURA.
//
//   node agentes-ml/src/diagnostico-dia.mjs --salida DIR
//
// Junta en un archivo: órdenes y unidades por día (60 días), visitas por día, promociones con
// cantidad de publicaciones adheridas y candidatas, detalle de cupones, estado de las publicaciones
// (activas, pausadas por motivo, en revisión) y candidatas para promos (activas con stock, sin venta).
// El repo es público: el log sólo dice qué pasos terminaron. Los números van al archivo de salida,
// que el workflow guarda en el repo privado.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CUENTA, fechaMontevideo } from './config.mjs';
import { crearCliente } from './ml.mjs';
import { fuenteTokenD1 } from '../../precio-ganador/src/token.mjs';
import { bulkItemsPath, bulkEntryItem } from '../../worker-sync/meli-bulk.js';

const V2 = 'app_version=v2';
const lista = j => Array.isArray(j) ? j : Array.isArray(j?.results) ? j.results : [];
const DIA = 86400000;

// Órdenes a conteo por día de Montevideo. Función pura (exportada para el test).
export function ventasPorDia(ordenes) {
  const dias = {};
  for (const o of ordenes) {
    if (!o || o.status === 'cancelled') continue;
    const d = fechaMontevideo(new Date(o.date_created));
    const x = dias[d] ??= { ordenes: 0, unidades: 0, monto: 0 };
    x.ordenes++;
    x.monto += Number(o.total_amount) || 0;
    for (const it of Array.isArray(o.order_items) ? o.order_items : []) x.unidades += Number(it.quantity) || 0;
  }
  return dias;
}

// Promedio de una métrica en los N días anteriores a `hoy` (sin contar hoy). Función pura.
export function promedio(dias, hoy, n, campo) {
  let s = 0;
  for (let i = 1; i <= n; i++) s += dias[fechaMontevideo(new Date(Date.parse(hoy + 'T12:00:00-03:00') - i * DIA))]?.[campo] ?? 0;
  return Math.round((s / n) * 10) / 10;
}

async function main() {
  const args = process.argv.slice(2);
  const salida = args[args.indexOf('--salida') + 1] || '.';
  const ml = crearCliente(fuenteTokenD1(CUENTA), { intentos: 4, concurrencia: 4 }); // sólo GET
  const yo = await ml.get('/users/me');
  if (String(yo?.id) !== CUENTA.sellerId) throw Object.assign(new Error('token_de_otra_cuenta'), { fatal: true });
  const S = CUENTA.sellerId;
  const out = { generado: new Date().toISOString(), hoy: fechaMontevideo(new Date()) };
  const paso = (n, f) => f().then(v => { out[n] = v; console.log('ok', n); }, e => { out[n] = { error: e?.status ?? e?.message }; console.log('fallo', n, e?.status ?? ''); });

  // 1. Órdenes de los últimos 60 días.
  await paso('ventas', async () => {
    const desde = new Date(Date.now() - 61 * DIA).toISOString().slice(0, 10) + 'T00:00:00.000-03:00';
    const ordenes = []; const porItem = {};
    for (let off = 0; off < 9950; off += 50) {
      const d = await ml.get(`/orders/search?seller=${S}&order.date_created.from=${encodeURIComponent(desde)}&sort=date_desc&limit=50&offset=${off}`);
      const r = lista(d); ordenes.push(...r);
      if (r.length < 50 || off + 50 >= (d?.paging?.total ?? 0)) break;
    }
    for (const o of ordenes) if (o.status !== 'cancelled') for (const it of o.order_items ?? []) { const id = it?.item?.id; if (id) porItem[id] = (porItem[id] ?? 0) + (Number(it.quantity) || 0); }
    const dias = ventasPorDia(ordenes);
    out._vendidosEn60 = porItem;
    const hoy = out.hoy, semanaPasada = fechaMontevideo(new Date(Date.parse(hoy + 'T12:00:00-03:00') - 7 * DIA));
    const horaHoy = new Date().toLocaleTimeString('es-UY', { timeZone: 'America/Montevideo', hour12: false });
    // Mismo día de la semana pasada hasta la misma hora.
    const hastaHora = ordenes.filter(o => o.status !== 'cancelled' && fechaMontevideo(new Date(o.date_created)) === semanaPasada && new Date(o.date_created).toLocaleTimeString('es-UY', { timeZone: 'America/Montevideo', hour12: false }) <= horaHoy);
    return {
      total_ordenes_60d: ordenes.length, hora_corte: horaHoy, hoy: dias[hoy] ?? { ordenes: 0, unidades: 0, monto: 0 },
      prom7: { ordenes: promedio(dias, hoy, 7, 'ordenes'), unidades: promedio(dias, hoy, 7, 'unidades') },
      prom30: { ordenes: promedio(dias, hoy, 30, 'ordenes'), unidades: promedio(dias, hoy, 30, 'unidades') },
      semana_pasada_dia_completo: dias[semanaPasada] ?? null,
      semana_pasada_hasta_esta_hora: { ordenes: hastaHora.length, unidades: hastaHora.reduce((s, o) => s + (o.order_items ?? []).reduce((a, i) => a + (Number(i.quantity) || 0), 0), 0) },
      por_dia: dias,
    };
  });

  // 2. Visitas por día de toda la cuenta.
  await paso('visitas', async () => {
    const d = await ml.get(`/users/${S}/items_visits/time_window?last=31&unit=day`);
    return { total: d?.total_visits ?? null, por_dia: Object.fromEntries((d?.results ?? []).map(r => [String(r.date).slice(0, 10), r.total])) };
  });

  // 3. Promociones: detalle y cantidad de publicaciones por estado.
  await paso('promociones', async () => {
    const promos = lista(await ml.get(`/seller-promotions/users/${S}?${V2}`));
    const res = [];
    for (const p of promos) {
      const det = await ml.sonda(`/seller-promotions/promotions/${encodeURIComponent(p.id)}?promotion_type=${p.type}&${V2}`);
      const cuenta = {};
      for (const st of ['started', 'pending', 'candidate']) {
        const r = await ml.sonda(`/seller-promotions/promotions/${encodeURIComponent(p.id)}/items?promotion_type=${p.type}&status=${st}&${V2}&limit=1`);
        cuenta[st] = r.ok ? (r.json?.paging?.total ?? lista(r.json).length) : `http_${r.status}`;
      }
      let muestra = null;
      if (p.type === 'SELLER_COUPON_CAMPAIGN' || p.type === 'DEAL') {
        const r = await ml.sonda(`/seller-promotions/promotions/${encodeURIComponent(p.id)}/items?promotion_type=${p.type}&${V2}&limit=3`);
        muestra = r.ok ? lista(r.json).slice(0, 3) : `http_${r.status}`;
      }
      res.push({ resumen: p, detalle: det.ok ? det.json : `http_${det.status}`, items: cuenta, muestra });
    }
    return res;
  });

  // 4. Publicaciones: activas con stock, pausadas por motivo, en revisión.
  await paso('publicaciones', async () => {
    const ids = async estado => {
      const o = []; let scroll = null;
      for (let i = 0; i < 300; i++) {
        const d = await ml.get(`/users/${S}/items/search?status=${estado}&search_type=scan&limit=100${scroll ? `&scroll_id=${encodeURIComponent(scroll)}` : ''}`);
        const r = lista(d); if (!r.length) break; o.push(...r); scroll = d?.scroll_id; if (!scroll) break;
      }
      return [...new Set(o)];
    };
    const totales = {};
    for (const st of ['under_review', 'inactive', 'closed']) { const d = await ml.sonda(`/users/${S}/items/search?status=${st}&limit=1`); totales[st] = d.ok ? d.json?.paging?.total : `http_${d.status}`; }
    const campos = 'id,title,price,available_quantity,sold_quantity,status,sub_status,date_created,category_id,shipping,catalog_listing,tags,health';
    const leer = async lista_ => { const r = []; for (let i = 0; i < lista_.length; i += 20) { const d = await ml.get(bulkItemsPath(lista_.slice(i, i + 20), campos)); for (const e of Array.isArray(d) ? d : []) { const it = bulkEntryItem(e); if (it) r.push(it); } } return r; };
    const activas = await leer(await ids('active'));
    const pausadas = await leer(await ids('paused'));
    const motivo = {}; for (const p of pausadas) for (const s of (p.sub_status?.length ? p.sub_status : ['sin_motivo'])) motivo[s] = (motivo[s] ?? 0) + 1;
    const vend = out._vendidosEn60 ?? {};
    const stockAct = {}; let envioGratis = 0;
    for (const a of activas) { const q = a.available_quantity ?? 0; const k = q >= 3 ? '3+' : String(q); stockAct[k] = (stockAct[k] ?? 0) + 1; if (a.shipping?.free_shipping) envioGratis++; }
    const candidatas = activas.filter(a => (a.available_quantity ?? 0) >= 1).map(a => ({ id: a.id, titulo: a.title, precio: a.price, stock: a.available_quantity, vendidos_total: a.sold_quantity, vendidos_60d: vend[a.id] ?? 0, alta: a.date_created, categoria: a.category_id, catalogo: !!a.catalog_listing, envio_gratis: !!a.shipping?.free_shipping }));
    return { activas: activas.length, pausadas: pausadas.length, otros_estados: totales, pausadas_por_motivo: motivo, activas_por_stock: stockAct, activas_envio_gratis: envioGratis, activas_sin_venta_60d: candidatas.filter(c => !c.vendidos_60d).length, candidatas };
  });

  delete out._vendidosEn60;
  mkdirSync(salida, { recursive: true });
  writeFileSync(join(salida, 'diagnostico-libros.json'), JSON.stringify(out, null, 1));
  console.log('Diagnóstico guardado');
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) main().catch(e => { console.error('diagnostico:', e?.code ?? e?.message); process.exit(1); });
