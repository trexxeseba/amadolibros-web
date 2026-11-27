// Paso 3 de Ficha técnica: cargar. Completa atributos de ficha técnica que faltan, con dato de fuente.
//
//   node ficha-tecnica/src/cargar.mjs --salida DIR --estado DIR_PRIVADO [--tope 300] [--real] [--mail]
//
// Reglas de Seba (27/11/2026):
//  - Sólo atributos de ficha técnica. Nunca título, precio, descripción, fotos, stock, promociones.
//  - Nunca se toca un ISBN/GTIN (ni se agrega): podría pasar la publicación a Catálogo.
//  - Un dato sólo se carga si salió de una fuente (ver fuentes.mjs). Nada inventado ni estimado.
//  - Cada carga se confirma releyendo la publicación. Registro por publicación (atributo, antes,
//    después, fuente) en el repo privado, para poder revertir.
//  - Lotes con pausa; el cliente reintenta ante 429.
// Sin --real no escribe: lista lo que haría. El log sólo lleva conteos.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clienteLibros, cargado, isbnDe, principales, faltantes, fechaUy, NUNCA, LIBROS } from './comun.mjs';
import { CAMPOS, crearFuentes, decidir } from './fuentes.mjs';
import { pendientes } from '../../precio-ganador/src/calidad.mjs';
import { formatoML, avisoUnico } from '../../scripts/lib/mail-ml.mjs';
import { nextInternalEmailAt } from '../../functions/_shared/internal-email-schedule.js';

const fold = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const espera = ms => new Promise(r => setTimeout(r, ms));
const REINTENTO_SIN_DATO_DIAS = 14;

// Valor a mandar para un atributo según su definición en la categoría. Función pura.
// Lista cerrada: sólo si el valor coincide con uno permitido (se manda su id). Número: entero.
// Texto libre: el valor tal cual. Devuelve null si no se puede cargar sin adivinar.
export function valorPara(def, valor) {
  if (!def || valor == null || String(valor).trim() === '') return null;
  const lista = Array.isArray(def.values) ? def.values : [];
  const tipo = def.value_type;
  if (tipo === 'number' || tipo === 'number_unit') {
    const n = Number(String(valor).replace(/[^\d]/g, ''));
    if (!Number.isInteger(n) || n <= 0) return null;
    return tipo === 'number' ? { value_name: String(n) } : null;
  }
  if (tipo === 'list' || tipo === 'boolean') {
    const v = lista.find(x => fold(x?.name) === fold(valor));
    return v ? { value_id: String(v.id), value_name: v.name } : null;
  }
  if (lista.length) { const v = lista.find(x => fold(x?.name) === fold(valor)); if (v) return { value_id: String(v.id), value_name: v.name }; }
  const max = Number(def.value_max_length) || 255;
  const s = String(valor).trim();
  return s.length <= max ? { value_name: s } : null;
}

// "No aplica" en Serie y Volumen (Seba, 27/11/2026, opción a): sólo si Open Library tiene la ficha de ese
// ISBN y no declara serie, y el título de la publicación no menciona tomo, volumen, número ni saga.
// Subtítulo y Edición nunca van con "No aplica". Función pura.
export const NO_APLICA = Object.freeze(['BOOK_SERIE', 'BOOK_VOLUME']);
export const REGLA = 'na1';
const MARCA_VOLUMEN = /\b(tomo|tomos|vol|vols|volumen|volúmenes|volumenes|libro\s+\d|parte\s+\d|n[ºo°]\.?\s*\d|saga|serie|series|trilog\w*|tetralog\w*|bilog\w*|colecci[oó]n|pack|set|box|estuche|edici[oó]n\s+completa|obras?\s+completas?)\b|#\s*\d|\b\d{1,3}\b|\b[IVX]{1,4}\b/i;
export function puedeNoAplica(titulo, porFuente) {
  const f = porFuente?.ficha_openlibrary;
  return !!f?.existe && !f.con_serie && !!String(titulo ?? '').trim() && !MARCA_VOLUMEN.test(String(titulo));
}

