// Paso 1 de Ficha técnica: medir. Sólo lee.
//
//   node ficha-tecnica/src/medir.mjs --salida DIR [--tope N]
//
// Para cada publicación activa de Amado Libros: objetivos de calidad pendientes (GET /item/{id}/performance),
// atributos principales de su categoría que no tiene cargados (GET /categories/{cat}/attributes y
// /categories/{cat}/technical_specs/input), ISBN, ventas y visitas de 30 días para priorizar.
// Escribe DIR/medicion.json (detalle, va al repo privado). El log sólo lleva conteos.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pendientes } from '../../precio-ganador/src/calidad.mjs';
import { clienteLibros, idsPorEstado, enParalelo, trozos, isbnDe, principales, faltantes, fechaUy } from './comun.mjs';

const CAMPOS = 'id,category_id,domain_id,catalog_listing,user_product_id,attributes,variations,sold_quantity,available_quantity,status';

// Clasificación de una publicación por tipo de objetivo pendiente. Función pura.
export function clasificar(fila) {
  const objs = new Set((fila.pendientes ?? []).map(p => p.objetivo));
  return {
    ficha: objs.has('UP_TECHNICAL_SPECIFICATIONS_MAIN'),
    video: objs.has('UP_SHORTS'),
    stock: objs.has('UP_STOCK_DEPOSITO'),
    fotos: objs.has('UP_PICTURES'),
    otros: [...objs].filter(o => !['UP_TECHNICAL_SPECIFICATIONS_MAIN', 'UP_SHORTS', 'UP_STOCK_DEPOSITO', 'UP_PICTURES'].includes(o)),
    solo_ficha: objs.size === 1 && objs.has('UP_TECHNICAL_SPECIFICATIONS_MAIN'),
  };
}

