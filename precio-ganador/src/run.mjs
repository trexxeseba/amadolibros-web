// Precio Ganador: una corrida para una cuenta.
//
//   node precio-ganador/src/run.mjs --cuenta libros [--dry-run] [--max-marcadas 100]
//        [--limite N] [--estado DIR] [--salida DIR] [--correo-diario]
//
// DRY_RUN es el modo por defecto: para cambiar precios hace falta --real.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { CUENTAS, MAX_CAMBIOS_POR_CORRIDA, STOCK_DEMANDA_DEFAULT, UMBRAL_UYU, fechaMontevideo } from './config.mjs';
import { fuenteTokenD1 } from './token.mjs';
import { crearCliente } from './ml.mjs';
import { idsActivos, detalle } from './publicaciones.mjs';
import { competencia, promocionActiva, MUESTRAS } from './competencia.mjs';
import { decidir, CAMBIA } from './decision.mjs';
import { resumir, tablaMarkdown, enviarResumen, informeRegla } from './reporte.mjs';
import { cargarPisosVintage } from './costos-vintage.mjs';

const args = process.argv.slice(2);
const opt = (n, d = null) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const flag = n => args.includes('--' + n);

const cuenta = CUENTAS[opt('cuenta')];
if (!cuenta) { console.error('Cuenta desconocida. Usar --cuenta libros|vintage'); process.exit(2); }
// Una cuenta deshabilitada (Vintage) sólo se puede consultar en prueba: nunca se le cambia nada.
if (!cuenta.habilitada && flag('real')) { console.error(`${cuenta.nombre} está deshabilitada: sólo se puede correr en prueba`); process.exit(2); }
const real = flag('real') && !flag('dry-run') && cuenta?.habilitada === true;
const maxMarcadas = Number(opt('max-marcadas', Infinity));
const limite = Number(opt('limite', Infinity));
const dirEstado = opt('estado', 'state');
const dirSalida = opt('salida', 'salida');
const stockDemanda = Number(process.env.STOCK_DEMANDA || STOCK_DEMANDA_DEFAULT);

async function leerJson(f, d) { try { return JSON.parse(await readFile(f, 'utf8')); } catch { return d; } }
// El estado: sólo "no existe" vale como vacío. Ilegible o roto = corrida fallida,
// nunca se pisa un estado con precios originales.
async function leerEstado(f, d) {
  let txt;
  try { txt = await readFile(f, 'utf8'); } catch (e) { if (e?.code === 'ENOENT') return d; throw Object.assign(new Error('estado_ilegible'), { fatal: true }); }
  try { const j = JSON.parse(txt); if (!j || typeof j.publicaciones !== 'object') throw 0; return j; }
  catch { throw Object.assign(new Error('estado_corrupto'), { fatal: true }); }
}

const memoriaDe = e => Object.fromEntries(['ganando', 'perdio_en', 'perdio_fecha'].filter(k => e?.[k] !== undefined).map(k => [k, e[k]]));