// Propuesta para una publicación: qué atributos faltan y con qué dato. Función pura.
export function proponer(item, defs, principalesCat, porFuente) {
  const faltan = faltantes(item, principalesCat).filter(id => !NUNCA.has(id));
  const cambios = [], sinDato = [], sinFormato = [];
  for (const id of faltan) {
    const campo = CAMPOS[id];
    if (!campo && !NO_APLICA.includes(id)) { sinDato.push(id); continue; }
    const d = campo ? decidir(campo, porFuente) : null;
    if (!d) {
      if (NO_APLICA.includes(id) && puedeNoAplica(item?.title, porFuente)) cambios.push({ id, value_id: '-1', value_name: null, fuente: 'no_aplica_openlibrary', coinciden: ['openlibrary'], contradicciones: [] });
      else sinDato.push(id);
      continue;
    }
    const v = valorPara(defs.get(id), d.valor);
    if (!v) { sinFormato.push({ id, valor: d.valor, fuente: d.fuente }); continue; }
    cambios.push({ id, ...v, fuente: d.fuente, coinciden: d.coinciden, contradicciones: d.contradicciones });
  }
  return { faltan, cambios, sinDato, sinFormato };
}

// ¿Quedó guardado? Compara lo releído con lo pedido. Función pura.
export function verificar(itemDespues, cambios) {
  const por = new Map((itemDespues?.attributes ?? []).map(a => [a.id, a]));
  return cambios.map(c => {
    const a = por.get(c.id);
    const ok = !!a && cargado(a) && (c.value_id ? String(a.value_id) === String(c.value_id) : fold(a.value_name) === fold(c.value_name));
    return { id: c.id, ok, quedo: a ? (a.value_name ?? null) : null };
  });
}

function leerJson(ruta, defecto) { try { return existsSync(ruta) ? JSON.parse(readFileSync(ruta, 'utf8')) : defecto; } catch { return defecto; } }