export function resumir(filas) {
  const r = { activas_leidas: filas.length, con_objetivos: 0, sin_dato_de_calidad: 0, por_objetivo: {}, por_regla: {}, ficha: { con_objetivo_ficha: 0, solo_ficha: 0, con_isbn: 0, sin_isbn: 0, catalogo: 0, user_product: 0, por_atributo_faltante: {} }, combinaciones: {} };
  for (const f of filas) {
    if (f.performance_http && f.performance_http !== 200) { r.sin_dato_de_calidad++; continue; }
    if (!f.pendientes.length) continue;
    r.con_objetivos++;
    const objs = [...new Set(f.pendientes.map(p => p.objetivo))].sort();
    for (const o of objs) r.por_objetivo[o] = (r.por_objetivo[o] ?? 0) + 1;
    for (const p of f.pendientes) { const k = p.regla ?? p.objetivo; r.por_regla[k] = (r.por_regla[k] ?? 0) + 1; }
    const k = objs.join('+'); r.combinaciones[k] = (r.combinaciones[k] ?? 0) + 1;
    const c = clasificar(f);
    if (c.ficha) {
      r.ficha.con_objetivo_ficha++;
      if (c.solo_ficha) r.ficha.solo_ficha++;
      if (f.isbn) r.ficha.con_isbn++; else r.ficha.sin_isbn++;
      if (f.catalogo) r.ficha.catalogo++;
      if (f.user_product) r.ficha.user_product++;
      for (const a of f.faltan ?? []) r.ficha.por_atributo_faltante[a] = (r.ficha.por_atributo_faltante[a] ?? 0) + 1;
    }
  }
  return r;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (n, d = null) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
  const salida = opt('salida', '.'), tope = Number(opt('tope', 100000));
  const ml = await clienteLibros();
  const ids = (await idsPorEstado(ml, 'active')).slice(0, tope);

  const items = new Map();
  await enParalelo(trozos(ids, 20), 3, async grupo => {
    const d = await ml.get(`/items?ids=${grupo.join(',')}&attributes=${CAMPOS}`);
    for (const x of Array.isArray(d) ? d : []) if (x?.code === 200 && x.body?.id) items.set(x.body.id, x.body);
  });

  // Visitas de 30 días, para priorizar (si la ruta no responde, se prioriza por ventas).
  const visitas = new Map(); let visitasHttp = 'ok';
  const hasta = new Date(), desde = new Date(hasta.getTime() - 30 * 864e5);
  await enParalelo(trozos(ids, 50), 2, async grupo => {
    try {
      const d = await ml.get(`/items/visits?ids=${grupo.join(',')}&date_from=${desde.toISOString().slice(0, 10)}&date_to=${hasta.toISOString().slice(0, 10)}`);
      for (const x of Array.isArray(d) ? d : Object.entries(d ?? {}).map(([item_id, total_visits]) => ({ item_id, total_visits }))) if (x?.item_id) visitas.set(x.item_id, Number(x.total_visits) || 0);
    } catch (e) { visitasHttp = `http_${e?.status ?? 0}`; }
  });

  const categorias = new Map(), muestras = { categorias: {}, performance_ficha: [], performance_error: [] };
  for (const cat of new Set([...items.values()].map(i => i.category_id).filter(Boolean))) {
    let attrs = [], specs = null;
    try { attrs = await ml.get(`/categories/${cat}/attributes`); } catch {}
    try { specs = await ml.get(`/categories/${cat}/technical_specs/input`); } catch {}
    categorias.set(cat, principales(attrs, specs));
    if (Object.keys(muestras.categorias).length < 5) muestras.categorias[cat] = { principales: categorias.get(cat), atributos: (attrs ?? []).map(a => ({ id: a.id, name: a.name, tags: a.tags, relevance: a.relevance ?? null, value_type: a.value_type, values: (a.values ?? []).slice(0, 30) })), specs_grupos: (specs?.groups ?? []).map(g => ({ id: g.id, label: g.label, attrs: (g.components ?? []).flatMap(c => (c.attributes ?? []).map(a => a.id)) })) };
  }

  const filas = [], http = {};
  await enParalelo(ids, 4, async id => {
    const it = items.get(id);
    const fila = { id, categoria: it?.category_id ?? null, isbn: it ? isbnDe(it) : null, catalogo: !!it?.catalog_listing, user_product: it?.user_product_id ?? null,
      variaciones: Array.isArray(it?.variations) && it.variations.length > 0, ventas: Number(it?.sold_quantity) || 0, visitas30: visitas.get(id) ?? null,
      faltan: it ? faltantes(it, categorias.get(it.category_id) ?? []) : [], pendientes: [], performance_http: 200 };
    try {
      const p = await ml.get(`/item/${id}/performance`);
      fila.pendientes = pendientes(p); http[200] = (http[200] ?? 0) + 1;
      if (muestras.performance_ficha.length < 4 && fila.pendientes.some(x => x.objetivo === 'UP_TECHNICAL_SPECIFICATIONS_MAIN')) muestras.performance_ficha.push({ id, faltan: fila.faltan, atributos: it?.attributes ?? null, performance: p });
    } catch (e) {
      if (e?.fatal || e?.status === 429) throw e;
      const k = e?.status ?? 0; http[k] = (http[k] ?? 0) + 1; fila.performance_http = k;
      if (muestras.performance_error.length < 6) muestras.performance_error.push({ id, http: k, detalle: e?.detalle ?? null, catalogo: fila.catalogo, user_product: fila.user_product, variaciones: fila.variaciones });
    }
    filas.push(fila);
  });

  const resumen = { fecha: fechaUy(), activas: ids.length, items_leidos: items.size, visitas: visitasHttp, http_performance: http, categorias: categorias.size, ...resumir(filas) };
  mkdirSync(salida, { recursive: true });
  writeFileSync(join(salida, 'medicion.json'), JSON.stringify({ resumen, muestras, filas }, null, 1));
  const { combinaciones, ...corto } = resumen;
  console.log(JSON.stringify({ ...corto, combinaciones_top: Object.entries(combinaciones).sort((a, b) => b[1] - a[1]).slice(0, 12) })); // sólo conteos y nombres de atributos
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) main().catch(e => { console.error('medir:', e?.code ?? e?.message); process.exit(1); });