async function main() {
  const inicio = new Date();
  const archivoEstado = join(dirEstado, `${cuenta.clave}.json`);
  const estado = await leerEstado(archivoEstado, { cuenta: cuenta.clave, seller_id: cuenta.sellerId, publicaciones: {} });
  const guardarEstado = () => {
    mkdirSync(dirEstado, { recursive: true });
    estado.actualizado = new Date().toISOString();
    writeFileSync(archivoEstado + '.tmp', JSON.stringify(estado, null, 2) + '\n');
    renameSync(archivoEstado + '.tmp', archivoEstado);
  };
  const pisos = await leerJson(new URL(`../pisos/${cuenta.clave}.json`, import.meta.url), {});
  // Publicaciones que Seba pidió seguir bajando aunque el ganador quede a más del umbral del original.
  const seguir = await leerJson(new URL(`../seguir/${cuenta.clave}.json`, import.meta.url), {});

  const ml = crearCliente(fuenteTokenD1(cuenta));
  console.log('Fase: identidad');
  // Identidad: el token tiene que ser de la cuenta pedida. Si no, se corta.
  const yo = await ml.get('/users/me');
  if (String(yo?.id) !== cuenta.sellerId) throw Object.assign(new Error('token_de_otra_cuenta'), { fatal: true });

  console.log('Fase: listado');
  const ids = await idsActivos(ml, cuenta.sellerId, { limite });
  // Las que el sistema bajó antes van primero y siempre se revisan.
  const enEstado = Object.keys(estado.publicaciones);
  const orden = [...new Set([...enEstado, ...ids])];
  console.log(`Fase: detalle de ${orden.length}`);
  const items = await detalle(ml, orden);
  console.log(`${cuenta.nombre}: ${ids.length} activas, ${enEstado.length} en estado`);
  // Cambios que quedaron a medias en una corrida anterior (se cortó entre el PUT y
  // la confirmación): se resuelven mirando el precio real en ML.
  if (real) {
    let tocado = false;
    for (const [id, e] of Object.entries(estado.publicaciones)) {
      if (!e.pendiente) continue;
      const actual = items.get(id)?.price;
      if (actual === e.pendiente.precio) { e.precio_aplicado = e.pendiente.precio; e.fecha = e.pendiente.desde; if (e.pendiente.stock_original !== undefined) e.stock_original = e.pendiente.stock_original; }
      if (actual === e.pendiente.precio && e.pendiente.restaurar) delete estado.publicaciones[id];
      else { delete e.pendiente; if (e.precio_aplicado === null) delete estado.publicaciones[id]; }
      tocado = true;
    }
    if (tocado) guardarEstado();
  }

  // Piso por costo (Vintage). Sin costo conocido, el piso es inalcanzable: no se baja.
  let pisoCosto = null, infoPisos = null;
  if (cuenta.pisoPorCosto) { const r = await cargarPisosVintage(); pisoCosto = r.pisoDe; infoPisos = r.info; console.log('Pisos:', JSON.stringify(infoPisos)); }
  const SIN_COSTO = 1e12;
  const pisoDe = id => {
    const candidatos = [num(pisos[id]), num(cuenta.minimo), pisoCosto ? (pisoCosto(items.get(id)) ?? SIN_COSTO) : null].filter(v => v !== null);
    return candidatos.length ? Math.max(...candidatos) : null;
  };
  const reglas = { umbral: cuenta.umbral ?? UMBRAL_UYU, topePct: cuenta.topePct === undefined ? undefined : cuenta.topePct, umbralInclusivo: cuenta.umbralInclusivo === true, descuento: cuenta.descuento ?? 0, pasoMinimoSubida: cuenta.pasoMinimoSubida ?? 1, ahora: inicio.getTime() };
  const cacheEntrega = new Map();
  const filas = []; let marcadas = 0;
  const lote = 40;
  for (let i = 0; i < orden.length; i += lote) {
    const parte = orden.slice(i, i + lote).filter(id => items.get(id)?.status === 'active');
    const res = await Promise.all(parte.map(async id => {
      const item = items.get(id), previo = estado.publicaciones[id];
      try {
        const comp = await competencia(ml, item, { necesitaTecho: Boolean(previo), sellerId: cuenta.sellerId, soloContraDemanda: cuenta.soloContraDemanda === true, descuento: cuenta.descuento ?? 0, cache: cacheEntrega });
        let d = decidir({ item, comp, promo: false, previo, piso: pisoDe(id), seguir: Boolean(seguir[id]), tocarStock: cuenta.tocarStockDemanda, stockDemanda, ...reglas });
        let promo;
        if (CAMBIA.has(d.accion)) {
          promo = await promocionActiva(ml, id);
          d = decidir({ item, comp, promo, previo, piso: pisoDe(id), seguir: Boolean(seguir[id]), tocarStock: cuenta.tocarStockDemanda, stockDemanda, ...reglas });
        }
        return { item, comp, d, previo, promo };
      } catch (e) {
        if (e?.fatal) throw e;
        return { item, comp: null, d: { accion: 'error_consulta', motivo: e?.code ?? 'error' }, previo };
      }
    }));
    for (const r of res) { r.piso = pisoDe(r.item.id); filas.push(r); if (r.comp?.marcada && !r.previo) marcadas++; }
    if (marcadas >= maxMarcadas && i + lote >= enEstado.length) break;
  }
  // Publicaciones del estado que ya no están activas: se conservan, no se tocan.
  for (const id of enEstado) if (!items.has(id) || items.get(id).status !== 'active') filas.push({ item: items.get(id) ?? { id }, comp: null, d: { accion: 'inactiva', motivo: 'no está activa' }, previo: estado.publicaciones[id] });

  // Memoria de subida (ganando, perdio_en): se guarda para las publicaciones del estado.
  if (real) {
    let tocado = false;
    for (const f of filas) {
      const e = estado.publicaciones[f.item.id];
      if (!e || !f.d.memoria) continue;
      Object.assign(e, f.d.memoria); tocado = true;
    }
    if (tocado) guardarEstado();
  }
  const cambios = filas.filter(f => CAMBIA.has(f.d.accion));
  const maxCambios = cuenta.maxCambios ?? MAX_CAMBIOS_POR_CORRIDA;
  if (real && cambios.length > maxCambios) throw Object.assign(new Error(`freno: ${cambios.length} cambios planeados (máximo ${maxCambios})`), { fatal: true });

  // Aplicar (sólo en modo real). Una que falla no frena a las demás.
  // El estado se graba en disco después de CADA cambio: si la corrida se corta a
  // mitad de camino, lo ya bajado queda registrado y la reversión lo encuentra.
  const ahora = new Date().toISOString();
  // Justo antes de aplicar se relee el precio: si cambió desde el listado (por
  // ejemplo, una edición a mano), esa publicación se saltea en esta corrida.
  const frescos = real && cambios.length ? await detalle(ml, cambios.map(f => f.item.id)) : new Map();
  for (const f of cambios) {
    f.aplicado = false;
    if (!real) continue;
    const id = f.item.id, fresco = frescos.get(id);
    if (!fresco || fresco.price !== f.item.price || fresco.status !== 'active' || fresco.original_price != null) {
      f.d = { ...f.d, accion: 'saltear_cambio_reciente', motivo: `precio leído ${fresco?.price ?? '?'}` }; continue;
    }
    const previo = estado.publicaciones[id];
    const stockOriginal = previo?.stock_original !== undefined ? previo.stock_original : Number.isFinite(f.d.stock) ? f.item.available_quantity : undefined;
    // 1) Se anota el cambio como pendiente ANTES del PUT: si la corrida se corta,
    //    la siguiente lo resuelve con el precio real y nunca queda una baja sin registro.
    estado.publicaciones[id] = {
      titulo: f.item.title?.slice(0, 80) ?? '',
      precio_original: previo?.precio_original ?? f.item.price,
      precio_aplicado: previo?.precio_aplicado ?? null,
      fecha_primera_baja: previo?.fecha_primera_baja ?? ahora,
      fecha: previo?.fecha ?? ahora,
      ...(previo?.stock_original !== undefined ? { stock_original: previo.stock_original } : {}),
      ...memoriaDe(previo),
      ...(f.item.demanda ? { dias_demanda: f.item.dias_demanda } : {}),
      pendiente: { precio: f.d.precio, desde: ahora, restaurar: f.d.accion === 'restaurar', ...(stockOriginal !== undefined ? { stock_original: stockOriginal } : {}) },
    };
    guardarEstado();
    const body = { price: f.d.precio, ...(Number.isFinite(f.d.stock) ? { available_quantity: f.d.stock } : {}) };
    let confirmado = false, error = null;
    try { const r = await ml.put(`/items/${id}`, body); confirmado = Number(r?.price) === f.d.precio; if (!confirmado) error = { code: 'precio_no_confirmado' }; }
    catch (e) { error = e; }
    // 2) Sin confirmación en la respuesta: se relee la publicación para saber qué pasó.
    if (!confirmado) {
      try { const it = (await detalle(ml, [id])).get(id); confirmado = it?.price === f.d.precio; } catch {}
    }
    const e = estado.publicaciones[id];
    if (confirmado) {
      f.aplicado = true;
      if (f.d.accion === 'restaurar') delete estado.publicaciones[id];
      else { e.precio_aplicado = f.d.precio; e.fecha = ahora; if (e.pendiente.stock_original !== undefined) e.stock_original = e.pendiente.stock_original; delete e.pendiente; }
    } else {
      delete e.pendiente;
      if (e.precio_aplicado === null) delete estado.publicaciones[id];
      f.d = { ...f.d, accion: 'error_aplicar', motivo: error?.code ?? 'no_aplicado', detalle: error?.detalle ?? null };
    }
    guardarEstado();
  }
  // Verificación: se vuelve a leer cada publicación cambiada y se compara el precio.
  const aplicadas = cambios.filter(f => f.aplicado);
  if (aplicadas.length) {
    await new Promise(r => setTimeout(r, 5000));
    const leidas = await detalle(ml, aplicadas.map(f => f.item.id)).catch(() => new Map());
    for (const f of aplicadas) {
      const it = leidas.get(f.item.id);
      f.verificado = Boolean(it) && it.price === f.d.precio && (!Number.isFinite(f.d.stock) || it.available_quantity === f.d.stock);
      f.precio_leido = it?.price ?? null;
      // ML aceptó el PUT pero la publicación sigue con el precio anterior (pasa en
      // algunas): no cambió nada, así que no queda en el estado como bajada.
      // Si ML dejó el precio anterior, no cambió nada. Si dejó otro (por ejemplo
      // el original, como pasó con una subida), tampoco es nuestro precio: en los
      // dos casos la publicación sale del estado y se cuenta como no aplicada.
      if (!f.verificado && it) {
        const id = f.item.id;
        delete estado.publicaciones[id];
        f.aplicado = false;
        f.d = { ...f.d, accion: 'error_aplicar', motivo: it.price === f.item.price ? 'ml_no_aplico_el_cambio' : 'ml_dejo_otro_precio', precio_leido: it.price };
        guardarEstado();
      }
    }
  }
  // Editadas a mano: salen del estado sin tocarlas.
  if (real) for (const f of filas) if (f.d.accion === 'liberar_editada') delete estado.publicaciones[f.item.id];

  const resumen = resumir(filas, { cuenta, real, inicio, ids: ids.length, stats: ml.stats, umbral: reglas.umbral });
  if (infoPisos) resumen.pisos = infoPisos;
  await mkdir(dirSalida, { recursive: true });
  await writeFile(join(dirSalida, `${cuenta.clave}-resumen.json`), JSON.stringify(resumen, null, 2));
  await writeFile(join(dirSalida, `${cuenta.clave}-detalle.md`), tablaMarkdown(filas, { cuenta, real, resumen }));
  if (!real) await writeFile(join(dirSalida, `${cuenta.clave}-muestras-api.json`), JSON.stringify(MUESTRAS, null, 2));
  if (!real) await writeFile(join(dirSalida, `${cuenta.clave}-informe-regla.md`), informeRegla(filas, { cuenta, maxCambios: cuenta.maxCambios ?? MAX_CAMBIOS_POR_CORRIDA, reglas }));
  // En prueba, la foto completa de la cuenta para diagnosticar (una línea por publicación).
  if (!real) await writeFile(join(dirSalida, `${cuenta.clave}-todas.tsv`), ['id\ttitulo\tprecio\tcatalogo\testado\tmotivo\tdias_demanda\taccion']
    .concat(filas.map(f => [f.item.id, String(f.item.title ?? '').replace(/\t/g, ' ').slice(0, 90), f.item.price, f.item.catalog_listing ? 'si' : 'no', f.comp?.estado ?? '', (f.comp?.motivos ?? []).join(','), f.item.dias_demanda ?? '', f.d.accion].join('\t'))).join('\n') + '\n');
  // Filas de las marcadas y de las del estado, para la auditoría independiente.
  await writeFile(join(dirSalida, `${cuenta.clave}-filas.json`), JSON.stringify(filas.filter(f => f.comp?.marcada || f.comp?.compite || f.previo).map(f => ({
    id: f.item.id, titulo: String(f.item.title ?? '').slice(0, 60), precio: f.item.price, moneda: f.item.currency_id, variaciones: f.item.variaciones, precio_dinamico: Boolean(f.item.precio_dinamico), marcada: Boolean(f.comp?.marcada), compite: Boolean(f.comp?.compite),
    ganador: f.comp?.ganador ?? null, bloqueo: f.comp?.bloqueo ?? null, entrega_ganador: f.comp?.entrega_ganador ?? null, techo: f.comp?.techo ?? null, techo_de: f.comp?.techo_de ?? null, piso: f.piso ?? null,
    en_estado_antes: Boolean(f.previo), precio_original: f.previo?.precio_original ?? null, promo: f.promo ?? null, accion: f.d.accion, motivo: f.d.motivo ?? null, detalle: /^error/.test(f.d.accion) ? (f.d.detalle ?? null) : null, precio_nuevo: f.d.precio ?? null, stock_nuevo: f.d.stock ?? null, aplicado: f.aplicado ?? null,
  })), null, 2));
  if (real) {
    guardarEstado();
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
  // La corrida falla (y GitHub avisa) si no pudo aplicar ninguno de los cambios
  // planeados o si fallaron más del 10 % de las consultas.
  const erroresConsulta = filas.filter(f => f.d.accion === 'error_consulta').length;
  if (real && cambios.length > 0 && !cambios.some(f => f.aplicado) && cambios.some(f => f.d.accion === 'error_aplicar')) throw new Error('ningun_cambio_aplicado');
  if (erroresConsulta > Math.max(20, ids.length * 0.10)) throw new Error(`demasiados_errores_de_consulta_${erroresConsulta}`);
}

const num = v => (v === null || v === undefined || !Number.isFinite(Number(v))) ? null : Number(v);

// El path y el mensaje de ML no traen datos sensibles (sin token): sirven para diagnosticar.
main().catch(e => { console.error('Corrida fallida:', e?.code ?? e?.message ?? 'error', e?.path ? `en ${String(e.path).split('?')[0]}` : '', e?.detalle ? JSON.stringify(e.detalle) : ''); process.exit(1); });
