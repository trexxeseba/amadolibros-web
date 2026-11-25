// Modo sombra de Amado Vintage (sólo lee: NUNCA cambia un precio).
//
//   node precio-ganador/src/sombra.mjs --filas estado/ultima/vintage-filas.json \
//        --estado estado/state --salida estado/sombra
//
// Aprobado por Seba (21/11/2026) para correr una semana calculando, sin escribir precios:
//   2. Comparar la edición del ganador con la nuestra (ISBN, encuadernación, editorial,
//      páginas) antes de proponer una bajada.
//   3. Exigir que el precio bajo del rival dure 2 corridas seguidas, y como máximo una
//      bajada por día por publicación.
//   5. Registrar qué haría la regla nueva ("queda >= 18 % sobre costo") frente a la actual
//      ("diferencia <= $400"), con el motivo por publicación, y armar la lista de las 100
//      bajas más grandes para revisar a mano.
// La regla real no cambia (reemplazar los $400 por el 18 % NO está aprobado).
//
// Corre después de la corrida real de Vintage, sobre sus filas (vintage-filas.json): las
// publicaciones que pierden la ficha, el precio para ganar, quién gana y cómo entrega.
// Lee de Mercado Libre los atributos de edición (nuestra publicación y la del ganador) y de
// D1 el costo (mismo cotizador del publicador). Guarda su memoria en state/vintage-sombra.json
// y el registro en sombra/ del repo privado. El log de la corrida sólo lleva conteos.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { CUENTAS, fechaMontevideo, horaMontevideo } from './config.mjs';

export const SOMBRA_DEFAULT = { dias: 7, margen: 18, minimo: 1200, descuento: 0.01, umbral: 400, corridasSeguidas: 2, revisar: 100 };

// ---------------------------------------------------------------- edición
// Atributos de libro en Mercado Libre (worker-sync/publication-book-metadata.js).
export const ATRIBUTOS_EDICION = {
  isbn: ['GTIN', 'ISBN'],
  encuadernacion: ['BOOK_COVER', 'COVER_TYPE'],
  editorial: ['BOOK_PUBLISHER', 'PUBLISHER'],
  paginas: ['PAGES_NUMBER'],
};

const sinTildes = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const valor = (attrs, ids) => {
  for (const id of ids) {
    const a = (attrs ?? []).find(x => x?.id === id);
    const v = a?.value_name ?? a?.values?.[0]?.name ?? null;
    if (v !== null && v !== undefined && String(v).trim() !== '') return { v: String(v), n: a?.value_struct?.number ?? a?.values?.[0]?.struct?.number ?? null };
  }
  return null;
};

// ISBN-10 → ISBN-13 (prefijo 978) para comparar los dos formatos.
export function isbn13(s) {
  const d = String(s ?? '').toUpperCase().replace(/[^0-9X]/g, '');
  if (d.length === 13) return d;
  if (d.length !== 10) return null;
  const base = '978' + d.slice(0, 9);
  const suma = [...base].reduce((a, c, i) => a + Number(c) * (i % 2 ? 3 : 1), 0);
  return base + ((10 - (suma % 10)) % 10);
}
export const isbnsDe = v => new Set(String(v ?? '').split(/[,;/\s]+/).map(isbn13).filter(Boolean));

export function encuadernacion(v) {
  const s = sinTildes(v);
  if (!s) return null;
  if (/dura|hard|carton|empastad|cartone/.test(s)) return 'dura';
  if (/blanda|rustic|paper|soft|bolsillo|pocket/.test(s)) return 'blanda';
  if (/espiral|anillad/.test(s)) return 'espiral';
  return s;
}

