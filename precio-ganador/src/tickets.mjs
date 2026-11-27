// Cupones por monto de compra (Seba, 27/11/2026: "¿por qué no tenemos cupones de $700 o $1000 en
// compras de $5000 o $7000?", con el objetivo de hacer caja y liquidar stock). Sólo lee.
//
//   node precio-ganador/src/tickets.mjs --cuenta libros --salida DIR [--dias 180]
//
// 1) Ventas de D1 (ml_sales_orders/items, sólo SELECT): monto por compra (carrito = pack_id, si no la orden),
//    por tramos, y cuántas quedan cerca de cada umbral (las que un cupón podría empujar a subir).
// 2) Simulación de cada cupón: lo que cuesta regalarlo a las compras que ya pasan el umbral.
// 3) Mercado Libre: qué tipos de promoción le ofrece hoy a la cuenta (/seller-promotions/users/{id}), para
//    saber si el cupón de vendedor está habilitado en Uruguay.
// El detalle con montos va al repo privado; el log sólo lleva si cada paso respondió.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CUENTAS } from './config.mjs';
import { d1 } from './ventas.mjs';
import { fuenteTokenD1 } from './token.mjs';
import { crearCliente } from '../../agentes-ml/src/ml.mjs';

export const TRAMOS = [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 10000, Infinity];
export const CUPONES = [{ umbral: 5000, descuento: 700 }, { umbral: 5000, descuento: 1000 }, { umbral: 7000, descuento: 700 }, { umbral: 7000, descuento: 1000 }];

// Junta las órdenes de un mismo carrito. Función pura.
export function compras(ordenes) {
  const m = new Map();
  for (const o of ordenes) {
    const k = o.pack_id || o.order_id, c = m.get(k) ?? { total: 0, unidades: 0, libros: 0 };
    c.total += Number(o.total_amount) || 0; c.unidades += Number(o.unidades) || 0; c.libros += Number(o.lineas) || 0; m.set(k, c);
  }
  return [...m.values()];
}

// Tramos de monto y simulación de cupones. Función pura.
export function analizar(lista, { cupones = CUPONES } = {}) {
  const tramos = {};
  for (let i = 0; i < TRAMOS.length - 1; i++) {
    const en = lista.filter(c => c.total >= TRAMOS[i] && c.total < TRAMOS[i + 1]);
    tramos[`${TRAMOS[i]}-${TRAMOS[i + 1] === Infinity ? 'mas' : TRAMOS[i + 1]}`] = { compras: en.length, monto: Math.round(en.reduce((a, c) => a + c.total, 0)) };
  }
  const total = lista.reduce((a, c) => a + c.total, 0);
  const sim = cupones.map(({ umbral, descuento }) => {
    const yaPasan = lista.filter(c => c.total >= umbral).length;
    const cerca = lista.filter(c => c.total >= umbral * 0.6 && c.total < umbral).length;
    return { umbral, descuento, pct: Math.round((descuento / umbral) * 1000) / 10, ya_pasan: yaPasan, cerca_60pct: cerca, costo_regalado: yaPasan * descuento };
  });
  const orden = [...lista].sort((a, b) => a.total - b.total);
  return { compras: lista.length, monto_total: Math.round(total), ticket_promedio: lista.length ? Math.round(total / lista.length) : null, ticket_mediano: orden.length ? Math.round(orden[Math.floor(orden.length / 2)].total) : null,
    con_2_o_mas_libros: lista.filter(c => c.unidades >= 2).length, tramos, cupones: sim };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (n, d = null) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
  const cuenta = CUENTAS[opt('cuenta')];
  if (!cuenta || cuenta.clave !== 'libros') { console.error('Sólo --cuenta libros'); process.exit(2); }
  const dias = Number(opt('dias', 180)), salida = opt('salida', '.');
  const desde = Date.now() - dias * 86400_000;
  const ordenes = await d1(
    `SELECT o.order_id, o.pack_id, o.total_amount, o.date_created_ms, SUM(i.quantity) AS unidades, COUNT(i.line_key) AS lineas
     FROM ml_sales_orders o LEFT JOIN ml_sales_items i ON i.order_id = o.order_id
     WHERE o.seller_id = ? AND o.status NOT IN ('cancelled', 'invalid') AND o.date_created_ms >= ?
     GROUP BY o.order_id`, [cuenta.sellerId, desde]);
  const lista = compras(ordenes);
  const porMes = {};
  for (const o of ordenes) { const k = new Date(o.date_created_ms).toISOString().slice(0, 7); porMes[k] = (porMes[k] ?? 0) + 1; }
  const informe = { fecha: new Date().toISOString().slice(0, 10), dias, ordenes: ordenes.length, ordenes_por_mes: porMes, ...analizar(lista) };
  for (const v of [90, 30]) informe[`ultimos_${v}_dias`] = analizar(compras(ordenes.filter(o => o.date_created_ms >= Date.now() - v * 86400_000)));

  let promos = { http: null, tipos: null };
  try {
    const ml = crearCliente(fuenteTokenD1(cuenta), { intentos: 3, concurrencia: 2, soloLectura: true });
    const yo = await ml.get('/users/me');
    if (String(yo?.id) !== cuenta.sellerId) throw Object.assign(new Error('token_de_otra_cuenta'), { fatal: true });
    const r = await ml.sonda(`/seller-promotions/users/${cuenta.sellerId}?app_version=v2`);
    const lst = Array.isArray(r.json?.results) ? r.json.results : Array.isArray(r.json) ? r.json : [];
    promos = { http: r.status, tipos: [...new Set(lst.map(p => p?.type).filter(Boolean))], vigentes: lst.map(p => ({ tipo: p?.type ?? null, estado: p?.status ?? null, nombre: p?.name ?? null, inicio: p?.start_date ?? null, fin: p?.finish_date ?? null })) };
    const c = await ml.sonda(`/seller-promotions/users/${cuenta.sellerId}?app_version=v2&promotion_type=SELLER_COUPON_CAMPAIGN`);
    promos.cupon_vendedor = { http: c.status, cantidad: Array.isArray(c.json?.results) ? c.json.results.length : null, error: c.ok ? null : (c.json?.message ?? null) };
  } catch (e) { promos.error = e?.message ?? 'error'; }
  informe.promociones_ml = promos;

  mkdirSync(salida, { recursive: true });
  writeFileSync(join(salida, `${cuenta.clave}-tickets.json`), JSON.stringify(informe, null, 1));
  console.log(JSON.stringify({ ordenes_leidas: ordenes.length > 0, promos_http: promos.http, cupon_http: promos.cupon_vendedor?.http ?? null, tipos_promo: promos.tipos })); // sin montos: el log es público
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) main().catch(e => { console.error('tickets:', e?.code ?? e?.message); process.exit(1); });
