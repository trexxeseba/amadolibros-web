// Chequeo diario de las fichas de catálogo de Hermes (HERMES_PROMOSML).
//
//   node hermes-monitor/chequeo.mjs <fichas.json> <historial.json> [--real]
//
// Por cada ficha, UNA por vez y con 500 ms de pausa (en paralelo Mercado Libre devuelve resultados
// cruzados), lee con la API oficial la lista de ofertas y registra el precio de Hermes y si sigue
// ofreciendo. Si dejó de ofrecer (sin stock o pausada) y la ficha tiene "Mi publicación (MLU)"
// asignada en el Excel, PAUSA esa publicación de Amado Vintage (nunca publica ni reactiva).
// La cuenta es Amado Vintage (CUENTA_HERMES), nunca Amado Libros. Sin --real sólo lee, registra y avisa. Credenciales: token de D1 (secretos del repo), nunca en código.
import fs from 'node:fs/promises';
import {CUENTAS} from '../precio-ganador/src/config.mjs';
import {fuenteTokenD1} from '../precio-ganador/src/token.mjs';
import {crearCliente} from '../precio-ganador/src/ml.mjs';
import {CUENTA_HERMES, ofertaDeHermes, estadoFicha, ultimosPorFicha, cambioDePrecio, fallaGeneral, hoyUy, armarResumen} from './lib.mjs';

const PAUSA_MS = 500; // entre una consulta y otra, a propósito: en paralelo ML devuelve resultados cruzados
const MAX_PAUSAS = 30;
const pausa = ms => new Promise(r => setTimeout(r, ms));

export async function leerFicha(ml, producto, pausaMs = PAUSA_MS) {
  const ofertas = [];
  for (let offset = 0; offset < 200; offset += 50) {
    await pausa(pausaMs);
    let r;
    try { r = await ml.get(`/products/${producto}/items?limit=50&offset=${offset}`); }
    catch (e) { return {error: e.code ?? String(e)}; }
    ofertas.push(...(r?.results ?? []));
    if (ofertaDeHermes(ofertas) || ofertas.length >= (r?.paging?.total ?? 0)) break;
  }
  return {oferta: ofertaDeHermes(ofertas), total: ofertas.length, ofertas};
}

async function pausarMia(ml, ficha, real) {
  const propia = CUENTAS[CUENTA_HERMES].sellerId;
  let item;
  try { item = await ml.get(`/items/${ficha.mi_mlu}`); } catch (e) { return {resultado: 'no_se_pudo_leer'}; }
  if (String(item?.seller_id) !== String(propia)) return {resultado: 'no_es_de_vintage_no_se_toca'};
  if (item.status !== 'active') return {resultado: `ya_estaba_${item.status}`};
  if (!real) return {resultado: 'se_pausaria'};
  try { await ml.put(`/items/${ficha.mi_mlu}`, {status: 'paused'}); } catch (e) { return {resultado: `fallo_${e.code}`}; }
  const despues = await ml.get(`/items/${ficha.mi_mlu}`).catch(() => null);
  return {resultado: despues?.status === 'active' ? 'sigue_activa' : 'pausada'};
}

export async function correr({fichas, historial, real, ml, now = Date.now(), pausaMs = PAUSA_MS}) {
  const fecha = hoyUy(now);
  const previos = ultimosPorFicha(historial);
  const filas = [];
  for (const f of fichas) {
    const lec = await leerFicha(ml, f.producto, pausaMs);
    const estado = estadoFicha(lec);
    filas.push({...f, estado, precio: lec.oferta?.price ?? null, item: lec.oferta?.item_id ?? null, ofertas_total: lec.total ?? null});
  }
  const falla = fallaGeneral(filas.map(f => f.estado));
  const cambios = [];
  for (const f of filas) {
    const prev = previos.get(f.producto);
    const pct = cambioDePrecio(prev?.precio, f.precio);
    if (pct !== null) cambios.push({n: f.n, titulo: f.titulo, antes: prev.precio, ahora: f.precio, pct});
  }
  const pausadas = [];
  if (!falla) {
    for (const f of filas.filter(x => x.estado === 'sin_oferta' && x.mi_mlu).slice(0, MAX_PAUSAS)) {
      // Doble lectura antes de actuar: una ficha que no aparece una vez puede ser un hipo de la API.
      const otra = await leerFicha(ml, f.producto, pausaMs);
      if (estadoFicha(otra) !== 'sin_oferta') { f.estado = otra.error ? 'error' : 'ofrece'; continue; }
      pausadas.push({...f, ...(await pausarMia(ml, f, real))});
    }
  }
  const nuevas = filas.map(f => ({fecha, ficha: f.n, producto: f.producto, precio: f.precio, ofrece: f.estado === 'ofrece', estado: f.estado, stock: null}));
  return {fecha, filas, cambios, pausadas, falla, nuevas, resumen: armarResumen({fecha, real, filas, pausadas, cambios, falla})};
}

async function main() {
  const [, , fichasPath, histPath, ...flags] = process.argv;
  const real = flags.includes('--real');
  const fichas = JSON.parse(await fs.readFile(fichasPath, 'utf8'));
  const historial = JSON.parse(await fs.readFile(histPath, 'utf8').catch(() => '[]'));
  const ml = crearCliente(fuenteTokenD1(CUENTAS[CUENTA_HERMES]), {concurrencia: 1});
  const r = await correr({fichas, historial, real, ml});
  // Una corrida por día: si ya había filas de hoy, se reemplazan.
  const resto = historial.filter(h => h.fecha !== r.fecha);
  await fs.writeFile(histPath, JSON.stringify([...resto, ...r.nuevas]));
  await fs.writeFile(histPath.replace(/historial\.json$/, 'resumen.txt'), r.resumen);
  console.log(r.resumen.split('\n').slice(0, 2).join('\n'));
  console.log(JSON.stringify({llamadas: ml.stats}));
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error('fallo', e.code ?? e.message); process.exit(1); });
