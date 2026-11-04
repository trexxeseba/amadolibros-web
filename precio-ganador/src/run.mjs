// Precio Ganador: una corrida para una cuenta.
//
//   node precio-ganador/src/run.mjs --cuenta libros [--dry-run] [--max-marcadas 100]
//        [--limite N] [--estado DIR] [--salida DIR] [--correo-diario]
//
// DRY_RUN es el modo por defecto: para cambiar precios hace falta --real.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CUENTAS, MAX_CAMBIOS_POR_CORRIDA, STOCK_DEMANDA_DEFAULT, UMBRAL_UYU, fechaMontevideo } from './config.mjs';
import { fuenteTokenD1 } from './token.mjs';
import { crearCliente } from './ml.mjs';
import { idsActivos, detalle } from './publicaciones.mjs';
import { competencia, promocionActiva, MUESTRAS } from './competencia.mjs';
import { decidir, CAMBIA } from './decision.mjs';
import { resumir, tablaMarkdown, enviarResumen } from './reporte.mjs';

const args = process.argv.slice(2);
const opt = (n, d = null) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const flag = n => args.includes('--' + n);

const cuenta = CUENTAS[opt('cuenta')];
if (!cuenta) { console.error('Cuenta desconocida. Usar --cuenta libros|vintage'); process.exit(2); }
const real = flag('real') && !flag('dry-run');
const maxMarcadas = Number(opt('max-marcadas', Infinity));
const limite = Number(opt('limite', Infinity));
const dirEstado = opt('estado', 'state');
const dirSalida = opt('salida', 'salida');
const stockDemanda = Number(process.env.STOCK_DEMANDA || STOCK_DEMANDA_DEFAULT);

async function leerJson(f, d) { try { return JSON.parse(await readFile(f, 'utf8')); } catch { return d; } }

