// Republica en Amado Libros las fichas de catálogo de Hermes: 1 unidad, a 1 % menos que su precio.
//
//   node hermes-monitor/publicar.mjs <fichas.json> <publicadas.json> [--real] [--max=N]
//
// Sin --real sólo VALIDA con /items/validate (Mercado Libre dice si la publicación sería válida y no
// crea nada). Con --real publica de a una, con pausa; ante cualquier error de una ficha sigue con la
// siguiente y frena si hay 5 errores seguidos. Nunca reactiva ni toca publicaciones existentes.
// Lo publicado queda en publicadas.json (ficha -> publicación) para que el chequeo diario las pause
// cuando Hermes deje de ofrecer la ficha.
import fs from 'node:fs/promises';
import {CUENTAS} from '../precio-ganador/src/config.mjs';
import {fuenteTokenD1} from '../precio-ganador/src/token.mjs';
import {crearCliente} from '../precio-ganador/src/ml.mjs';
import {leerFicha} from './chequeo.mjs';
import {precioMio, armarPayload} from './lib.mjs';

const pausa = ms => new Promise(r => setTimeout(r, ms));
const [, , fichasPath, pubPath, ...flags] = process.argv;
const real = flags.includes('--real');
const max = Number(flags.find(f => f.startsWith('--max='))?.slice(6) || 1e9);
const fichas = JSON.parse(await fs.readFile(fichasPath, 'utf8'));
const publicadas = JSON.parse(await fs.readFile(pubPath, 'utf8').catch(() => '{}'));
const ml = crearCliente(fuenteTokenD1(CUENTAS.libros), {concurrencia: 1});
const seller = CUENTAS.libros.sellerId;

const prefs = await ml.get(`/users/${seller}/shipping_preferences`).catch(() => null);
const yo = await ml.get(`/users/${seller}`).catch(() => null);
const usaFamilyName = Array.isArray(yo?.tags) && yo.tags.includes('user_product_seller');
const logistica = (prefs?.logistics ?? []).find(l => l?.mode === 'me2')?.types?.find(t => t.default)?.type ?? null;
const base = {mode: 'me2', local_pick_up: false, free_shipping: true, free_methods: []};
const variantes = [base, ...(logistica ? [{...base, logistic_type: logistica}, {...base, logistic_type: logistica, local_pick_up: true}] : [{...base, local_pick_up: true}])];
console.log(`modo ${real ? 'REAL' : 'solo validar'} | family_name ${usaFamilyName} | logística ${logistica}`);

let hechas = 0, erroresSeguidos = 0;
const filas = [];
for (const f of fichas) {
  if (hechas >= max || erroresSeguidos >= 5) break;
  if (publicadas[f.producto] || f.mi_mlu) continue;
  const lec = await leerFicha(ml, f.producto);
  if (!lec.oferta) { filas.push({n: f.n, resultado: 'hermes_no_ofrece'}); continue; }
  await pausa(500);
  const prod = await ml.get(`/products/${f.producto}`).catch(() => null);
  if (!prod || prod.status !== 'active') { filas.push({n: f.n, resultado: 'ficha_inactiva'}); continue; }
  const isbn = (prod.attributes ?? []).find(a => a.id === 'GTIN' || a.id === 'ISBN')?.value_name ?? null;
  const precio = precioMio(lec.oferta.price);
  const payload = armarPayload({producto: f.producto, precio, categoria: lec.oferta.category_id, nombre: prod.name, familyName: prod.family_name, usaFamilyName, isbn});
  let valido = null, ultimo = null;
  for (const shipping of variantes) {
    await pausa(500);
    try { await ml.post('/items/validate', {...payload, shipping}); valido = shipping; break; }
    catch (e) { ultimo = e; if (!(e.detalle?.cause ?? []).some(c => /shipping/.test(String(c)))) break; }
  }
  if (!valido) { erroresSeguidos++; filas.push({n: f.n, resultado: 'no_valida', error: ultimo?.code, detalle: ultimo?.detalle}); console.log(`${f.n}\tNO VALIDA ${ultimo?.code} ${JSON.stringify(ultimo?.detalle)}`); continue; }
  if (!real) { erroresSeguidos = 0; hechas++; filas.push({n: f.n, resultado: 'valida', precio}); console.log(`${f.n}\tvalida\tprecio ${precio} (Hermes ${lec.oferta.price})`); continue; }
  await pausa(1000);
  try {
    const r = await ml.post('/items', {...payload, shipping: valido});
    publicadas[f.producto] = {item_id: r?.id, precio, precio_hermes: lec.oferta.price, fecha: new Date().toISOString().slice(0, 10)};
    await fs.writeFile(pubPath, JSON.stringify(publicadas, null, 1));
    erroresSeguidos = 0; hechas++;
    console.log(`${f.n}\tPUBLICADA ${r?.id} precio ${precio}`);
  } catch (e) { erroresSeguidos++; console.log(`${f.n}\tERROR al publicar ${e.code} ${JSON.stringify(e.detalle)}`); }
}
console.log('\nRESUMEN', JSON.stringify({modo: real ? 'real' : 'validar', procesadas: hechas, errores_seguidos: erroresSeguidos, llamadas: ml.stats.llamadas}));
