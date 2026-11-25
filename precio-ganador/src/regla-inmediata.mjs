// Simulación (sólo lee, NUNCA cambia un precio) de la regla pedida por Seba el 24/11/2026 para Amado Libros:
//   - Si hay un competidor con entrega inmediata: quedar 1 % por debajo del más barato de ellos.
//   - Si no hay ninguno con entrega inmediata: subir 75 % sobre el precio base (una sola vez, no acumulativo).
//   - Si al subir quedamos detrás de un vendedor a demanda: avisar (no se resuelve solo).
//   - Si no se pudo leer el plazo de algún competidor que importa: no tocar.
//
//   node precio-ganador/src/regla-inmediata.mjs --cuenta libros --estado DIR --salida DIR [--limite N]
//
// Mide las publicaciones con ficha (catalog_product_id): las de catálogo y las tradicionales gemelas.
// Las que no tienen ficha no se pueden medir por API: sólo se cuentan.
// El log sólo muestra conteos (el repo es público); los precios van al archivo de salida (repo privado).
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CUENTAS } from './config.mjs';
import { fuenteTokenD1 } from './token.mjs';
import { crearCliente } from './ml.mjs';
import { idsActivos, detalle } from './publicaciones.mjs';
import { ofertasCatalogo, entregaDe } from './competencia.mjs';
import { SLOW_SELLERS, HOUSE_SELLERS } from '../../worker-sync/ml-competition.js';

export const DESCUENTO_INMEDIATO = 0.01;
export const SUBIDA_SIN_INMEDIATO = 0.75;
export const MAX_VERIFICADAS = 8;
const entero = n => Math.floor(Number(n) + 1e-9);

// Ofertas ajenas válidas (nuevas, con precio), de la más barata a la más cara.
export function ofertasAjenas(item, ofertas, { sellerId, casa = new Set() } = {}) {
  const propios = new Set([String(sellerId), ...casa]);
  return (Array.isArray(ofertas) ? ofertas : [])
    .filter(o => o && typeof o.item_id === 'string' && o.item_id !== item.id && !propios.has(String(o.seller_id)))
    .filter(o => Number.isFinite(Number(o.price)) && Number(o.price) > 0)
    .filter(o => String(o.condition ?? '').toLowerCase() !== 'used')
    .sort((a, b) => Number(a.price) - Number(b.price));
}

// Decide qué haría la regla con una publicación. Función pura.
//   base: precio sobre el que se calcula el 75 % (el original si el sistema ya la bajó; si no, el actual).
//   ofertas: ajenas ordenadas por precio, cada una con `entrega`: 'inmediato' | 'demanda' | 'sin_dato'
//            (las que no se llegaron a verificar vienen sin `entrega`).
export function decidirRegla({ precio, base, ofertas }) {
  const p = Number(precio), b = Number(base) > 0 ? Number(base) : p;
  const techo = entero(b * (1 + SUBIDA_SIN_INMEDIATO));
  const lista = Array.isArray(ofertas) ? ofertas : [];
  const out = (accion, extra = {}) => ({ accion, precio: p, base: b, ...extra });
  let sinDatoAntes = 0;
  for (const o of lista) {
    if (o.entrega === 'inmediato') {
      // Un competidor sin dato más barato que este inmediato podría ser otro inmediato: no se decide.
      if (sinDatoAntes) return out('sin_dato', { motivo: 'competidor más barato sin plazo legible' });
      const objetivo = Math.min(entero(Number(o.price) * (1 - DESCUENTO_INMEDIATO)), techo);
      if (objetivo <= 0) return out('sin_dato', { motivo: 'precio inválido' });
      const accion = objetivo < p ? 'bajar' : objetivo > p ? 'subir_bajo_inmediato' : 'igual';
      return out(accion, { objetivo, inmediato: Number(o.price), inmediato_item: o.item_id });
    }
    if (o.entrega === 'demanda') continue;
    // sin_dato o no verificada
    sinDatoAntes++;
  }
  if (sinDatoAntes) return out('sin_dato', { motivo: 'no se leyó el plazo de todos los competidores' });
  // Ningún competidor con entrega inmediata (o ningún competidor): sube 75 % sobre la base.
  const demanda = lista.filter(o => o.entrega === 'demanda').map(o => Number(o.price));
  const masBarataDemanda = demanda.length ? Math.min(...demanda) : null;
  if (techo <= p) return out('igual', { objetivo: p, motivo: 'ya está en el 75 % o más' });
  return out('subir_75', { objetivo: techo, demanda_mas_barata: masBarataDemanda, queda_detras_de_demanda: masBarataDemanda !== null && masBarataDemanda < techo });
}