const RUIDO_EDITORIAL = /\b(editorial|editora|editores|ediciones|edicions|edition|editions|ed|ediciones|grupo|libros|books|publishing|publishers|sa|s a|sl|s l|srl|ltda|inc|ltd|de|del|la|el|los|las)\b/g;
export function editorial(v) {
  const s = sinTildes(v).replace(/[.,&'"()\-]/g, ' ').replace(RUIDO_EDITORIAL, ' ').replace(/\s+/g, ' ').trim();
  return s || null;
}
const mismaEditorial = (a, b) => a === b || (a.length >= 4 && b.includes(a)) || (b.length >= 4 && a.includes(b));

export function paginas(x) {
  const n = Number(x?.n ?? String(x?.v ?? '').match(/\d+/)?.[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Los datos de edición de una publicación. Nuestro ISBN sale también del SKU (AMADO-AR-<isbn>).
export function edicionDe(item) {
  const a = item?.attributes ?? [];
  const isbn = isbnsDe(valor(a, ATRIBUTOS_EDICION.isbn)?.v);
  const sku = /^AMADO-AR-(\d{10,13})$/.exec(item?.seller_custom_field ?? '')?.[1];
  if (sku && isbn13(sku)) isbn.add(isbn13(sku));
  return {
    isbn: [...isbn],
    encuadernacion: encuadernacion(valor(a, ATRIBUTOS_EDICION.encuadernacion)?.v),
    editorial: editorial(valor(a, ATRIBUTOS_EDICION.editorial)?.v),
    editorial_texto: valor(a, ATRIBUTOS_EDICION.editorial)?.v ?? null,
    paginas: paginas(valor(a, ATRIBUTOS_EDICION.paginas)),
  };
}

// 'igual': todo lo que se pudo comparar coincide (y al menos el ISBN o dos datos más).
// 'distinta': algún dato no coincide (no se propone bajar).
// 'sin_datos': no hay con qué comparar; no frena, pero queda anotado para revisar.
export function compararEdicion(nuestra, suya) {
  const diferencias = [], faltan = [], iguales = [];
  if (!nuestra || !suya) return { resultado: 'sin_datos', diferencias, faltan: ['publicación del ganador'], iguales };
  if (nuestra.isbn.length && suya.isbn.length) {
    if (nuestra.isbn.some(i => suya.isbn.includes(i))) iguales.push('isbn'); else diferencias.push(`ISBN ${nuestra.isbn[0]} / ${suya.isbn[0]}`);
  } else faltan.push('isbn');
  if (nuestra.encuadernacion && suya.encuadernacion) {
    if (nuestra.encuadernacion === suya.encuadernacion) iguales.push('encuadernacion'); else diferencias.push(`tapa ${nuestra.encuadernacion} / ${suya.encuadernacion}`);
  } else faltan.push('encuadernacion');
  if (nuestra.editorial && suya.editorial) {
    if (mismaEditorial(nuestra.editorial, suya.editorial)) iguales.push('editorial'); else diferencias.push(`editorial ${nuestra.editorial_texto ?? nuestra.editorial} / ${suya.editorial_texto ?? suya.editorial}`);
  } else faltan.push('editorial');
  if (nuestra.paginas && suya.paginas) {
    const tolerancia = Math.max(10, Math.round(Math.max(nuestra.paginas, suya.paginas) * 0.1));
    if (Math.abs(nuestra.paginas - suya.paginas) <= tolerancia) iguales.push('paginas'); else diferencias.push(`páginas ${nuestra.paginas} / ${suya.paginas}`);
  } else faltan.push('paginas');
  const resultado = diferencias.length ? 'distinta' : (iguales.includes('isbn') || iguales.length >= 2) ? 'igual' : 'sin_datos';
  return { resultado, diferencias, faltan, iguales };
}

// ---------------------------------------------------------------- reglas
const entero = n => Math.floor(Number(n) + 1e-9);
const excluidoDe = (f, excluidos) => excluidos.has(String(f.ganador_vendedor ?? '').toLowerCase());

// Lo que comparten las dos reglas: ganador a demanda, vendedor con el que se compite, piso.
function base(f, { minimo, excluidos }) {
  if (!f.compite || f.ganador == null) return 'no pierde la ficha';
  if (f.moneda && f.moneda !== 'UYU') return 'no está en pesos';
  if (f.variaciones) return 'tiene variaciones';
  if (excluidoDe(f, excluidos) || f.bloqueo === 'vendedor_excluido') return `no competir: gana ${f.ganador_vendedor ?? 'un vendedor excluido'}`;
  if (f.entrega_ganador === 'inmediato' || f.bloqueo === 'ganador_inmediato') return 'el ganador entrega de inmediato';
  if (f.entrega_ganador !== 'demanda') return 'sin dato del plazo del ganador';
  if (f.objetivo < minimo) return `bajo el piso de ${minimo} (objetivo ${f.objetivo})`;
  return null;
}

// Regla actual (la real hoy): diferencia hasta $400 (inclusive) contra el precio actual.
export function reglaActual(f, o) {
  const b = base(f, o); if (b) return { baja: false, motivo: b };
  const dif = f.precio - entero(f.ganador);
  if (dif > o.umbral) return { baja: false, motivo: `diferencia ${dif} > ${o.umbral}` };
  return { baja: true, motivo: `diferencia ${dif} <= ${o.umbral}` };
}

// Regla nueva (sólo calculada): baja al 99 % del ganador si nos queda al menos el margen sobre costo.
export function reglaNueva(f, o) {
  const b = base(f, o); if (b) return { baja: false, motivo: b };
  if (f.costo == null) return { baja: false, motivo: 'sin costo conocido (otra fuente)' };
  if (f.queda_objetivo <= 0) return { baja: false, motivo: `perderíamos plata (queda ${f.queda_objetivo})` };
  if (f.sobre_costo_objetivo < o.margen) return { baja: false, motivo: `margen flaco: ${f.sobre_costo_objetivo} % < ${o.margen} %` };
  return { baja: true, motivo: `queda ${f.sobre_costo_objetivo} % sobre costo` };
}

// Frenos 2 y 3 sobre una regla que bajaría. mem: memoria de la publicación ANTES de esta corrida.
export function frenos(f, { edicion, mem, corrida, hoy, clave, corridasSeguidas = 2 }) {
  if (edicion?.resultado === 'distinta') return { freno: 'edicion', motivo: `edición distinta: ${edicion.diferencias.join('; ')}` };
  // Corridas seguidas con el rival bajo: la anterior (corrida - 1) cuenta si la registró.
  const seguidas = mem?.bajo_desde != null && mem?.bajo_en === corrida - 1 ? corrida - mem.bajo_desde + 1 : 1;
  if (seguidas < corridasSeguidas) return { freno: 'persistencia', motivo: `esperar: precio bajo visto en ${seguidas} de ${corridasSeguidas} corridas seguidas` };
  if (mem?.[clave] === hoy) return { freno: 'una_por_dia', motivo: 'ya bajaría hoy (una por día)' };
  return null;
}

// Evalúa una fila con las dos reglas y los frenos. Devuelve la fila del registro y la memoria nueva.
export function evaluar(f, { cot = null, edicion = null, mem = null, corrida, hoy, opciones }) {
  const o = { ...SOMBRA_DEFAULT, ...opciones };
  const fila = {
    id: f.id, titulo: String(f.titulo ?? '').slice(0, 60), precio: f.precio, precio_original: f.precio_original ?? null, en_estado: Boolean(f.en_estado_antes),
    ganador: f.ganador ?? null, ganador_item: f.ganador_item ?? null, ganador_vendedor: f.ganador_vendedor ?? null, entrega_ganador: f.entrega_ganador ?? null,
    accion_real: f.accion ?? null, precio_real: f.precio_nuevo ?? null,
  };
  fila.objetivo = f.ganador != null ? entero(Number(f.ganador) * (1 - o.descuento)) : null;
  fila.baja_pesos = fila.objetivo != null ? f.precio - fila.objetivo : null;
  if (cot) Object.assign(fila, { costo: Math.round(cot.costo), queda_hoy: cot.queda(f.precio), sobre_costo_hoy: cot.sobre_costo(f.precio),
    queda_objetivo: fila.objetivo != null ? cot.queda(fila.objetivo) : null, sobre_costo_objetivo: fila.objetivo != null ? cot.sobre_costo(fila.objetivo) : null });
  else fila.costo = null;
  const g = { ...f, ...fila, objetivo: fila.objetivo };
  fila.edicion = edicion ? { resultado: edicion.resultado, diferencias: edicion.diferencias, faltan: edicion.faltan } : null;

  const actual = reglaActual(g, o), nueva = reglaNueva(g, o);
  const fa = actual.baja ? frenos(g, { edicion, mem, corrida, hoy, clave: 'baja_actual', corridasSeguidas: o.corridasSeguidas }) : null;
  const fn = nueva.baja ? frenos(g, { edicion, mem, corrida, hoy, clave: 'baja_nueva', corridasSeguidas: o.corridasSeguidas }) : null;
  fila.actual = { baja: actual.baja && !fa, sin_frenos: actual.baja, motivo: fa ? fa.motivo : actual.motivo, freno: fa?.freno ?? null };
  fila.nueva = { baja: nueva.baja && !fn, sin_frenos: nueva.baja, motivo: fn ? fn.motivo : nueva.motivo, freno: fn?.freno ?? null, precio: nueva.baja && !fn ? fila.objetivo : null };

  // Memoria: desde qué corrida el rival está bajo (seguidas), y el día de la última bajada calculada.
  const bajo = f.compite && f.ganador != null && Number(f.ganador) < Number(f.precio);
  const m = { ...(mem ?? {}) };
  if (bajo) { m.bajo_desde = m.bajo_en === corrida - 1 && m.bajo_desde != null ? m.bajo_desde : corrida; m.bajo_en = corrida; m.ganador = f.ganador; }
  else { delete m.bajo_desde; delete m.bajo_en; delete m.ganador; }
  if (fila.actual.baja) m.baja_actual = hoy;
  if (fila.nueva.baja) m.baja_nueva = hoy;
  m.visto = corrida;
  return { fila, mem: m };
}

// ---------------------------------------------------------------- resumen
const mediana = a => { const o = a.filter(Number.isFinite).sort((x, y) => x - y); return o.length ? o[Math.floor(o.length / 2)] : null; };
const contar = (arr, k) => arr.reduce((a, x) => { const v = k(x); if (v != null) a[v] = (a[v] ?? 0) + 1; return a; }, {});
// Motivo sin números, para agrupar ("margen flaco: 12 % < 18 %" → "margen flaco").
export const tipoMotivo = m => String(m ?? '').split(':')[0].replace(/\s*\(.*$/, '').replace(/\s-?\d.*$/, '').trim();

export function resumirCorrida(filas) {
  const pierden = filas.filter(f => f.ganador != null);
  const conCosto = pierden.filter(f => f.costo != null);
  const n = sel => sel.length;
  return {
    pierden: n(pierden), con_costo: n(conCosto),
    real: { bajo_o_ajusto: n(pierden.filter(f => f.accion_real === 'bajar' || f.accion_real === 'ajustar')) },
    actual: { sin_frenos: n(pierden.filter(f => f.actual.sin_frenos)), con_frenos: n(pierden.filter(f => f.actual.baja)), frenos: contar(pierden.filter(f => f.actual.freno), f => f.actual.freno) },
    nueva: { sin_frenos: n(pierden.filter(f => f.nueva.sin_frenos)), con_frenos: n(pierden.filter(f => f.nueva.baja)), frenos: contar(pierden.filter(f => f.nueva.freno), f => f.nueva.freno),
      mediana_baja_pesos: mediana(pierden.filter(f => f.nueva.baja).map(f => f.baja_pesos)), mediana_sobre_costo: mediana(pierden.filter(f => f.nueva.baja).map(f => f.sobre_costo_objetivo)),
      motivos_no: contar(pierden.filter(f => !f.nueva.baja), f => tipoMotivo(f.nueva.motivo)) },
    ambas: n(pierden.filter(f => f.actual.baja && f.nueva.baja)), solo_actual: n(pierden.filter(f => f.actual.baja && !f.nueva.baja)), solo_nueva: n(pierden.filter(f => !f.actual.baja && f.nueva.baja)),
    edicion: contar(pierden, f => f.edicion?.resultado ?? 'sin_leer'),
  };
}

// Las N bajas más grandes de la semana (por pesos), una por publicación: la última vez que la
// regla nueva (con frenos) la bajaría.
export function bajasMasGrandes(corridas, n = 100) {
  const porId = new Map();
  for (const c of corridas) for (const f of c.filas) if (f.nueva?.baja) porId.set(f.id, { ...f, corrida_fecha: c.fecha, veces: (porId.get(f.id)?.veces ?? 0) + 1 });
  return [...porId.values()].sort((a, b) => b.baja_pesos - a.baja_pesos || a.id.localeCompare(b.id)).slice(0, n);
}

const link = id => `[${id}](https://articulo.mercadolibre.com.uy/${String(id).replace('MLU', 'MLU-')})`;
const pipe = s => String(s ?? '').replace(/\|/g, '/');

export function markdownSemana({ inicio, dias, corridas, top }) {
  const l = [`# Modo sombra de Vintage · semana desde ${inicio.slice(0, 10)}`, '',
    'Sólo calcula: no cambió ningún precio. Regla actual = baja si la diferencia es de hasta $400. Regla nueva = baja al 99 % del ganador si queda al menos 18 % sobre costo (comisión 17 %, sin IVA).',
    'Las dos con los frenos aprobados: misma edición que el ganador (ISBN, tapa, editorial, páginas), el precio bajo del rival tiene que durar 2 corridas seguidas, y como máximo una bajada por día por publicación.', '',
    `Corridas registradas: ${corridas.length} (la semana dura ${dias} días).`, '',
    '| Corrida | Pierden | Con costo | Bajó el sistema real | Actual sin frenos | Actual con frenos | Nueva sin frenos | Nueva con frenos | Baja mediana nueva | Frenadas por edición (nueva) | Por persistencia | Por una por día |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|'];
  for (const c of corridas) {
    const r = c.resumen;
    l.push(`| ${c.fecha.slice(0, 16).replace('T', ' ')} | ${r.pierden} | ${r.con_costo} | ${r.real.bajo_o_ajusto} | ${r.actual.sin_frenos} | ${r.actual.con_frenos} | ${r.nueva.sin_frenos} | ${r.nueva.con_frenos} | ${r.nueva.mediana_baja_pesos ?? ''} | ${r.nueva.frenos.edicion ?? 0} | ${r.nueva.frenos.persistencia ?? 0} | ${r.nueva.frenos.una_por_dia ?? 0} |`);
  }
  const ult = corridas.at(-1)?.resumen;
  if (ult) l.push('', '## Última corrida', '', '```json', JSON.stringify(ult, null, 1), '```');
  const distintas = new Set(corridas.flatMap(c => c.filas.filter(f => f.nueva?.baja).map(f => f.id)));
  l.push('', `Publicaciones distintas que la regla nueva bajaría al menos una vez en la semana: ${distintas.size}.`, '',
    `## Las ${top.length} bajas más grandes (para revisar a mano)`, '', 'Detalle en `vintage-revisar.md`.');
  return l.join('\n') + '\n';
}

export function markdownRevisar(top) {
  const l = ['# Revisar a mano: las bajas más grandes de la regla nueva (modo sombra)', '',
    'Ninguna se aplicó. Para cada una: ¿la bajarías? Anotar en la última columna (sí / no / por qué).', '',
    '| # | Publicación | Hoy | Bajaría a | Baja | Ganador (vendedor, publicación) | Costo | Queda | Sobre costo | Edición | Regla actual | Veces | Revisión |',
    '|---:|---|---:|---:|---:|---|---:|---:|---:|---|---|---:|---|'];
  top.forEach((f, i) => l.push(`| ${i + 1} | ${link(f.id)} ${pipe(f.titulo).slice(0, 40)} | ${f.precio} | ${f.objetivo} | ${f.baja_pesos} | ${pipe(f.ganador_vendedor ?? '')} ${f.ganador_item ? link(f.ganador_item) : ''} | ${f.costo} | ${f.queda_objetivo} | ${f.sobre_costo_objetivo} % | ${f.edicion?.resultado ?? 'sin leer'}${f.edicion?.faltan?.length ? ` (falta ${f.edicion.faltan.join(', ')})` : ''} | ${f.actual.baja ? 'también bajaría' : pipe(f.actual.motivo)} | ${f.veces} | |`));
  return l.join('\n') + '\n';
}

// ---------------------------------------------------------------- corrida
const ATRIBUTOS_ITEM = 'id,seller_id,seller_custom_field,attributes';

async function atributos(ml, ids) {
  const { bulkItemsPath, bulkEntryItem } = await import('../../worker-sync/meli-bulk.js');
  const out = new Map(), lotes = [];
  for (let i = 0; i < ids.length; i += 20) lotes.push(ids.slice(i, i + 20));
  await Promise.all(lotes.map(async lote => {
    try {
      const d = await ml.get(bulkItemsPath(lote, ATRIBUTOS_ITEM));
      for (const e of Array.isArray(d) ? d : []) { const b = bulkEntryItem(e); if (b?.id) out.set(b.id, b); }
    } catch (e) { if (e?.fatal) throw e; }
  }));
  return out;
}

const leer = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch (e) { if (e?.code === 'ENOENT') return d; throw Object.assign(new Error('sombra_estado_ilegible'), { fatal: true }); } };
const grabar = (f, v) => { writeFileSync(f + '.tmp', typeof v === 'string' ? v : JSON.stringify(v)); renameSync(f + '.tmp', f); };

// Una corrida de la sombra. Las dependencias (Mercado Libre, cotizador, reloj) se pasan para poder probarla.
export async function correrSombra({ ml, cargarCotizador, filasRun, dirEstado, salida, ahora = new Date(), cuenta = CUENTAS.vintage }) {
  const o = { ...SOMBRA_DEFAULT, ...(cuenta.sombra ?? {}), minimo: cuenta.minimo ?? SOMBRA_DEFAULT.minimo, umbral: cuenta.umbral ?? SOMBRA_DEFAULT.umbral, descuento: cuenta.descuento ?? SOMBRA_DEFAULT.descuento };
  const excluidos = new Set((cuenta.vendedoresExcluidos ?? []).map(v => String(v).toLowerCase()));
  const archivo = join(dirEstado, 'vintage-sombra.json');
  const hoy = fechaMontevideo(ahora);
  const memoria = leer(archivo, { inicio: ahora.toISOString(), inicio_dia: hoy, corridas: 0, publicaciones: {} });
  memoria.inicio_dia ??= fechaMontevideo(new Date(memoria.inicio));
  if (ahora - Date.parse(memoria.inicio) > o.dias * 86400e3) return { terminada: true, inicio: memoria.inicio };

  const pierden = (Array.isArray(filasRun) ? filasRun : filasRun.filas).filter(f => f.compite && f.ganador != null);
  // Identidad: el token tiene que ser de Vintage (aunque acá sólo se lee).
  const yo = await ml.get('/users/me');
  if (String(yo?.id) !== cuenta.sellerId) throw Object.assign(new Error('token_de_otra_cuenta'), { fatal: true });
  const { cotizar, info } = await cargarCotizador();

  // Atributos de edición: nuestras publicaciones y las de los ganadores (las de los ganadores son públicas).
  const propias = await atributos(ml, pierden.map(f => f.id));
  const ganadores = await atributos(ml, [...new Set(pierden.map(f => f.ganador_item).filter(Boolean))]);

  const corrida = Number(memoria.corridas ?? 0) + 1;
  const filas = [], nuevaMemoria = {};
  for (const f of pierden) {
    const nuestra = propias.get(f.id), suya = f.ganador_item ? ganadores.get(f.ganador_item) : null;
    const edicion = nuestra ? compararEdicion(edicionDe(nuestra), suya ? edicionDe(suya) : null) : null;
    const cot = nuestra ? cotizar({ seller_custom_field: nuestra.seller_custom_field }) : null;
    const r = evaluar(f, { cot, edicion, mem: memoria.publicaciones?.[f.id] ?? null, corrida, hoy, opciones: { ...o, excluidos } });
    filas.push(r.fila); nuevaMemoria[f.id] = r.mem;
  }
  // Las que no perdieron en esta corrida conservan sólo la bajada del día (la racha se corta).
  for (const [id, m] of Object.entries(memoria.publicaciones ?? {})) {
    if (nuevaMemoria[id]) continue;
    const { baja_actual, baja_nueva } = m;
    if (baja_actual === hoy || baja_nueva === hoy) nuevaMemoria[id] = { ...(baja_actual === hoy ? { baja_actual } : {}), ...(baja_nueva === hoy ? { baja_nueva } : {}) };
  }

  const resumen = resumirCorrida(filas);
  const registro = { fecha: ahora.toISOString(), corrida, hora_montevideo: horaMontevideo(ahora), info: { lista_sbs: info?.lista_sbs ?? null, dias_lista: info?.dias_lista ?? null, comision: info?.comision ?? null }, opciones: { ...o, excluidos: [...excluidos] }, resumen, filas };
  mkdirSync(join(salida, 'vintage'), { recursive: true });
  grabar(join(salida, 'vintage', `${hoy}-${String(horaMontevideo(ahora)).padStart(2, '0')}h.json`), registro);

  // Semana: todas las corridas registradas desde el inicio (nombres con fecha de Montevideo).
  const corridas = readdirSync(join(salida, 'vintage')).filter(n => /^\d{4}-\d{2}-\d{2}-\d{2}h\.json$/.test(n) && n.slice(0, 10) >= memoria.inicio_dia).sort()
    .map(n => JSON.parse(readFileSync(join(salida, 'vintage', n), 'utf8')));
  const top = bajasMasGrandes(corridas, o.revisar);
  grabar(join(salida, 'vintage-semana.md'), markdownSemana({ inicio: memoria.inicio, dias: o.dias, corridas, top }));
  grabar(join(salida, 'vintage-revisar.md'), markdownRevisar(top));

  mkdirSync(dirEstado, { recursive: true });
  grabar(archivo, JSON.stringify({ inicio: memoria.inicio, inicio_dia: memoria.inicio_dia, corridas: corrida, actualizado: ahora.toISOString(), publicaciones: nuevaMemoria }, null, 1) + '\n');
  return { corrida, resumen, top: top.length };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (n, d = null) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
  const filasRun = JSON.parse(readFileSync(opt('filas', 'ultima/vintage-filas.json'), 'utf8'));
  const { fuenteTokenD1 } = await import('./token.mjs');
  const { crearCliente } = await import('./ml.mjs');
  const { cargarCotizadorVintage } = await import('./costos-vintage.mjs');
  const ml = crearCliente(fuenteTokenD1(CUENTAS.vintage), { concurrencia: 4 });
  const r = await correrSombra({ ml, cargarCotizador: cargarCotizadorVintage, filasRun, dirEstado: opt('estado', 'state'), salida: opt('salida', 'sombra') });
  if (r.terminada) { console.log(`Sombra: la semana desde ${r.inicio.slice(0, 10)} terminó; no se registra más`); return; }
  // Sólo conteos en el log (el repo es público).
  const s = r.resumen;
  console.log('Sombra:', JSON.stringify({ corrida: r.corrida, pierden: s.pierden, con_costo: s.con_costo, real: s.real.bajo_o_ajusto, actual: s.actual.con_frenos, nueva: s.nueva.con_frenos, frenos_nueva: s.nueva.frenos, edicion: s.edicion, llamadas: ml.stats.llamadas }));
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error('Sombra fallida:', e?.code ?? e?.message ?? 'error'); process.exit(1); });
