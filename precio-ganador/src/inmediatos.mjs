// Auditoría (sólo lee, no cambia precios): ¿hay vendedores con entrega inmediata más baratos que nosotros?
// Seba, 15/11/2026: "tengo libros que aún vendo más caro que otros que venden a entrega inmediata".
//
//   node precio-ganador/src/inmediatos.mjs --cuenta libros --salida DIR [--muestra 200] [--max-trad 5000]
//
// Dos bloques, en la misma corrida:
//   1. Ganadoras: una muestra al azar de publicaciones de catálogo que Mercado Libre marca como
//      "winning" (price_to_win v2). Para cada una, el vendedor con entrega inmediata más barato de la ficha.
//   2. Tradicionales con ficha: las publicaciones que no son de catálogo pero tienen catalog_product_id
//      (la gemela de una ficha). Se miden contra las ofertas de esa ficha, todas.
// Las publicaciones sin catalog_product_id no se pueden medir por API: sólo se cuentan.
//
// Entrega inmediata = shipping_options sin preparación (misma lectura que competencia.mjs). Los vendedores de
// SLOW_SELLERS cuentan como "a demanda" y los de HOUSE_SELLERS no son competencia. Las ofertas usadas se
// dejan afuera. El log sólo muestra conteos (el repo es público); los precios van al archivo de salida.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CUENTAS } from './config.mjs';
import { fuenteTokenD1 } from './token.mjs';
import { crearCliente } from './ml.mjs';
import { idsActivos, detalle } from './publicaciones.mjs';
import { ofertasCatalogo, entregaDe } from './competencia.mjs';
import { SLOW_SELLERS, HOUSE_SELLERS } from '../../worker-sync/ml-competition.js';

export const MUESTRA_DEFAULT = 200;
export const MAX_VERIFICADAS = 6; // cuántas ofertas más baratas se miran por publicación

// Ofertas válidas más baratas que la nuestra, de la más barata a la más cara.
export function masBaratas(item, ofertas, { sellerId, casa = new Set() } = {}) {
  const propios = new Set([String(sellerId), ...casa]);
  return (Array.isArray(ofertas) ? ofertas : [])
    .filter(o => o && typeof o.item_id === 'string' && o.item_id !== item.id && !propios.has(String(o.seller_id)))
    .filter(o => Number.isFinite(Number(o.price)) && Number(o.price) > 0 && Number(o.price) < Number(item.price))
    .filter(o => String(o.condition ?? '').toLowerCase() !== 'used')
    .sort((a, b) => Number(a.price) - Number(b.price));
}

// Recorre las más baratas (hasta `max`) y se queda con la primera de entrega inmediata.
// getEntrega(oferta) devuelve 'inmediato' | 'demanda' | 'sin_dato'.
export async function resumir(item, baratas, getEntrega, { lentos = new Map(), max = MAX_VERIFICADAS } = {}) {
  const r = { id: item.id, titulo: item.titulo ?? '', precio: Number(item.price), pid: item.pid ?? null, mas_barato_inmediato: null, brecha_pct: null, baratas_a_demanda: 0, baratas_sin_dato: 0, verificadas: 0 };
  for (const o of baratas.slice(0, max)) {
    r.verificadas++;
    const tipo = lentos.has(String(o.seller_id)) ? 'demanda' : await getEntrega(o);
    if (tipo === 'inmediato') {
      r.mas_barato_inmediato = { item_id: o.item_id, seller_id: String(o.seller_id), price: Number(o.price) };
      r.brecha_pct = Math.round((r.precio - Number(o.price)) / r.precio * 1000) / 10;
      break;
    }
    if (tipo === 'demanda') r.baratas_a_demanda++; else r.baratas_sin_dato++;
  }
  return r;
}

const mediana = xs => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export function estadisticas(filas) {
  const peores = filas.filter(f => f.mas_barato_inmediato);
  return {
    medidas: filas.length,
    mas_caras_que_inmediato: peores.length,
    pct: filas.length ? Math.round(peores.length / filas.length * 1000) / 10 : null,
    brecha_mediana_pct: mediana(peores.map(f => f.brecha_pct)),
    brecha_20_o_mas: peores.filter(f => f.brecha_pct >= 20).length,
    solo_baratas_a_demanda: filas.filter(f => !f.mas_barato_inmediato && f.baratas_a_demanda > 0).length,
  };
}

