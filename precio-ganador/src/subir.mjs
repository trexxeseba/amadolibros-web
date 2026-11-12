// Subida aprobada de los libros que ganamos baratos (Seba, 12/11/2026: "los 95 de un solo paso").
//
//   node precio-ganador/src/subir.mjs --cuenta libros --estado DIR [--real]
//
// Lee state/subidas-aprobadas-<cuenta>.json (la lista que Seba aprobó, con el precio que tenía
// cada una) y, para cada publicación, ANTES de tocarla vuelve a comprobar todo:
//   - sigue activa, en pesos, sin variaciones, sin precio administrado por ML;
//   - el precio es el mismo que el aprobado (si alguien lo cambió a mano, no se toca);
//   - sin promoción activa ni descuento a la vista, y sin automatización de precios;
//   - sigue ganando la ficha (winning) y el competidor más barato de otro vendedor sigue
//     siendo 25 % o más caro (y no más de 3 veces: eso sería un usado u otra edición);
//   - el precio nuevo es el 97 % del competidor, sin subir más de 30 %, y sube 10 pesos o más.
// Escribe con PUT, verifica el precio y deja la publicación en state/<cuenta>.json con
// precio_original = el nuevo precio: si después pierde la ficha, el sistema la baja hasta ganar.
// Sin --real sólo lista lo que haría.
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CUENTAS } from './config.mjs';
import { fuenteTokenD1 } from './token.mjs';
import { crearCliente } from './ml.mjs';
import { detalle } from './publicaciones.mjs';
import { ofertasCatalogo, promocionActiva } from './competencia.mjs';

export const RAZON_MINIMA = 1.25, RAZON_MAXIMA = 3, FACTOR = 0.97, SUBIDA_MAXIMA = 1.30, PASO_MINIMO = 10;