export function conteos(filas) {
  const c = {};
  for (const f of filas) c[f.accion] = (c[f.accion] ?? 0) + 1;
  return { medidas: filas.length, ...c, subir_75_detras_de_demanda: filas.filter(f => f.accion === 'subir_75' && f.queda_detras_de_demanda).length };
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
  const limite = Number(opt('limite', Infinity));
  const estadoDir = opt('estado'), salida = opt('salida', '.');
  let estado = {};
  const archivoEstado = estadoDir ? join(estadoDir, `${cuenta.clave}.json`) : null;
  if (archivoEstado && existsSync(archivoEstado)) { try { estado = JSON.parse(readFileSync(archivoEstado, 'utf8')); } catch { estado = {}; } }
  const previos = estado.publicaciones ?? {};

  const ml = crearCliente(fuenteTokenD1(cuenta), { concurrencia: 4 }); // sólo GET en este archivo
  const yo = await ml.get('/users/me');
  if (String(yo?.id) !== cuenta.sellerId) throw Object.assign(new Error('token_de_otra_cuenta'), { fatal: true });

  const ids = await idsActivos(ml, cuenta.sellerId);
  const items = [...(await detalle(ml, ids)).values()].filter(i => i.status === 'active' && i.currency_id === 'UYU' && !i.variaciones);
  const conFicha = items.filter(i => i.catalog_product_id).slice(0, limite);
  const sinFicha = items.filter(i => !i.catalog_product_id).length;

  const cacheOfertas = new Map(), cacheEntrega = new Map();
  const ofertasDe = async pid => { if (!cacheOfertas.has(pid)) cacheOfertas.set(pid, await ofertasCatalogo(ml, pid)); return cacheOfertas.get(pid); };
  const filas = []; let errores = 0;
  await enParalelo(conFicha, 4, async it => {
    try {
      const ajenas = ofertasAjenas(it, await ofertasDe(it.catalog_product_id), { sellerId: cuenta.sellerId, casa: HOUSE_SELLERS });
      const medidas = [];
      for (const [n, o] of ajenas.entries()) {
        if (n >= MAX_VERIFICADAS) { medidas.push({ item_id: o.item_id, price: Number(o.price) }); continue; }
        const entrega = SLOW_SELLERS.has(String(o.seller_id)) ? 'demanda' : await entregaDe(ml, o.item_id, cacheEntrega);
        medidas.push({ item_id: o.item_id, price: Number(o.price), entrega });
        if (entrega === 'inmediato') break; // las más caras que el primer inmediato no cambian la decisión
      }
      const previo = previos?.[it.id];
      const base = Number(previo?.precio_original) > 0 ? Number(previo.precio_original) : Number(it.price);
      filas.push({ id: it.id, titulo: String(it.title ?? '').slice(0, 70), catalogo: !!it.catalog_listing, en_promo: it.original_price != null, competidores: ajenas.length, ...decidirRegla({ precio: it.price, base, ofertas: medidas }) });
    } catch (e) { if (e?.fatal || e?.status === 429) throw e; errores++; }
  });

  const fecha = new Date().toISOString().slice(0, 10);
  const resumen = { fecha, cuenta: cuenta.clave, activas: items.length, con_ficha: conFicha.length, sin_ficha_no_medibles: sinFicha, errores, ...conteos(filas) };
  mkdirSync(salida, { recursive: true });
  writeFileSync(join(salida, `${cuenta.clave}-regla-inmediata.json`), JSON.stringify({ resumen, filas }, null, 1));
  console.log(JSON.stringify(resumen)); // sólo conteos: el log es público
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) main().catch(e => { console.error('regla-inmediata:', e.message); process.exit(1); });
