// Envío gratis: cuánto costaría activarlo en las publicaciones que Mercado Libre marca con el objetivo
// de calidad UP_FREE_SHIPPING (pedido de Seba, 27/11/2026: decidirlo con números). Sólo lee.
//
//   node ficha-tecnica/src/envio.mjs --medicion salida/medicion.json --salida salida
//
// Para cada una: precio, comisión de Mercado Libre (/sites/MLU/listing_prices), costo del envío gratis
// para el vendedor (/users/{id}/shipping_options/free) y cuánto queda después de los dos.
// El costo del libro no está en esta cuenta: lo que queda todavía tiene que pagar el libro.
// Escribe DIR/envio-gratis.json (repo privado). El log lleva sólo conteos y porcentajes.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { bulkItemsPath, bulkEntryItem } from '../../worker-sync/meli-bulk.js';
import { clienteLibros, LIBROS, enParalelo, trozos, fechaUy } from './comun.mjs';

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
export const mediana = a => { const o = a.filter(Number.isFinite).sort((x, y) => x - y); return o.length ? o[Math.floor(o.length / 2)] : null; };

// Una fila: lo que queda y qué parte del precio se come el envío. Función pura.
export function cuenta({ precio, comision, envio }) {
  if (!(precio > 0) || comision === null || envio === null) return { queda_sin_envio: null, queda_con_envio: null, envio_pct: null };
  return { queda_sin_envio: Math.round(precio - comision), queda_con_envio: Math.round(precio - comision - envio), envio_pct: Math.round((envio / precio) * 100) };
}

// Tramos por la parte del precio que se lleva el envío. Función pura.
export function tramo(pct) {
  if (pct === null) return 'sin_dato';
  if (pct <= 15) return 'hasta_15';
  if (pct <= 30) return '16_a_30';
  if (pct <= 50) return '31_a_50';
  return 'mas_de_50';
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (n, d = null) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
  const salida = opt('salida', '.');
  const med = JSON.parse(readFileSync(opt('medicion', 'salida/medicion.json'), 'utf8'));
  const ids = med.filas.filter(f => (f.pendientes ?? []).some(p => p.objetivo === 'UP_FREE_SHIPPING')).map(f => f.id);
  const ventasDe = new Map(med.filas.map(f => [f.id, f.ventas ?? 0]));
  const ml = await clienteLibros();

  const items = new Map();
  await enParalelo(trozos(ids, 20), 3, async g => {
    const d = await ml.get(bulkItemsPath(g, 'id,price,listing_type_id,category_id,status,shipping'));
    for (const e of Array.isArray(d) ? d : []) { const b = bulkEntryItem(e); if (b?.id) items.set(b.id, b); }
  });

  const comisiones = new Map(), http = { comision: {}, envio: {} }, filas = [];
  await enParalelo(ids, 3, async id => {
    const it = items.get(id); if (!it) return;
    const precio = num(it.price);
    const k = `${precio}|${it.listing_type_id}|${it.category_id}`;
    if (!comisiones.has(k)) {
      const r = await ml.sonda(`/sites/MLU/listing_prices?price=${precio}&listing_type_id=${it.listing_type_id}&category_id=${it.category_id}`);
      http.comision[r.status] = (http.comision[r.status] ?? 0) + 1;
      const j = Array.isArray(r.json) ? r.json[0] : r.json;
      comisiones.set(k, r.ok ? num(j?.sale_fee_amount) : null);
    }
    const s = await ml.sonda(`/users/${LIBROS.sellerId}/shipping_options/free?item_id=${id}`);
    http.envio[s.status] = (http.envio[s.status] ?? 0) + 1;
    const envio = s.ok ? num(s.json?.coverage?.all_country?.list_cost ?? s.json?.coverage?.all_country?.cost) : null;
    const comision = comisiones.get(k);
    filas.push({ id, precio, comision, envio, ventas: ventasDe.get(id) ?? 0, modo_envio: it.shipping?.mode ?? null, logistica: it.shipping?.logistic_type ?? null, ...cuenta({ precio, comision, envio }) });
  });

  const porTramo = {}; for (const f of filas) { const t = tramo(f.envio_pct); porTramo[t] = (porTramo[t] ?? 0) + 1; }
  const conVentas = filas.filter(f => f.ventas > 0);
  const resumen = {
    fecha: fechaUy(), publicaciones: ids.length, leidas: filas.length, http,
    mediana_precio: mediana(filas.map(f => f.precio)), mediana_envio: mediana(filas.map(f => f.envio)), mediana_envio_pct: mediana(filas.map(f => f.envio_pct)),
    por_tramo: porTramo, quedan_negativas: filas.filter(f => f.queda_con_envio !== null && f.queda_con_envio <= 0).length,
    con_ventas: conVentas.length, con_ventas_por_tramo: conVentas.reduce((a, f) => { const t = tramo(f.envio_pct); a[t] = (a[t] ?? 0) + 1; return a; }, {}),
  };
  mkdirSync(salida, { recursive: true });
  writeFileSync(join(salida, 'envio-gratis.json'), JSON.stringify({ resumen, filas: filas.sort((a, b) => b.ventas - a.ventas) }, null, 1));
  const { mediana_precio, mediana_envio, ...publico } = resumen;
  console.log(JSON.stringify(publico)); // sólo conteos y porcentajes: el log es público
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) main().catch(e => { console.error('envio:', e?.code ?? e?.message); process.exit(1); });