async function main() {
  const args = process.argv.slice(2);
  const opt = (n, d = null) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
  const salida = opt('salida', 'salida'), estado = opt('estado', '.'), tope = Number(opt('tope', 300)), real = args.includes('--real'), mail = args.includes('--mail');
  const soloIds = String(opt('ids', '') || '').split(',').map(s => s.trim()).filter(Boolean);
  mkdirSync(salida, { recursive: true });
  const hoy = fechaUy();

  const medicion = leerJson(join(salida, 'medicion.json'), null) ?? leerJson(join(estado, 'ultima-medicion.json'), null);
  if (!medicion?.filas) { console.error('cargar: falta la medición'); process.exit(1); }
  const hechas = leerJson(join(estado, 'hechas.json'), {});
  // Las revisadas antes de la regla de "No aplica" (sin regla na1) se vuelven a mirar.
  const vencido = f => !f || f.regla !== REGLA || (f.estado === 'sin_dato' && (Date.now() - Date.parse(f.fecha)) / 864e5 >= REINTENTO_SIN_DATO_DIAS);

  const conFicha = medicion.filas.filter(f => (f.pendientes ?? []).some(p => p.objetivo === 'UP_TECHNICAL_SPECIFICATIONS_MAIN'));
  let candidatas = conFicha.filter(f => !f.catalogo && f.isbn && vencido(hechas[f.id]));
  if (soloIds.length) candidatas = medicion.filas.filter(f => soloIds.includes(f.id));
  candidatas.sort((a, b) => (b.visitas30 ?? 0) - (a.visitas30 ?? 0) || b.ventas - a.ventas || a.id.localeCompare(b.id));

  const ml = await clienteLibros();
  const fuentes = crearFuentes();
  const defsCat = new Map(), princCat = new Map();
  async function categoria(cat) {
    if (defsCat.has(cat)) return;
    const attrs = await ml.get(`/categories/${cat}/attributes`).catch(() => []);
    const specs = await ml.get(`/categories/${cat}/technical_specs/input`).catch(() => null);
    defsCat.set(cat, new Map((attrs ?? []).map(a => [a.id, a]))); princCat.set(cat, principales(attrs, specs));
  }

  const r = { fecha: hoy, modo: real ? 'real' : 'prueba', pendientes_ficha_en_medicion: conFicha.length, sin_isbn: conFicha.filter(f => !f.isbn).length, catalogo: conFicha.filter(f => f.catalogo).length,
    candidatas: candidatas.length, revisadas: 0, cargadas_verificadas: 0, atributos_cargados: 0, parciales: 0, sin_dato_de_fuente: 0, errores: 0, no_verificadas: 0, objetivo_resuelto_al_releer: 0, por_atributo: {}, por_fuente: {}, contradicciones: 0, sin_formato: 0, errores_http: {} };
  const registro = [], hechasHoy = {};
  const LOTE = 25;
  for (let i = 0; i < candidatas.length && (real ? r.cargadas_verificadas : r.revisadas) < tope; i += LOTE) {
    const lote = candidatas.slice(i, i + LOTE);
    const porIsbn = await fuentes.buscar([...new Set(lote.map(f => f.isbn))]);
    for (const f of lote) {
      if (real ? r.cargadas_verificadas >= tope : r.revisadas >= tope) break;
      let item;
      try { item = await ml.get(`/items/${f.id}?include_attributes=all`); } catch (e) { if (e?.fatal) throw e; r.errores++; r.errores_http[e?.status ?? 0] = (r.errores_http[e?.status ?? 0] ?? 0) + 1; continue; }
      if (item?.seller_id != null && String(item.seller_id) !== LIBROS.sellerId) { r.errores++; continue; }
      if (item?.status !== 'active' || item?.catalog_listing) continue;
      r.revisadas++;
      await categoria(item.category_id);
      const isbn = isbnDe(item) ?? f.isbn;
      const p = proponer(item, defsCat.get(item.category_id), princCat.get(item.category_id), porIsbn.get(isbn) ?? {});
      r.sin_formato += p.sinFormato.length;
      if (!p.cambios.length) { r.sin_dato_de_fuente++; hechasHoy[f.id] = { fecha: hoy, estado: 'sin_dato', faltan: p.faltan, regla: REGLA }; registro.push({ fecha: hoy, id: f.id, isbn, estado: 'sin_dato', faltan: p.faltan, sin_formato: p.sinFormato }); continue; }
      const antes = Object.fromEntries(p.cambios.map(c => [c.id, (item.attributes ?? []).find(a => a.id === c.id) ?? null]));
      if (!real) { r.parciales++; registro.push({ fecha: hoy, id: f.id, isbn, estado: 'haria', cambios: p.cambios, antes, sin_dato: p.sinDato, sin_formato: p.sinFormato }); continue; }
      try {
        await ml.put(`/items/${f.id}`, { attributes: p.cambios.map(c => ({ id: c.id, ...(c.value_id ? { value_id: c.value_id } : {}), value_name: c.value_name })) });
      } catch (e) {
        if (e?.fatal) throw e;
        r.errores++; const k = e?.status ?? 0; r.errores_http[k] = (r.errores_http[k] ?? 0) + 1;
        registro.push({ fecha: hoy, id: f.id, isbn, estado: 'error', http: k, detalle: e?.detalle ?? null, cambios: p.cambios, antes });
        if (r.errores >= 10 && r.errores > r.cargadas_verificadas) { r.cortado = 'demasiados_errores'; break; }
        continue;
      }
      await espera(400);
      let despues = null; try { despues = await ml.get(`/items/${f.id}?include_attributes=all`); } catch {}
      const ver = verificar(despues, p.cambios);
      const okIds = ver.filter(v => v.ok).map(v => v.id);
      const intactos = despues && String(despues.price) === String(item.price) && despues.title === item.title && !!despues.catalog_listing === !!item.catalog_listing && JSON.stringify((despues.attributes ?? []).find(a => a.id === 'GTIN') ?? null) === JSON.stringify((item.attributes ?? []).find(a => a.id === 'GTIN') ?? null);
      let objetivo = null;
      try { const perf = await ml.get(`/item/${f.id}/performance`); objetivo = pendientes(perf).some(x => x.objetivo === 'UP_TECHNICAL_SPECIFICATIONS_MAIN') ? 'sigue_pendiente' : 'resuelto'; } catch {}
      if (objetivo === 'resuelto') r.objetivo_resuelto_al_releer++;
      if (okIds.length === p.cambios.length && intactos) r.cargadas_verificadas++; else r.no_verificadas++;
      r.atributos_cargados += okIds.length;
      for (const c of p.cambios.filter(c => okIds.includes(c.id))) { r.por_atributo[c.id] = (r.por_atributo[c.id] ?? 0) + 1; r.por_fuente[c.fuente] = (r.por_fuente[c.fuente] ?? 0) + 1; if (c.contradicciones.length) r.contradicciones++; }
      hechasHoy[f.id] = { fecha: hoy, estado: okIds.length === p.cambios.length ? 'cargada' : 'parcial', objetivo, regla: REGLA };
      registro.push({ fecha: hoy, id: f.id, isbn, estado: okIds.length === p.cambios.length && intactos ? 'verificada' : 'no_verificada', intactos, objetivo, cambios: p.cambios, antes, verificacion: ver, sin_dato: p.sinDato, sin_formato: p.sinFormato });
    }
    if (r.cortado) break;
    await espera(1500);
  }
  r.fuentes = fuentes.estadisticas;
  r.restantes_estimadas = Math.max(0, candidatas.length - r.revisadas);

  // Lista aparte para Gaby: lo que no se resuelve por API (fotos), con el link a cada publicación.
  const fotos = medicion.filas.filter(f => (f.pendientes ?? []).some(p => p.objetivo === 'UP_PICTURES')).sort((a, b) => (b.visitas30 ?? 0) - (a.visitas30 ?? 0) || b.ventas - a.ventas);
  writeFileSync(join(salida, 'fotos-para-gaby.csv'), ['publicacion,link,regla,visitas_30_dias,ventas', ...fotos.map(f => [f.id, `https://articulo.mercadolibre.com.uy/MLU-${f.id.replace(/^MLU/, '')}`, (f.pendientes.find(p => p.objetivo === 'UP_PICTURES')?.regla ?? ''), f.visitas30 ?? '', f.ventas].join(','))].join('\n') + '\n');
  r.fotos_para_gaby = fotos.length;

  writeFileSync(join(salida, 'resumen-carga.json'), JSON.stringify(r, null, 1));
  writeFileSync(join(salida, 'registro.jsonl'), registro.map(x => JSON.stringify(x)).join('\n') + (registro.length ? '\n' : ''));
  writeFileSync(join(salida, 'hechas.json'), JSON.stringify({ ...hechas, ...hechasHoy }));
  console.log(JSON.stringify({ ...r, por_fuente: r.por_fuente, fuentes: { registro: r.fuentes.registro, arnoia: r.fuentes.arnoia, celesa: r.fuentes.celesa } })); // sólo conteos

  if (mail && real) await mandarMail(r, medicion.resumen);
  if (r.cortado) process.exitCode = 1;
}

