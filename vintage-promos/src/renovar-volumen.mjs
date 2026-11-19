// Renueva la promoción de volumen de Amado Vintage (2341378249) "igual" (Seba, 19/11/2026:
// LIKI, llevando 2, 30 %, combinable): crea la promoción nueva desde que termina la actual
// y le suma los mismos libros.
//
// Modos (MODO): 'prueba' (por defecto) NO escribe nada: lee, arma el plan y lo muestra.
//               'real' escribe, sólo desde main. Antes de escribir verifica con /users/me que el
//               token es de Vintage y que se pudieron leer TODOS los libros de la actual.
// Idempotente: si la renovación ya existe (pending) la reutiliza y no crea otra.
// El log lleva ids de promoción, fechas y totales; nunca ids de libros ni precios.
import fs from 'node:fs/promises';
import { CUENTAS } from '../../precio-ganador/src/config.mjs';
import { fuenteTokenD1 } from '../../precio-ganador/src/token.mjs';
import { crearCliente } from '../../precio-ganador/src/ml.mjs';
import { exigirVintage } from '../../hermes-monitor/guardia.mjs';
import { buscarActual, buscarRenovada, planRenovacion, cuerpoItem, idsDePagina, contar } from './volumen-logica.mjs';

const V2 = 'app_version=v2';
const real = process.env.MODO === 'real';
const NOMBRE = process.env.PROMO_NOMBRE || 'LIKI';
const PORCENTAJE = Number(process.env.PORCENTAJE || 30);
const salida = [];
const decir = s => { salida.push(s); console.log(s); };
const pausa = ms => new Promise(r => setTimeout(r, ms));
const codigo = e => `${e?.code ?? 'error'}${e?.detalle?.message ? `: ${String(e.detalle.message).slice(0, 160)}` : ''}${e?.detalle?.cause?.length ? ` [${e.detalle.cause.join(',')}]` : ''}`;

const ml = crearCliente(fuenteTokenD1(CUENTAS.vintage), { concurrencia: 2 });
const yo = await exigirVintage(ml);
decir(`Cuenta verificada: ${yo.id}. Modo: ${real ? 'REAL (escribe)' : 'prueba (no escribe)'}.`);

const lp = await ml.get(`/seller-promotions/users/${CUENTAS.vintage.sellerId}?${V2}`);
const promos = Array.isArray(lp) ? lp : lp?.results ?? [];
const actual = buscarActual(promos, NOMBRE);
if (!actual) { decir(`No hay una promoción de volumen "${NOMBRE}" vigente. Corto.`); process.exit(1); }
const ficha = await ml.get(`/seller-promotions/promotions/${encodeURIComponent(actual.id)}?promotion_type=VOLUME&${V2}`);
decir(`Actual: ${actual.id} "${actual.name}" (${actual.status}) ${actual.start_date} a ${actual.finish_date}; llevando ${ficha?.buy_quantity}, ${ficha?.discount_percentage} %, combinable: ${ficha?.allow_combination}.`);

const plan = planRenovacion({ actual, ficha, porcentajeEsperado: PORCENTAJE });
if (plan.error) { decir(`No se renueva: ${plan.error}${plan.actual ? ` (la actual es ${plan.actual} %)` : ''}.`); process.exit(1); }
decir(`Plan: crear ${JSON.stringify(plan.body)} (${plan.dias} días).`);

// Libros de la promoción actual (con la paginación que acepte Mercado Libre).
const libros = new Set();
let total = null, cursorBueno = null;
{
  let cursor = null;
  for (let pagina = 0; pagina < 200; pagina++) {
    const base = `/seller-promotions/promotions/${encodeURIComponent(actual.id)}/items?promotion_type=VOLUME&${V2}&limit=50&status=started`;
    let r = null, ultimoError = null;
    for (const nombre of cursor ? (cursorBueno ? [cursorBueno] : ['searchAfter', 'search_after']) : [null]) {
      try { r = await ml.get(nombre ? `${base}&${nombre}=${encodeURIComponent(cursor)}` : base); cursorBueno = nombre ?? cursorBueno; break; }
      catch (e) { ultimoError = e; }
    }
    if (!r) { decir(`No pude seguir la paginación en la página ${pagina + 1}: ${codigo(ultimoError)}.`); break; }
    total = r?.paging?.total ?? total;
    const ids = idsDePagina(r), antes = libros.size;
    ids.forEach(i => libros.add(i));
    cursor = r?.paging?.searchAfter ?? r?.paging?.search_after ?? null;
    if (!cursor || !ids.length || libros.size === antes) break;
  }
}
decir(`Libros leídos de la actual: ${libros.size}${total !== null ? ` de ${total}` : ''} (cursor: ${cursorBueno ?? 'primera página'}).`);
const completo = total !== null ? libros.size >= Number(total) : false;
if (!completo) decir('LECTURA INCOMPLETA: en modo real no se crea nada hasta leer todos los libros.');

let nueva = buscarRenovada(promos, actual);
if (nueva) decir(`La renovación ya existe: ${nueva.id} (${nueva.status}) ${nueva.start_date} a ${nueva.finish_date}. No se crea otra.`);
if (!real) { decir('Modo prueba: no se escribió nada.'); await cierre(); process.exit(0); }
if (!completo) { decir('Corto sin escribir.'); await cierre(); process.exit(1); }

if (!nueva) {
  try {
    const c = await ml.post(`/seller-promotions/promotions?${V2}`, plan.body);
    decir(`Promoción creada: ${JSON.stringify(c)?.slice(0, 400)}`);
    nueva = { id: c?.id ?? c?.promotion_id ?? c?.promotion?.id };
  } catch (e) { decir(`No se pudo crear la promoción: ${codigo(e)}. No se sumó ningún libro.`); await cierre(); process.exit(1); }
  if (!nueva.id) { decir('Mercado Libre no devolvió el id de la promoción nueva. Corto.'); await cierre(); process.exit(1); }
}
const leida = await ml.get(`/seller-promotions/promotions/${encodeURIComponent(nueva.id)}?promotion_type=VOLUME&${V2}`).catch(e => ({ error: codigo(e) }));
decir(`Promoción nueva leída: ${JSON.stringify(leida)?.slice(0, 500)}`);

// Sumar los libros. Frena ante 5 fallos seguidos con el mismo código (algo está mal, no insistir).
const resultados = []; let seguidos = 0, ultimo = null;
for (const id of libros) {
  try { await ml.post(`/seller-promotions/items/${id}?${V2}`, cuerpoItem(nueva.id)); resultados.push('ok'); seguidos = 0; }
  catch (e) {
    const c = codigo(e); resultados.push(c.slice(0, 120));
    seguidos = c === ultimo ? seguidos + 1 : 1; ultimo = c;
    if (resultados.length === 1) decir(`Primer libro rechazado: ${c}`);
    if (seguidos >= 5) { decir(`Frené: 5 rechazos seguidos (${c}).`); break; }
  }
  await pausa(250);
}
decir(`Libros sumados: ${JSON.stringify(contar(resultados))} de ${libros.size}.`);
await cierre();

async function cierre() {
  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, '## Renovación de la promoción de volumen\n\n' + salida.map(s => `- ${s}`).join('\n') + '\n');
  decir(`Llamadas: ${JSON.stringify(ml.stats)}`);
}
