// Publicaciones activas de Amado Libros que NO son de catálogo, con stock, ordenadas por visitas (sólo lee).
// Pedido de Seba (25/11/2026): revisarlas en pantalla de a 20, empezando por las más vistas, para
// compararlas contra la competencia (Mercado Libre no da referencia de precio para las que no son de catálogo).
//
//   node precio-ganador/src/top-visitas.mjs --cuenta libros --salida DIR [--dias 30] [--tope 400]
//
// El log sólo muestra conteos (el repo es público); títulos y precios van al archivo de salida (repo privado).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CUENTAS } from './config.mjs';
import { fuenteTokenD1 } from './token.mjs';
import { crearCliente } from './ml.mjs';
import { idsActivos, detalle } from './publicaciones.mjs';

// Candidata: activa, en pesos, sin variaciones, con stock y que no sea la publicación de catálogo. Función pura.
export function esCandidata(it) {
  return !!it && it.status === 'active' && it.currency_id === 'UYU' && !it.variaciones && !it.catalog_listing && Number(it.available_quantity) >= 1;
}

// Ordena por visitas (las no leídas al final) y corta. Función pura.
export function ordenarPorVisitas(filas, tope = 400) {
  return [...filas].sort((a, b) => (b.visitas ?? -1) - (a.visitas ?? -1) || b.stock - a.stock).slice(0, tope);
}

async function enParalelo(lista, n, fn) {
  const cola = [...lista];
  await Promise.all(Array.from({ length: n }, async () => { while (cola.length) await fn(cola.shift()); }));
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (n, d = null) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
  const cuenta = CUENTAS[opt('cuenta')];
  if (!cuenta || cuenta.clave !== 'libros') { console.error('Sólo --cuenta libros'); process.exit(2); }
  const dias = Number(opt('dias', 30)), tope = Number(opt('tope', 400)), salida = opt('salida', '.');
  const ml = crearCliente(fuenteTokenD1(cuenta), { concurrencia: 4 }); // sólo GET en este archivo
  const yo = await ml.get('/users/me');
  if (String(yo?.id) !== cuenta.sellerId) throw Object.assign(new Error('token_de_otra_cuenta'), { fatal: true });

  const items = [...(await detalle(ml, await idsActivos(ml, cuenta.sellerId))).values()];
  const candidatas = items.filter(esCandidata);
  const filas = []; let errores = 0;
  await enParalelo(candidatas, 4, async it => {
    let visitas = null;
    try { visitas = Number((await ml.get(`/items/${it.id}/visits/time_window?last=${dias}&unit=day`))?.total_visits ?? 0); }
    catch (e) { if (e?.fatal || e?.status === 429) throw e; errores++; }
    filas.push({ id: it.id, titulo: String(it.title ?? '').slice(0, 90), precio: Number(it.price), stock: Number(it.available_quantity), visitas,
      con_ficha: !!it.catalog_product_id, ficha: it.catalog_product_id ?? null, en_promo: it.original_price != null, permalink: it.permalink ?? null });
  });
  const top = ordenarPorVisitas(filas, tope);
  const resumen = { fecha: new Date().toISOString().slice(0, 10), cuenta: cuenta.clave, dias, activas: items.length, candidatas: candidatas.length, errores_visitas: errores,
    con_visitas: filas.filter(f => f.visitas > 0).length, con_10_o_mas: filas.filter(f => f.visitas >= 10).length, guardadas: top.length };
  mkdirSync(salida, { recursive: true });
  writeFileSync(join(salida, `${cuenta.clave}-top-visitas.json`), JSON.stringify({ resumen, filas: top }, null, 1));
  console.log(JSON.stringify(resumen)); // sólo conteos: el log es público
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) main().catch(e => { console.error('top-visitas:', e?.code ?? e?.message); process.exit(1); });
