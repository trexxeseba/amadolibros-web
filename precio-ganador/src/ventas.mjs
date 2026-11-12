// Cruce de ventas (sólo lee). Seba, 12/11/2026: "cuánto vende de más cada libro que
// gana la ficha y cuánto margen cuesta".
//
//   node precio-ganador/src/ventas.mjs --cuenta libros --estado DIR --salida DIR
//
// Para cada publicación que el sistema bajó (state/<cuenta>.json) compara las unidades
// por día de los 14 días ANTES de la primera baja con las de los días DESPUÉS, y lo
// pone al lado de lo que pasó en el resto del catálogo en las mismas fechas (control),
// para no confundir un cambio de temporada con el efecto de bajar el precio.
// Margen cedido = (precio original − precio aplicado) × unidades vendidas después.
// Las ventas salen de D1 (ml_sales_items + ml_sales_orders, sólo SELECT). El informe
// con montos queda en el repo privado del estado; el log sólo muestra conteos.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CUENTAS, D1_DATABASE_ID } from './config.mjs';

const DIA_MS = 86400_000;
export const VENTANA_DIAS = 14;

async function d1(sql, params = []) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const tokens = [process.env.CLOUDFLARE_ADMIN_API_TOKEN, process.env.CLOUDFLARE_API_TOKEN].filter(Boolean);
  let ultimo = 'sin_token_cloudflare';
  for (const t of tokens) {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${D1_DATABASE_ID}/query`, {
      method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, params }), signal: AbortSignal.timeout(60000),
    }).catch(() => null);
    if (!res) { ultimo = 'cloudflare_transporte'; continue; }
    const body = await res.json().catch(() => null);
    if (!res.ok || body?.success === false) { ultimo = `cloudflare_http_${res.status}`; continue; }
    return body?.result?.[0]?.results ?? [];
  }
  throw Object.assign(new Error(ultimo), { fatal: true });
}

// Unidades por publicación en un rango [desde, hasta) de date_created_ms (sin canceladas).
export async function unidades(desdeMs, hastaMs, consulta = d1) {
  const filas = await consulta(
    `SELECT i.item_id AS item_id, SUM(i.quantity) AS u FROM ml_sales_items i JOIN ml_sales_orders o ON o.order_id = i.order_id
     WHERE o.date_created_ms >= ? AND o.date_created_ms < ? AND o.status NOT IN ('cancelled','invalid') GROUP BY i.item_id`, [desdeMs, hastaMs]);
  return new Map(filas.map(f => [f.item_id, Number(f.u) || 0]));
}

// Parte pura (con tests): arma el informe a partir de las ventas ya leídas.
//   estado: { publicaciones: { id: { titulo, precio_original, precio_aplicado, fecha_primera_baja } } }
//   ventas: (id, desdeMs, hastaMs) => unidades
//   control: { antes, despues } unidades por día del resto del catálogo en la ventana común
export function armarInforme({ estado, ventas, ahoraMs, control }) {
  const filas = [];
  for (const [id, e] of Object.entries(estado.publicaciones ?? {})) {
    const inicio = Date.parse(e.fecha_primera_baja);
    if (!Number.isFinite(inicio)) continue;
    const diasDespues = Math.min(VENTANA_DIAS, (ahoraMs - inicio) / DIA_MS);
    if (diasDespues < 1) { filas.push({ id, titulo: e.titulo, muestra: 'muy_reciente' }); continue; }
    const antes = ventas(id, inicio - VENTANA_DIAS * DIA_MS, inicio), despues = ventas(id, inicio, inicio + diasDespues * DIA_MS);
    const porDiaAntes = antes / VENTANA_DIAS, porDiaDespues = despues / diasDespues;
    filas.push({
      id, titulo: e.titulo, dias_despues: Math.round(diasDespues * 10) / 10, unidades_antes: antes, unidades_despues: despues,
      por_dia_antes: porDiaAntes, por_dia_despues: porDiaDespues,
      margen_cedido: (Number(e.precio_original) - Number(e.precio_aplicado)) * despues,
      descuento_pct: Math.round((1 - Number(e.precio_aplicado) / Number(e.precio_original)) * 1000) / 10,
    });
  }
  const medidas = filas.filter(f => f.dias_despues !== undefined);
  const suma = k => medidas.reduce((s, f) => s + f[k], 0);
  const tot = {
    publicaciones: medidas.length, unidades_antes: suma('unidades_antes'), unidades_despues: suma('unidades_despues'),
    por_dia_antes: suma('por_dia_antes'), por_dia_despues: suma('por_dia_despues'), margen_cedido: suma('margen_cedido'),
  };
  // Cambio de las gestionadas contra el cambio del control (mismas fechas, resto del catálogo).
  const cambioGestionadas = tot.por_dia_antes > 0 ? tot.por_dia_despues / tot.por_dia_antes - 1 : null;
  const cambioControl = control && control.antes > 0 ? control.despues / control.antes - 1 : null;
  return { filas, tot, cambioGestionadas, cambioControl, efecto: cambioGestionadas !== null && cambioControl !== null ? cambioGestionadas - cambioControl : null };
}

const pct = v => v === null || v === undefined ? 'sin datos' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(0)} %`;

export function markdown(r, { cuenta, fecha }) {
  const l = [`# Cruce de ventas · ${cuenta.nombre} · ${fecha}`, '',
    `Publicaciones que el sistema bajó: ${r.tot.publicaciones} con ventas medibles. Se comparan los ${VENTANA_DIAS} días antes de la primera baja con los días después.`, '',
    '| | Unidades por día antes | Unidades por día después | Cambio |', '|---|---:|---:|---:|',
    `| Las que bajó el sistema | ${r.tot.por_dia_antes.toFixed(2)} | ${r.tot.por_dia_despues.toFixed(2)} | ${pct(r.cambioGestionadas)} |`,
    `| Resto del catálogo (control) | ${r.control?.antes?.toFixed(2) ?? ''} | ${r.control?.despues?.toFixed(2) ?? ''} | ${pct(r.cambioControl)} |`, '',
    `**Efecto atribuible a bajar el precio** (cambio de las bajadas menos cambio del control): **${pct(r.efecto)}**.`,
    `**Margen cedido** por los descuentos sobre lo vendido después: **$ ${Math.round(r.tot.margen_cedido)}**.`, '',
    'Si el efecto es chico y el margen cedido es grande, bajar no está trayendo ventas.', '',
    '| Publicación | Descuento | Unid. antes | Unid. después | Días después | Margen cedido |', '|---|---:|---:|---:|---:|---:|'];
  for (const f of r.filas.filter(f => f.dias_despues !== undefined).sort((a, b) => b.margen_cedido - a.margen_cedido))
    l.push(`| ${f.id} ${String(f.titulo ?? '').slice(0, 45).replace(/\|/g, '/')} | ${f.descuento_pct} % | ${f.unidades_antes} | ${f.unidades_despues} | ${f.dias_despues} | ${Math.round(f.margen_cedido)} |`);
  const recientes = r.filas.filter(f => f.muestra === 'muy_reciente').length;
  if (recientes) l.push('', `${recientes} publicaciones se bajaron hace menos de 1 día: todavía no hay datos.`);
  return l.join('\n') + '\n';
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (n, d = null) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
  const cuenta = CUENTAS[opt('cuenta')];
  if (!cuenta) { console.error('Usar --cuenta libros|vintage'); process.exit(2); }
  const estado = JSON.parse(readFileSync(join(opt('estado', 'state'), `${cuenta.clave}.json`), 'utf8'));
  const ahora = Date.now();
  const inicios = Object.values(estado.publicaciones ?? {}).map(e => Date.parse(e.fecha_primera_baja)).filter(Number.isFinite);
  if (!inicios.length) { console.log('Sin publicaciones bajadas: nada que cruzar.'); return; }
  const desde = Math.min(...inicios) - VENTANA_DIAS * DIA_MS;
  // Ventas por publicación, día a día (una consulta por rango de 1 día evita traer todo junto).
  const dias = [];
  for (let t = desde; t < ahora; t += DIA_MS) dias.push(t);
  const porDia = new Map();
  for (const t of dias) porDia.set(t, await unidades(t, t + DIA_MS));
  const ventas = (id, a, b) => { let u = 0; for (const [t, m] of porDia) if (t >= a - DIA_MS + 1 && t < b) { const frac = Math.max(0, Math.min(b, t + DIA_MS) - Math.max(a, t)) / DIA_MS; u += (m.get(id) ?? 0) * frac; } return Math.round(u * 100) / 100; };
  // Control: resto del catálogo, ventana común = desde la primera baja hasta ahora (después) y los 14 días previos (antes).
  const corte = Math.min(...inicios);
  const gestionadas = new Set(Object.keys(estado.publicaciones));
  const totalPorDia = (a, b) => { let u = 0; for (const [t, m] of porDia) if (t >= a && t < b) for (const [id, q] of m) if (!gestionadas.has(id)) u += q; return u; };
  const control = { antes: totalPorDia(corte - VENTANA_DIAS * DIA_MS, corte) / VENTANA_DIAS, despues: totalPorDia(corte, ahora) / Math.max(1, (ahora - corte) / DIA_MS) };
  const r = { ...armarInforme({ estado, ventas, ahoraMs: ahora, control }), control };
  mkdirSync(opt('salida', '.'), { recursive: true });
  writeFileSync(join(opt('salida', '.'), `${cuenta.clave}-ventas.md`), markdown(r, { cuenta, fecha: new Date(ahora).toISOString().slice(0, 10) }));
  // Log público: sólo conteos y porcentajes.
  console.log(JSON.stringify({ publicaciones: r.tot.publicaciones, cambio_bajadas: r.cambioGestionadas, cambio_control: r.cambioControl, efecto: r.efecto }));
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) main().catch(e => { console.error('ventas:', e.message); process.exit(1); });