export function markdown(titulo, filas, { cuenta, fecha, tope = 60 }) {
  const peores = filas.filter(f => f.mas_barato_inmediato).sort((a, b) => b.brecha_pct - a.brecha_pct);
  const l = [`# ${titulo} · ${cuenta.nombre} · ${fecha}`, '',
    `${peores.length} de ${filas.length} publicaciones medidas tienen un vendedor con entrega inmediata más barato (se muestran las ${Math.min(tope, peores.length)} con mayor diferencia).`,
    'Sólo lectura: no se cambió ningún precio. Abrí la ficha antes de decidir: no se distingue edición ni estado fuera de "usado".', '',
    '| Libro | Nuestro precio | Inmediato más barato | Diferencia | Vendedor |', '|---|---:|---:|---:|---|'];
  for (const f of peores.slice(0, tope)) l.push(`| [${String(f.titulo).slice(0, 55).replace(/\|/g, '/')}](https://articulo.mercadolibre.com.uy/${f.id.replace('MLU', 'MLU-')}) | ${f.precio} | ${f.mas_barato_inmediato.price} | ${f.brecha_pct} % | ${f.mas_barato_inmediato.seller_id} |`);
  return l.join('\n') + '\n';
}

async function enParalelo(lista, n, fn) {
  const cola = [...lista];
  await Promise.all(Array.from({ length: n }, async () => { while (cola.length) await fn(cola.shift()); }));
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (n, d = null) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
  const cuenta = CUENTAS[opt('cuenta')];
  if (!cuenta) { console.error('Usar --cuenta libros|vintage'); process.exit(2); }
  const muestra = Number(opt('muestra', MUESTRA_DEFAULT)), maxTrad = Number(opt('max-trad', 5000));
  const ml = crearCliente(fuenteTokenD1(cuenta), { concurrencia: 4 });
  const yo = await ml.get('/users/me');
  if (String(yo?.id) !== cuenta.sellerId) throw Object.assign(new Error('token_de_otra_cuenta'), { fatal: true });

  const ids = await idsActivos(ml, cuenta.sellerId);
  const items = [...(await detalle(ml, ids)).values()].filter(i => i.status === 'active' && i.currency_id === 'UYU' && !i.variaciones)
    .map(i => ({ ...i, titulo: i.title, pid: i.catalog_product_id }));
  const catalogo = items.filter(i => i.catalog_listing && i.pid);
  const tradicionales = items.filter(i => !i.catalog_listing && i.pid);
  const sinFicha = items.filter(i => !i.pid).length;

  const cacheOfertas = new Map(), cacheEntrega = new Map();
  const ofertasDe = async pid => { if (!cacheOfertas.has(pid)) cacheOfertas.set(pid, await ofertasCatalogo(ml, pid)); return cacheOfertas.get(pid); };
  const getEntrega = o => entregaDe(ml, o.item_id, cacheEntrega);
  const opciones = { sellerId: cuenta.sellerId, casa: HOUSE_SELLERS };
  const medirItem = async it => {
    try { return await resumir(it, masBaratas(it, await ofertasDe(it.pid), opciones), getEntrega, { lentos: SLOW_SELLERS }); }
    catch (e) { if (e?.fatal || e?.status === 429) throw e; return null; }
  };

  // 1. Ganadoras: muestra al azar de catálogo, se queda con las que Mercado Libre marca "winning".
  const azar = [...catalogo].sort(() => Math.random() - 0.5).slice(0, Math.ceil(muestra * 1.3));
  const ganadoras = [];
  await enParalelo(azar, 4, async it => {
    if (ganadoras.length >= muestra) return;
    let estado = null;
    try { estado = (await ml.get(`/items/${it.id}/price_to_win?version=v2`))?.status ?? null; } catch (e) { if (e?.fatal || e?.status === 429) throw e; }
    if (estado !== 'winning' || ganadoras.length >= muestra) return;
    const r = await medirItem(it);
    if (r) ganadoras.push(r);
  });

  // 2. Tradicionales con ficha: todas (hasta el máximo).
  const trad = [];
  await enParalelo(tradicionales.slice(0, maxTrad), 4, async it => { const r = await medirItem(it); if (r) trad.push(r); });

  const fecha = new Date().toISOString().slice(0, 10), salida = opt('salida', '.');
  const resumen = { fecha, cuenta: cuenta.clave, activas_medibles: items.length, catalogo: catalogo.length, tradicionales_con_ficha: tradicionales.length, sin_ficha_no_medibles: sinFicha,
    ganadoras: estadisticas(ganadoras), tradicionales: estadisticas(trad), vendedores_consultados: cacheEntrega.size };
  mkdirSync(salida, { recursive: true });
  writeFileSync(join(salida, `${cuenta.clave}-inmediatos.json`), JSON.stringify({ resumen, ganadoras, tradicionales: trad }, null, 1));
  writeFileSync(join(salida, `${cuenta.clave}-inmediatos.md`), markdown('Ganadoras más caras que un inmediato', ganadoras, { cuenta, fecha }) + '\n' + markdown('Tradicionales con ficha más caras que un inmediato', trad, { cuenta, fecha }));
  console.log(JSON.stringify(resumen)); // sólo conteos: el log es público
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) main().catch(e => { console.error('inmediatos:', e.message); process.exit(1); });