// Parte pura (con tests): decide una publicación con todo lo ya leído.
export function planSubida({ aprobado, item, minExterno, ptwStatus, promo }) {
  if (!item) return { accion: 'omitir', motivo: 'no se pudo leer la publicación' };
  if (item.status !== 'active') return { accion: 'omitir', motivo: 'no está activa' };
  if (item.currency_id !== 'UYU' || item.variaciones) return { accion: 'omitir', motivo: 'moneda o variaciones' };
  if (item.precio_dinamico) return { accion: 'omitir', motivo: 'precio administrado por Mercado Libre' };
  if (item.original_price !== null && item.original_price !== undefined) return { accion: 'omitir', motivo: 'descuento a la vista' };
  if (promo !== false) return { accion: 'omitir', motivo: promo === true ? 'promoción activa' : 'no se pudo confirmar la promoción' };
  if (Number(item.price) !== Number(aprobado)) return { accion: 'omitir', motivo: `el precio cambió (aprobado ${aprobado}, hoy ${item.price})` };
  if (ptwStatus !== 'winning') return { accion: 'omitir', motivo: `ya no gana la ficha (${ptwStatus ?? 'sin dato'})` };
  if (!Number.isFinite(minExterno)) return { accion: 'omitir', motivo: 'sin competidor visible' };
  const precio = Number(item.price), razon = minExterno / precio;
  if (razon < RAZON_MINIMA) return { accion: 'omitir', motivo: `el competidor ya no está tan arriba (${razon.toFixed(2)} veces)` };
  if (razon > RAZON_MAXIMA) return { accion: 'omitir', motivo: `competidor sospechoso (${razon.toFixed(1)} veces: usado u otra edición)` };
  const objetivo = Math.floor(minExterno * FACTOR), tope = Math.floor(precio * SUBIDA_MAXIMA);
  if (objetivo > tope) return { accion: 'omitir', motivo: 'necesitaría más de un paso' };
  if (objetivo - precio < PASO_MINIMO) return { accion: 'omitir', motivo: 'la suba sería menor a 10 pesos' };
  return { accion: 'subir', objetivo, motivo: `competidor ${minExterno}, sube ${objetivo - precio}` };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (n, d = null) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
  const cuenta = CUENTAS[opt('cuenta')];
  if (!cuenta) { console.error('Usar --cuenta libros|vintage'); process.exit(2); }
  const real = args.includes('--real');
  const dir = opt('estado', 'state');
  const archivoLista = join(dir, `subidas-aprobadas-${cuenta.clave}.json`);
  if (!existsSync(archivoLista)) { console.log('No hay lista aprobada: nada que subir.'); return; }
  const lista = JSON.parse(readFileSync(archivoLista, 'utf8')).publicaciones ?? {};
  const archivo = join(dir, `${cuenta.clave}.json`);
  const estado = JSON.parse(readFileSync(archivo, 'utf8'));
  const ml = crearCliente(fuenteTokenD1(cuenta), { concurrencia: 2 });
  const yo = await ml.get('/users/me');
  if (String(yo?.id) !== cuenta.sellerId) throw Object.assign(new Error('token_de_otra_cuenta'), { fatal: true });
  const ids = Object.keys(lista);
  const items = await detalle(ml, ids);
  const conteo = { aprobadas: ids.length, subidas: 0, omitidas: 0, errores: 0, no_verificadas: 0 };
  const motivos = {};
  const ahora = new Date().toISOString();
  for (const id of ids) {
    const item = items.get(id) ?? null;
    let minExterno = NaN, ptwStatus = null, promo = null;
    try {
      if (item?.catalog_product_id) {
        const of = (await ofertasCatalogo(ml, item.catalog_product_id)).filter(o => String(o.seller_id) !== String(cuenta.sellerId) && o.item_id !== id && Number.isFinite(Number(o.price)));
        if (of.length) minExterno = Math.min(...of.map(o => Number(o.price)));
      }
      ptwStatus = String((await ml.get(`/items/${id}/price_to_win?version=v2`))?.status ?? '');
      promo = await promocionActiva(ml, id);
    } catch (e) { if (e?.fatal || e?.status === 429) throw e; }
    const plan = planSubida({ aprobado: lista[id].precio, item, minExterno, ptwStatus, promo });
    if (plan.accion !== 'subir') { conteo.omitidas++; motivos[plan.motivo.replace(/\d+/g, 'N')] = (motivos[plan.motivo.replace(/\d+/g, 'N')] ?? 0) + 1; console.log(process.env.GITHUB_ACTIONS ? `${id}: omitida` : `${id}: omitida (${plan.motivo})`); continue; }
    console.log(process.env.GITHUB_ACTIONS ? `${id}: sube` : `${id}: ${item.price} → ${plan.objetivo} (${plan.motivo})`);
    if (!real) continue;
    try {
      await ml.put(`/items/${id}`, { price: plan.objetivo });
      const leido = (await detalle(ml, [id])).get(id);
      if (leido?.price !== plan.objetivo) { conteo.no_verificadas++; console.log(`${id}: no se verificó`); continue; }
      estado.publicaciones[id] = { titulo: String(item.title ?? '').slice(0, 80), precio_original: plan.objetivo, precio_aplicado: plan.objetivo, precio_anterior: Number(item.price), subida: true, fecha_primera_baja: ahora, fecha: ahora };
      writeFileSync(archivo + '.tmp', JSON.stringify(estado, null, 2) + '\n'); renameSync(archivo + '.tmp', archivo);
      conteo.subidas++;
    } catch (e) { if (e?.fatal) throw e; conteo.errores++; console.log(`${id}: error ${e?.code ?? 'error'}`); }
  }
  console.log(JSON.stringify({ modo: real ? 'real' : 'dry_run', ...conteo, motivos }));
  if (conteo.errores || conteo.no_verificadas) process.exit(1);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) main().catch(e => { console.error('subir:', e.message); process.exit(1); });
