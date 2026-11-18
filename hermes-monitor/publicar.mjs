// Republica en Amado VINTAGE (nunca Amado Libros) las fichas de catálogo de Hermes: 1 unidad, a 1 % menos que su precio.
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
import {d1Client} from '../scripts/vintage-cloud/d1.mjs';
import {brakeOn, blockedIsbns} from '../scripts/vintage-cloud/vigia-pi.mjs';
import {ipRisk} from '../worker-sync/ip-risk.js';
import {exigirVintage, exigirItemDeVintage} from './guardia.mjs';
import {precioMio, armarPayload, CUENTA_HERMES, TOPE_DIARIO_COMPARTIDO, inicioDiaUy} from './lib.mjs';

const pausa = ms => new Promise(r => setTimeout(r, ms));

// /items/validate con el cuerpo completo de las causas: 2xx acepta; un 400 acepta solo si todas las
// causas son de tipo warning (misma regla que el publicador de la cola de Amado Libros).
async function validar(payload) {
  const res = await fetch('https://api.mercadolibre.com/items/validate', {
    method: 'POST', signal: AbortSignal.timeout(25000),
    headers: {Authorization: 'Bearer ' + await fuente.getToken(), Accept: 'application/json', 'Content-Type': 'application/json'},
    body: JSON.stringify(payload),
  }).catch(() => null);
  if (!res) return {ok: false, causas: [{type: 'error', code: 'transporte'}]};
  if (res.ok) return {ok: true, causas: []};
  const j = await res.json().catch(() => null);
  const causas = (Array.isArray(j?.cause) ? j.cause : []).map(c => ({type: c?.type ?? null, code: c?.code ?? null, message: String(c?.message ?? '').slice(0, 160)}));
  const soloAdvertencias = res.status === 400 && causas.length > 0 && causas.every(c => c.type === 'warning');
  return {ok: soloAdvertencias, causas, status: res.status};
}
const [, , fichasPath, pubPath, ...flags] = process.argv;
const real = flags.includes('--real');
const maxPedido = Number(flags.find(f => f.startsWith('--max='))?.slice(6) || 1e9);
let max = maxPedido;
const require_text = await fs.readFile(pubPath, 'utf8').catch(() => '');
const fichas = JSON.parse(await fs.readFile(fichasPath, 'utf8'));
const descartadas = new Set(JSON.parse(await fs.readFile(new URL('./descartadas.json', import.meta.url), 'utf8').catch(() => '{"descartadas":[]}')).descartadas.map(d => d.producto));
const publicadas = (() => { try { return JSON.parse(require_text) ?? {}; } catch { return {}; } })();
const cuenta = CUENTAS[CUENTA_HERMES];
const fuente = fuenteTokenD1(cuenta);
const ml = crearCliente(fuente, {concurrencia: 1});
const seller = cuenta.sellerId;
const query = d1Client();

// Candado de cuenta: el token tiene que ser el de Vintage, verificado con Mercado Libre, antes de cualquier cosa.
await exigirVintage(ml);

