#!/usr/bin/env node
// Prueba de solo lectura de los endpoints sobre 10-20 publicaciones.
//   node precios-libros-local/src/sonda.mjs                (elige 15: catálogo que compite, gana, y sin catálogo)
//   node precios-libros-local/src/sonda.mjs --ids MLU1,MLU2
// Guarda en datos/sonda-<fecha>/: respuestas completas (local) y un resumen sin montos
// (status HTTP y campos presentes por endpoint), apto para compartir.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SELLER_ID } from '../config.mjs';
import { fuenteToken } from './token.mjs';
import { crearCliente } from './ml.mjs';
import { idsActivos, detalleItems } from './lectura.mjs';

const DATOS = process.env.PRECIOS_DATOS_DIR || join(dirname(dirname(fileURLToPath(import.meta.url))), 'datos');
const forma = v => Array.isArray(v) ? `array(${v.length})${v.length ? '<' + forma(v[0]) + '>' : ''}` : v && typeof v === 'object' ? '{' + Object.keys(v).slice(0, 25).join(',') + '}' : typeof v;

async function probar(ml, path) {
  try { const body = await ml.get(path); return { path, status: 200, forma: forma(body), body }; }
  catch (e) { if (e?.fatal) throw e; return { path, status: e?.status ?? 0, error: e?.code, detalle: e?.detalle ?? null }; }
}

async function main() {
  const argv = process.argv.slice(2);
  const ml = crearCliente(fuenteToken(), { concurrencia: 2 });
  const yo = await ml.get('/users/me');
  if (String(yo?.id) !== SELLER_ID) throw new Error('el token no es de Amado Libros');
  let ids = argv.includes('--ids') ? argv[argv.indexOf('--ids') + 1].split(',') : null;
  if (!ids) {
    // Muestra representativa: 5 de catálogo, 5 tradicionales con ficha, 5 sin catálogo.
    const todos = await idsActivos(ml, SELLER_ID, { limite: 600 });
    const det = [...(await detalleItems(ml, todos)).values()];
    const cat = det.filter(i => i.catalog_listing).slice(0, 5);
    const conFicha = det.filter(i => !i.catalog_listing && i.catalog_product_id).slice(0, 5);
    const sin = det.filter(i => !i.catalog_listing && !i.catalog_product_id).slice(0, 5);
    ids = [...cat, ...conFicha, ...sin].map(i => i.id);
  }
  const out = { fecha: new Date().toISOString(), seller: SELLER_ID, cuenta_ok: true, generales: [], items: [] };
  out.generales.push(await probar(ml, `/suggestions/user/${SELLER_ID}/items`));
  const pa = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const r = await probar(ml, `/pricing-automation/users/${SELLER_ID}/items?offset=${offset}&limit=100`);
    pa.push(r); if (r.status !== 200 || (r.body?.results ?? r.body?.items ?? []).length < 100) break;
  }
  out.generales.push(...pa);
  for (const id of ids) {
    const it = { id, llamadas: [] };
    for (const p of [`/items/${id}`, `/items/${id}/prices`, `/items/${id}/sale_price?context=channel_marketplace`, `/items/${id}/price_to_win?version=v2`, `/suggestions/items/${id}/details`, `/pricing-automation/items/${id}/rules`, `/pricing-automation/items/${id}/automation`, `/seller-promotions/items/${id}?app_version=v2`]) it.llamadas.push(await probar(ml, p));
    const item = it.llamadas[0].body;
    it.user_product_id = item?.user_product_id ?? null;
    it.catalog_listing = item?.catalog_listing ?? null;
    it.catalog_product_id = item?.catalog_product_id ?? null;
    if (item?.catalog_product_id) it.llamadas.push(await probar(ml, `/products/${item.catalog_product_id}/items?limit=50`));
    out.items.push(it);
  }
  const dir = join(DATOS, `sonda-${out.fecha.replace(/[:.]/g, '-')}`); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'completo.json'), JSON.stringify(out, null, 2));
  // Resumen sin montos ni cuerpos: endpoint → status y forma.
  const tabla = {};
  for (const r of [...out.generales, ...out.items.flatMap(i => i.llamadas)]) {
    const k = r.path.replace(/MLU\d+/g, '{ID}').replace(/MLU-?[A-Z]*\d+/g, '{PID}').replace(/offset=\d+/, 'offset=N').replace(/\d{6,}/g, '{N}');
    tabla[k] ??= { status: {}, formas: new Set() };
    tabla[k].status[r.status] = (tabla[k].status[r.status] ?? 0) + 1;
    if (r.forma) tabla[k].formas.add(r.forma.slice(0, 300));
    if (r.detalle?.error || r.detalle?.message) tabla[k].formas.add('error: ' + (r.detalle.error ?? '') + ' ' + (r.detalle.message ?? ''));
  }
  const resumen = Object.fromEntries(Object.entries(tabla).map(([k, v]) => [k, { status: v.status, formas: [...v.formas] }]));
  resumen._items = out.items.map(i => ({ catalogo: i.catalog_listing, con_ficha: !!i.catalog_product_id, user_product: !!i.user_product_id }));
  writeFileSync(join(dir, 'resumen-sin-montos.json'), JSON.stringify(resumen, null, 2));
  console.log(JSON.stringify(resumen, null, 2));
  console.log('Guardado en', dir);
}
main().catch(e => { console.error('Sonda detenida:', e.message); process.exit(1); });