async function main() {
  const inicio = new Date();
  const archivoEstado = join(dirEstado, `${cuenta.clave}.json`);
  const estado = await leerJson(archivoEstado, { cuenta: cuenta.clave, seller_id: cuenta.sellerId, publicaciones: {} });
  const pisos = await leerJson(new URL(`../pisos/${cuenta.clave}.json`, import.meta.url), {});

  const ml = crearCliente(fuenteTokenD1(cuenta));
  // Identidad: el token tiene que ser de la cuenta pedida. Si no, se corta.
  const yo = await ml.get('/users/me');
  if (String(yo?.id) !== cuenta.sellerId) throw Object.assign(new Error('token_de_otra_cuenta'), { fatal: true });

  const ids = await idsActivos(ml, cuenta.sellerId, { limite });
  // Las que el sistema bajó antes van primero y siempre se revisan.
  const enEstado = Object.keys(estado.publicaciones);
  const orden = [...new Set([...enEstado, ...ids])];
  const items = await detalle(ml, orden);
  console.log(`${cuenta.nombre}: ${ids.length} activas, ${enEstado.length} en estado`);

  const filas = []; let marcadas = 0;
  const lote = 40;
  for (let i = 0; i < orden.length; i += lote) {
    const parte = orden.slice(i, i + lote).filter(id => items.get(id)?.status === 'active');
    const res = await Promise.all(parte.map(async id => {
      const item = items.get(id), previo = estado.publicaciones[id];
      try {
        const comp = await competencia(ml, item, { necesitaTecho: Boolean(previo), sellerId: cuenta.sellerId });
        let d = decidir({ item, comp, promo: false, previo, piso: num(pisos[id]), tocarStock: cuenta.tocarStockDemanda, stockDemanda });
        if (CAMBIA.has(d.accion)) {
          const promo = await promocionActiva(ml, id);
          d = decidir({ item, comp, promo, previo, piso: num(pisos[id]), tocarStock: cuenta.tocarStockDemanda, stockDemanda });
        }
        return { item, comp, d, previo };
      } catch (e) {
        if (e?.fatal) throw e;
        return { item, comp: null, d: { accion: 'error_consulta', motivo: e?.code ?? 'error' }, previo };
      }
    }));
    for (const r of res) { filas.push(r); if (r.comp?.marcada && !r.previo) marcadas++; }
    if (marcadas >= maxMarcadas && i + lote >= enEstado.length) break;
  }
  // Publicaciones del estado que ya no están activas: se conservan, no se tocan.
  for (const id of enEstado) if (!items.has(id) || items.get(id).status !== 'active') filas.push({ item: items.get(id) ?? { id }, comp: null, d: { accion: 'inactiva', motivo: 'no está activa' }, previo: estado.publicaciones[id] });

  const cambios = filas.filter(f => CAMBIA.has(f.d.accion));
  if (real && cambios.length > MAX_CAMBIOS_POR_CORRIDA) throw Object.assign(new Error(`freno: ${cambios.length} cambios planeados (máximo ${MAX_CAMBIOS_POR_CORRIDA})`), { fatal: true });

  // Aplicar (sólo en modo real). Una que falla no frena a las demás.
  const ahora = new Date().toISOString();
  for (const f of cambios) {
    f.aplicado = false;
    if (!real) continue;
    const body = { price: f.d.precio, ...(Number.isFinite(f.d.stock) ? { available_quantity: f.d.stock } : {}) };
    try {
      const r = await ml.put(`/items/${f.item.id}`, body);
      if (Number(r?.price) !== f.d.precio) throw Object.assign(new Error('precio_no_confirmado'), { code: 'precio_no_confirmado' });
      f.aplicado = true;
      const id = f.item.id, previo = estado.publicaciones[id];
      if (f.d.accion === 'restaurar') delete estado.publicaciones[id];
      else estado.publicaciones[id] = {
        titulo: f.item.title?.slice(0, 80) ?? '',
        precio_original: previo?.precio_original ?? f.item.price,
        precio_aplicado: f.d.precio,
        fecha_primera_baja: previo?.fecha_primera_baja ?? ahora,
        fecha: ahora,
        ...(previo?.stock_original !== undefined ? { stock_original: previo.stock_original } : Number.isFinite(f.d.stock) ? { stock_original: f.item.available_quantity } : {}),
        ...(f.item.demanda ? { dias_demanda: f.item.dias_demanda } : {}),
      };
    } catch (e) {
      f.d = { ...f.d, accion: 'error_aplicar', motivo: e?.code ?? 'error', detalle: e?.detalle ?? null };
    }
  }
  // Editadas a mano: salen del estado sin tocarlas.
  if (real) for (const f of filas) if (f.d.accion === 'liberar_editada') delete estado.publicaciones[f.item.id];

  const resumen = resumir(filas, { cuenta, real, inicio, ids: ids.length, stats: ml.stats, umbral: UMBRAL_UYU });
  await mkdir(dirSalida, { recursive: true });
  await writeFile(join(dirSalida, `${cuenta.clave}-resumen.json`), JSON.stringify(resumen, null, 2));
  await writeFile(join(dirSalida, `${cuenta.clave}-detalle.md`), tablaMarkdown(filas, { cuenta, real, resumen }));
  await writeFile(join(dirSalida, `${cuenta.clave}-muestras-api.json`), JSON.stringify(MUESTRAS, null, 2));
  if (real) {
    await mkdir(dirEstado, { recursive: true });
    estado.actualizado = ahora;
    await writeFile(archivoEstado, JSON.stringify(estado, null, 2) + '\n');
    // Acumulado del día para el mail de las 21:00.
    const dia = join(dirEstado, 'diario', `${cuenta.clave}-${fechaMontevideo(inicio)}.json`);
    const acum = await leerJson(dia, { corridas: [] });
    acum.corridas.push(resumen.contadores);
    await mkdir(join(dirEstado, 'diario'), { recursive: true });
    await writeFile(dia, JSON.stringify(acum, null, 2) + '\n');
    if (flag('correo-diario')) console.log('Correo:', JSON.stringify(await enviarResumen({ cuenta, acum, resumen })));
  } else if (flag('correo-diario')) {
    console.log('Correo:', JSON.stringify(await enviarResumen({ cuenta, acum: { corridas: [resumen.contadores] }, resumen })));
  }
  // Sólo conteos en el log (el repo es público).
  console.log(JSON.stringify({ modo: real ? 'real' : 'dry_run', ...resumen.contadores, llamadas: ml.stats.llamadas, reintentos: ml.stats.reintentos }));
  if (resumen.contadores.errores > 0 && resumen.contadores.errores === resumen.contadores.revisadas) throw new Error('todas las consultas fallaron');
}

const num = v => (v === null || v === undefined || !Number.isFinite(Number(v))) ? null : Number(v);

main().catch(e => { console.error('Corrida fallida:', e?.code ?? e?.message ?? 'error'); process.exit(1); });