// Protecciones de Vintage: freno del vigía de propiedad intelectual, ISBN bloqueados y techo diario
// compartido con la subida de SBS (lo publicado hoy por SBS + lo de Hermes hoy no pasa del tope).
const freno = await brakeOn(query);
if (freno) { console.log('FRENO DEL VIGIA ACTIVO: no se publica nada.', JSON.stringify(freno).slice(0, 200)); process.exit(0); }
const bloqueados = await blockedIsbns(query);
const inicio = inicioDiaUy();
const hoyHermes = Object.values(publicadas).filter(p => Number(p.ts) >= inicio).length;
const hoySbs = Number((await query("SELECT COUNT(*) n FROM ml_vintage_pub_receipts WHERE seller_id=? AND state='published' AND created_at>=?", [seller, inicio]))[0]?.n ?? 0);
let cupo = Math.max(0, TOPE_DIARIO_COMPARTIDO - hoySbs - hoyHermes);
console.log(`hoy: SBS ${hoySbs}, Hermes ${hoyHermes}, tope compartido ${TOPE_DIARIO_COMPARTIDO}, cupo ${cupo}`);
if (cupo === 0) { console.log('Sin cupo diario: no se publica nada.'); process.exit(0); }
max = Math.min(maxPedido, cupo);

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
  if (publicadas[f.producto] || f.mi_mlu || descartadas.has(f.producto)) continue;
  const lec = await leerFicha(ml, f.producto);
  if (!lec.oferta) { filas.push({n: f.n, resultado: 'hermes_no_ofrece'}); continue; }
  await pausa(500);
  const prod = await ml.get(`/products/${f.producto}`).catch(() => null);
  if (!prod || prod.status !== 'active') { filas.push({n: f.n, resultado: 'ficha_inactiva'}); continue; }
  const isbn = (prod.attributes ?? []).find(a => a.id === 'GTIN' || a.id === 'ISBN')?.value_name ?? null;
  if (isbn && bloqueados.has(String(isbn))) { filas.push({n: f.n, resultado: 'isbn_bloqueado_por_denuncia'}); console.log(`${f.n}\tsalteada: ISBN bloqueado por denuncia`); continue; }
  const editorial = (prod.attributes ?? []).find(a => ['BOOK_PUBLISHER', 'PUBLISHER'].includes(a.id))?.value_name;
  const riesgo = ipRisk([prod.name, prod.family_name].filter(Boolean).join(' '), editorial);
  if (riesgo) { filas.push({n: f.n, resultado: 'riesgo_pi_' + riesgo}); console.log(`${f.n}\tsalteada: riesgo de propiedad intelectual (${riesgo})`); continue; }
  const precio = precioMio(lec.oferta.price);
  const payload = armarPayload({producto: f.producto, precio, categoria: lec.oferta.category_id, nombre: prod.name, familyName: prod.family_name, usaFamilyName, isbn});
  let valido = null, ultimo = null;
  for (const shipping of variantes) {
    await pausa(500);
    const v = await validar({...payload, shipping});
    if (v.ok) { valido = shipping; ultimo = v; break; }
    ultimo = v;
    if (!v.causas.some(c => /shipping/.test(String(c.code)))) break;
  }
  if (!valido) { erroresSeguidos++; filas.push({n: f.n, resultado: 'no_valida', causas: ultimo?.causas}); console.log(`${f.n}\tNO VALIDA ${JSON.stringify(ultimo?.causas)}`); continue; }
  if (ultimo?.causas?.length) console.log(`${f.n}\tadvertencias ${JSON.stringify(ultimo.causas)}`);
  if (!real) { erroresSeguidos = 0; hechas++; filas.push({n: f.n, resultado: 'valida', precio}); console.log(`${f.n}\tvalida\tprecio ${precio} (Hermes ${lec.oferta.price})`); continue; }
  await pausa(1000);
  try {
    const r = await ml.post('/items', {...payload, shipping: valido});
    // Verificación posterior: si por cualquier razón quedó en otra cuenta, se pausa en el acto y se corta todo.
    try { exigirItemDeVintage(await ml.get(`/items/${r?.id}`)); }
    catch (e) { await ml.put(`/items/${r?.id}`, {status: 'paused'}).catch(() => {}); console.log(`${f.n}\tCORTE: ${e.code} (${r?.id}), se pausó y se frena todo`); process.exit(1); }
    publicadas[f.producto] = {item_id: r?.id, precio, precio_hermes: lec.oferta.price, fecha: new Date().toISOString().slice(0, 10), ts: Date.now(), cuenta: CUENTA_HERMES};
    await fs.writeFile(pubPath, JSON.stringify(publicadas, null, 1));
    erroresSeguidos = 0; hechas++;
    console.log(`${f.n}\tPUBLICADA ${r?.id} precio ${precio}`);
  } catch (e) { erroresSeguidos++; console.log(`${f.n}\tERROR al publicar ${e.code} ${JSON.stringify(e.detalle)}`); }
}
console.log('\nRESUMEN', JSON.stringify({modo: real ? 'real' : 'validar', procesadas: hechas, errores_seguidos: erroresSeguidos, llamadas: ml.stats.llamadas}));
