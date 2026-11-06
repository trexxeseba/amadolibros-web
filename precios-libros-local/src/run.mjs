#!/usr/bin/env node
// Motor local de precios de Amado Libros. Uso:
//   node precios-libros-local/src/run.mjs                 simulación (por defecto, no escribe nada en ML)
//   node precios-libros-local/src/run.mjs --ids MLU1,MLU2 simulación sobre esas publicaciones
//   node precios-libros-local/src/run.mjs --limite 300    simulación sobre las primeras 300
//   node precios-libros-local/src/run.mjs --real          SÓLO con datos/modo.json {"modo":"real"} (GO de Seba)
//   --franja 09:30   la pasa el Programador de tareas; --sin-alertas
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REGLA, FRENOS, HORARIOS, SELLER_ID } from '../config.mjs';
import { fuenteToken } from './token.mjs';
import { crearCliente } from './ml.mjs';
import { idsActivos, detalleItems, priceToWin, competencia, precioEfectivo, promocion, automatizacion, itemFresco } from './lectura.mjs';
import { evaluar, ESCRIBE, objetivo99 } from './regla.mjs';
import { cargarPisos } from './piso.mjs';
import { abrirEstado } from './estado.mjs';
import { tomarLock } from './lock.mjs';
import { escribirPrecio } from './escritura.mjs';
import { alertar } from './alertas.mjs';
import { franjasOmitidas } from './franjas.mjs';
import { filasInforme, escribirInforme } from './informe.mjs';

const RAIZ = dirname(dirname(fileURLToPath(import.meta.url)));
const DATOS = process.env.PRECIOS_DATOS_DIR || join(RAIZ, 'datos');

function args(argv) {
  const a = { real: false, ids: null, limite: Infinity, franja: null, alertas: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--real') a.real = true;
    else if (argv[i] === '--ids') a.ids = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (argv[i] === '--limite') a.limite = Number(argv[++i]);
    else if (argv[i] === '--franja') a.franja = argv[++i];
    else if (argv[i] === '--sin-alertas') a.alertas = false;
  }
  return a;
}

async function pool(lista, n, fn) {
  const out = new Array(lista.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, lista.length) }, async () => { while (i < lista.length) { const k = i++; out[k] = await fn(lista[k], k); } }));
  return out;
}