async function mandarMail(r, med) {
  if (!(await avisoUnico('ficha-tecnica-diaria'))) return;
  const ritmo = r.cargadas_verificadas || 1, dias = Math.ceil(r.restantes_estimadas / ritmo);
  const texto = [
    `Publicaciones con objetivos de calidad por lograr (activas): ${med?.con_objetivos ?? 's/d'}`,
    `Con la ficha técnica pendiente: ${r.pendientes_ficha_en_medicion}`,
    `Completadas y verificadas hoy: ${r.cargadas_verificadas} (${r.atributos_cargados} datos)`,
    `Sin dato en ninguna fuente: ${r.sin_dato_de_fuente}`,
    `Con error: ${r.errores}`,
    `Quedan por revisar: ${r.restantes_estimadas} (a este ritmo, unos ${dias} días)`,
    `Fotos para Gaby: ${r.fotos_para_gaby} publicaciones (lista en el repo privado, ficha-tecnica/fotos-para-gaby.csv)`,
  ].join('\n');
  const f = formatoML({ app: 'Mercado Libre de Amado Libros', proyecto: 'Ficha técnica de los libros', cometido: 'Completar los datos que faltan en la ficha técnica para bajar los objetivos de calidad',
    texto, desactivar: ['Apagar: GitHub > Actions > "Ficha técnica de Amado Libros" > Disable workflow.', 'Cambiar cuántas por día: variable FICHA_TOPE_DIARIO del repo (hoy 300).'] });
  const to = String(process.env.FICHA_EMAIL_TO ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (!process.env.RESEND_API_KEY || !to.length) return;
  const res = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30000),
    body: JSON.stringify({ scheduled_at: nextInternalEmailAt(), from: process.env.REPORT_EMAIL_FROM || 'Amado Libros <web@notificaciones.amadolibros.com>', to, subject: `Ficha técnica ${r.fecha}: ${r.cargadas_verificadas} completadas`, text: f.texto, html: f.html }) }).catch(() => null);
  console.log('mail', res?.ok ? 'programado' : `no salió (${res?.status ?? 'transporte'})`);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) main().catch(e => { console.error('cargar:', e?.code ?? e?.message, String(e?.path ?? '').replace(/MLU\w+/g, 'MLU…').split('?')[0]); process.exit(1); });