export async function main(argv = process.argv.slice(2)) {
  const a = args(argv);
  mkdirSync(DATOS, { recursive: true });
  const modoArchivo = existsSync(join(DATOS, 'modo.json')) ? JSON.parse(readFileSync(join(DATOS, 'modo.json'), 'utf8')).modo : 'simulacion';
  const real = a.real && modoArchivo === 'real';
  if (a.real && !real) console.log('Pediste --real pero datos/modo.json no dice "real": corre como simulación.');
  const modo = real ? 'real' : 'simulacion';

  const lock = tomarLock(join(DATOS, 'corrida.lock'), { venceMin: FRENOS.lockVenceMin });
  if (!lock.ok) { console.log('No corre:', lock.motivo); return 3; }
  const estado = abrirEstado(join(DATOS, 'estado.sqlite'));
  const inicio = new Date();
  const corrida = { id: inicio.toISOString().replace(/[:.]/g, '-'), inicio: inicio.toISOString(), modo, franja: a.franja };
  const avisos = [];
  if (lock.reemplazado) avisos.push('Había un lock viejo (PC suspendida o corrida cortada): se reemplazó.');
  let codigo = 0, fallos = 0, intentos = 0, cambios = 0, filas = [];
  try {
    // Franjas que no corrieron (PC apagada o suspendida).
    const ultima = estado.ultimaCorrida();
    for (const f of franjasOmitidas(ultima ? Date.parse(ultima.inicio) : null, inicio.getTime(), HORARIOS)) estado.franjaOmitida(f, inicio.toISOString());
    const omitidas = estado.franjasSinAvisar();
    if (omitidas.length) avisos.push(`Franjas que no corrieron (PC apagada o suspendida): ${omitidas.join(', ')}. No se recuperan: esta corrida usa datos de ahora.`);
    estado.iniciarCorrida(corrida);

    const ml = crearCliente(fuenteToken(), { concurrencia: FRENOS.concurrencia });
    const yo = await ml.get('/users/me');
    if (String(yo?.id) !== SELLER_ID || yo?.site_id !== 'MLU') throw Object.assign(new Error(`token de otra cuenta (${yo?.id}/${yo?.site_id})`), { fatal: true });

    const pisos = cargarPisos(DATOS);
    const gestionadas = new Map(estado.gestionadas().map(g => [g.item_id, g]));
    let ids = a.ids ?? await idsActivos(ml, SELLER_ID, { limite: a.limite });
    ids = [...new Set([...ids, ...(a.ids ? [] : gestionadas.keys())])];
    const items = await detalleItems(ml, ids);
    console.log(`Publicaciones: ${ids.length} (leídas ${items.size}); gestionadas: ${gestionadas.size}; costos cargados: ${pisos.cantidadCostos}`);

    // Lectura completa de una publicación y decisión. Se usa también justo antes de escribir.
    const decidir = async (id, itemBase, ptwPrevio = null) => {
      const item = itemBase ?? await itemFresco(ml, id);
      if (!item) return { decision: evaluar({ item: null, lectura: {} }), item: null, lectura: {} };
      const ptw = ptwPrevio ?? await priceToWin(ml, id);
      const comp = await competencia(ml, item, ptw, { referencia: REGLA.referencia });
      const sale = await precioEfectivo(ml, id);
      const lectura = { precio: sale?.precio ?? null, promo: await promocion(ml, id, sale), automatizacion: await automatizacion(ml, id), comp };
      return { decision: evaluar({ item, lectura, gestion: estado.gestion(id), piso: pisos.pisoDe(id), regla: REGLA }), item, lectura };
    };

    filas = await pool(ids, FRENOS.concurrencia, async id => {
      const item = items.get(id) ?? null;
      const g = gestionadas.get(id) ?? null;
      if (!item) return { id, item, decision: evaluar({ item: null, lectura: {} }) };
      const ptw = await priceToWin(ml, id);
      // Filtro barato para las no gestionadas: sin ficha, sin otro vendedor, o diferencia
      // de 400 o más con el precio publicado, no necesitan más lecturas.
      if (!g) {
        const comp = await competencia(ml, item, ptw, { referencia: REGLA.referencia });
        const P0 = item.price;
        const pre = comp.estado !== 'ok' ? null
          : comp.tipo !== 'catalogo' ? 'revision_sin_comparable'
          : comp.sinExternos ? 'sin_competencia'
          : comp.C !== null && P0 !== null && P0 - comp.C <= 0 ? 'sin_accion_d_no_positiva'
          : comp.C !== null && P0 !== null && P0 - comp.C >= REGLA.umbralUyu ? 'no_tocar_umbral' : null;
        if (pre) return { id, item, ptw, decision: { accion: pre, motivo: pre === 'revision_sin_comparable' ? `sin catálogo (${comp.motivo ?? ''})` : 'filtro previo con el precio publicado', calc: { P: P0, C: comp.C ?? null, D: comp.C != null && P0 != null ? P0 - comp.C : null } }, lectura: { comp } };
      }
      const r = await decidir(id, item, ptw);
      return { id, ptw, ...r };
    });

    // Escrituras (sólo modo real).
    const aEscribir = filas.filter(f => ESCRIBE.has(f.decision.accion));
    for (const f of filas) {
      const g = gestionadas.get(f.id);
      if (!real || !g) continue;
      if (f.decision.accion === 'detener_cambio_externo') { estado.detener(f.id, f.decision.motivo); avisos.push(`${f.id}: precio cambiado fuera del motor, queda detenida.`); }
      else if (f.decision.sinCompetencia) estado.contarSinCompetencia(f.id, f.decision.sinCompetencia);
      else if (f.lectura?.comp?.estado === 'ok' && f.lectura.comp.sinExternos === false) estado.contarSinCompetencia(f.id, 0);
    }
    if (real) {
      if (aEscribir.length > FRENOS.maxCambiosPorCorrida) avisos.push(`Hay ${aEscribir.length} cambios; se aplican los primeros ${FRENOS.maxCambiosPorCorrida} (freno por corrida).`);
      for (const f of aEscribir.slice(0, FRENOS.maxCambiosPorCorrida)) {
        intentos++;
        const antes = f.decision.calc.P;
        const r = await escribirPrecio(ml, f.id, f.decision.objetivo, async () => (await decidir(f.id)).decision);
        f.resultado = r.resultado;
        if (r.resultado === 'aplicada') { cambios++; estado.registrarAplicado(f.id, { precioAnterior: antes, aplicado: r.precio, fecha: new Date().toISOString() }); if (f.decision.accion === 'recuperar_base') estado.liberar(f.id, 'volvió al precio base'); }
        else if (r.resultado === 'precio_inesperado') { fallos++; estado.detener(f.id, `precio inesperado ${r.precio}/${r.efectivo}`); throw Object.assign(new Error(`${f.id}: precio inesperado después de escribir`), { fatal: true }); }
        else if (r.resultado !== 'cancelada_recalculo') fallos++;
        if (intentos >= FRENOS.minIntentosParaUmbral && fallos / intentos > FRENOS.umbralFallosPct) throw Object.assign(new Error(`fallos ${fallos}/${intentos} superan el ${FRENOS.umbralFallosPct * 100} %`), { fatal: true });
      }
    }
    console.log('Llamadas a ML:', JSON.stringify(ml.stats));
  } catch (e) {
    codigo = 1;
    avisos.push(`Corrida detenida: ${e.message}`);
    console.error('Corrida detenida:', e.message);
  } finally {
    const fin = new Date().toISOString();
    const salida = join(DATOS, 'informes', corrida.id);
    mkdirSync(salida, { recursive: true });
    const filasInf = filasInforme(filas);
    const resumen = escribirInforme(salida, filasInf, { corrida, modo, regla: REGLA, frenos: FRENOS, avisos });
    for (const f of filasInf) estado.evento({ corrida_id: corrida.id, item_id: f.item_id, fecha: fin, modo, accion: f.accion, motivo: f.motivo, precio_actual: f.precio_actual, precio_base: f.precio_base, competidor_item: f.competidor_item, competidor_precio: f.competidor_precio, fuente: f.fuente, diferencia: f.diferencia, objetivo: f.objetivo_99, piso: f.piso, limite_pct: REGLA.limiteAcumPct, limite_uyu: REGLA.limiteAcumUyu, desc_acum_uyu: f.desc_acum_uyu, desc_acum_pct: f.desc_acum_pct, resultado: f.resultado ?? null });
    estado.cerrarCorrida({ id: corrida.id, fin, resultado: codigo ? 'detenida' : 'ok', revisadas: filas.length, cambios, fallos, detalle: JSON.stringify(resumen.acciones) });
    if (avisos.length && a.alertas) {
      const r = await alertar({ dir: DATOS, asunto: `Motor de precios Amado Libros: ${codigo ? 'corrida detenida' : 'avisos'} (${modo})`, cuerpo: avisos.join('\n') + `\n\nInforme local: ${salida}` });
      if (r.enviado) estado.marcarAvisadas(estado.franjasSinAvisar());
    }
    estado.cerrar(); lock.soltar();
    console.log(`Informe: ${salida}`);
    console.log('Acciones:', JSON.stringify(resumen.acciones));
  }
  return codigo;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().then(c => process.exit(c));
export { objetivo99 };
