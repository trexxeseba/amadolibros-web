// Importación externa auditable (Nubimetrics, Administrado u otra fuente que
// exporte CSV). Contrato interno: cada carga guarda el original (texto y hash
// SHA-256), fuente, mercado, vendedor, fecha de extracción, período,
// completitud declarada, el mapeo usado y una fila por línea con su número de
// fila y la línea cruda (trazabilidad). El mismo archivo dos veces no se
// importa dos veces; dentro de un archivo, dos filas iguales se marcan.
//
// Reglas de lectura: una señal externa es "estimada" salvo que la fuente diga
// lo contrario; nunca se suman ventanas móviles ni se suman Administrado y
// Nubimetrics del mismo origen como ventas distintas: por ISBN se devuelve la
// última observación de cada fuente/vendedor/ventana, y quien decide las ve
// lado a lado.
//
// Sin una muestra real del archivo no hay mapeo "verificado": las plantillas
// de abajo salen de columnas vistas en pantalla y quedan marcadas
// verificado=false; la importación falla si las columnas no están y muestra
// las que encontró, para ajustar el mapeo. XLSX: convertir a CSV antes
// (pendiente un adaptador, sin dependencias en el Worker).
import { bookIsbn } from './isbn.js';
import { titleKey } from './purchases.js';

export const FUENTES = Object.freeze(['nubimetrics', 'administrado', 'otra']);
export const TIPOS = Object.freeze(['competidores_ventas', 'competidor_publicaciones', 'demanda', 'otro']);
export const COMPLETITUD = Object.freeze(['completa', 'parcial', 'desconocida']);
const MAX_TEXT = 900 * 1024, MAX_ROWS = 20000;

export const PLANTILLAS = Object.freeze({
  // Administrado > Competidores > Ventas de ayer (exportar Excel → CSV). Columnas
  // vistas en pantalla el 27/10/2026; la pantalla dice "cifras rivales
  // estimadas" y actualización a las 10. No confirmado contra un archivo real.
  administrado_competidores_ventas: { verificado: false, fuente: 'administrado', tipo: 'competidores_ventas', ventana_dias: 7, estimado: true, moneda: 'UYU',
    columnas: { titulo: 'publicación', vendedor: 'competidor', precio: 'precio', vendidas_ayer: 'vendidas ayer', vendidas: 'vendidas 7d', logistica: 'logística' },
    nota: 'Columnas vistas en pantalla, no en un archivo. Cifras rivales estimadas por la fuente.' },
  // Nubimetrics > Analiza un competidor > Publicaciones (Exportar). Columnas
  // vistas en pantalla; la descarga no quedó confirmada.
  nubimetrics_competidor_publicaciones: { verificado: false, fuente: 'nubimetrics', tipo: 'competidor_publicaciones', ventana_dias: null, estimado: true, moneda: 'UYU',
    columnas: { titulo: 'título', isbn: 'gtin', precio: 'precio promedio' },
    nota: 'Métricas aproximadas por período según la pantalla. Sin muestra real del archivo.' },
});

export const EXTERNAL_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ext_imports(id TEXT PRIMARY KEY,fuente TEXT NOT NULL,tipo TEXT NOT NULL,mercado TEXT NOT NULL,vendedor TEXT,extraccion TEXT,periodo_desde TEXT,periodo_hasta TEXT,ventana_dias INTEGER,completitud TEXT NOT NULL,nombre_archivo TEXT,bytes INTEGER NOT NULL,filas_total INTEGER NOT NULL,filas_validas INTEGER NOT NULL,filas_invalidas INTEGER NOT NULL,filas_duplicadas INTEGER NOT NULL,mapeo_json TEXT NOT NULL,plantilla TEXT,original_text TEXT,nota TEXT,created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ext_rows(import_id TEXT NOT NULL,fila INTEGER NOT NULL,isbn TEXT,gtin_raw TEXT,titulo TEXT,titulo_key TEXT,vendedor TEXT,precio REAL,moneda TEXT,vendidas REAL,vendidas_ayer REAL,ventana_dias INTEGER,logistica TEXT,estimado INTEGER NOT NULL DEFAULT 1,valida INTEGER NOT NULL,motivo TEXT,duplicada_de INTEGER,dedupe_key TEXT,raw_json TEXT NOT NULL,PRIMARY KEY(import_id,fila))`,
  `CREATE INDEX IF NOT EXISTS ext_rows_isbn ON ext_rows(isbn)`,
  `CREATE INDEX IF NOT EXISTS ext_rows_titulo ON ext_rows(titulo_key)`,
];
const ready = new WeakSet();
export async function ensureExternal(db) {
  if (ready.has(db)) return;
  for (const sql of EXTERNAL_SCHEMA) await db.prepare(sql).run();
  ready.add(db);
}

export class ImportError extends Error { constructor(code, status = 400, detail = null) { super(code); this.code = code; this.status = status; this.detail = detail; } }

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// CSV con comillas, saltos dentro de comillas, BOM y delimitador detectado (; , tab).
export function parseCsv(text) {
  const src = String(text ?? '').replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = [';', ',', '\t'].map(d => [d, (firstLine.match(new RegExp(d === '\t' ? '\t' : `\\${d}`, 'g')) || []).length]).sort((a, b) => b[1] - a[1])[0][0];
  const lines = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && src[i + 1] === '\n') i++; row.push(cell); lines.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell.length || row.length) { row.push(cell); lines.push(row); }
  const nonEmpty = lines.filter(l => l.some(c => c.trim() !== ''));
  if (!nonEmpty.length) return { headers: [], rows: [], delimiter };
  const headers = nonEmpty[0].map(h => h.trim());
  const rows = nonEmpty.slice(1).map((l, i) => ({ fila: i + 2, celdas: Object.fromEntries(headers.map((h, k) => [h, (l[k] ?? '').trim()])) }));
  return { headers, rows, delimiter };
}

const fold = v => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

// Qué columna del archivo corresponde a cada campo del mapeo (sin acentos ni
// mayúsculas). Devuelve las faltantes y las cabeceras encontradas.
export function validarMapeo(headers, columnas) {
  const byFold = new Map(headers.map(h => [fold(h), h]));
  const encontradas = {}, faltantes = [];
  for (const [campo, col] of Object.entries(columnas ?? {})) {
    const h = byFold.get(fold(col));
    if (h) encontradas[campo] = h; else faltantes.push(`${campo} (${col})`);
  }
  return { ok: !faltantes.length, faltantes, encontradas, cabeceras: headers };
}

// Números como los escriben las fuentes locales: "1.200" (miles), "1.200,50",
// "990", "1,5". Con punto y coma, el último es el decimal; un solo punto con
// tres dígitos detrás es separador de miles; una sola coma es decimal.
export const num = v => {
  if (v == null || v === '') return null;
  let s = String(v).replace(/[^\d,.-]/g, '');
  if (!s) return null;
  const dot = s.lastIndexOf('.'), comma = s.lastIndexOf(',');
  if (dot >= 0 && comma >= 0) s = dot > comma ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.');
  else if (dot >= 0) { if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, ''); }
  else if (comma >= 0) s = /^-?\d{1,3}(,\d{3})+$/.test(s) && (s.match(/,/g) || []).length > 1 ? s.replace(/,/g, '') : s.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const dateOk = v => v == null || v === '' || /^\d{4}-\d{2}-\d{2}/.test(String(v));

// Carga un CSV. Devuelve el id (hash del original) y los conteos. Un original
// ya cargado (mismo hash) no se vuelve a cargar: devuelve duplicado=true.
export async function importarExterno(db, input, nowMs = Date.now()) {
  const a = input ?? {};
  const plantilla = a.plantilla ? PLANTILLAS[a.plantilla] : null;
  if (a.plantilla && !plantilla) throw new ImportError('plantilla_desconocida');
  const fuente = String(a.fuente ?? plantilla?.fuente ?? ''), tipo = String(a.tipo ?? plantilla?.tipo ?? '');
  if (!FUENTES.includes(fuente)) throw new ImportError('fuente_invalida');
  if (!TIPOS.includes(tipo)) throw new ImportError('tipo_invalido');
  const completitud = String(a.completitud ?? 'desconocida');
  if (!COMPLETITUD.includes(completitud)) throw new ImportError('completitud_invalida');
  if (![a.extraccion, a.periodo_desde, a.periodo_hasta].every(dateOk)) throw new ImportError('fechas_invalidas');
  const csv = String(a.csv ?? '');
  if (!csv.trim()) throw new ImportError('csv_vacio');
  if (csv.length > MAX_TEXT) throw new ImportError('csv_demasiado_grande', 413);
  const columnas = a.mapeo?.columnas ?? plantilla?.columnas;
  if (!columnas || typeof columnas !== 'object') throw new ImportError('mapeo_requerido', 400, { ayuda: 'mapeo.columnas = { isbn|titulo, vendedor?, precio?, vendidas?, vendidas_ayer?, logistica? } con el nombre exacto de cada columna del archivo' });
  if (!columnas.isbn && !columnas.titulo) throw new ImportError('mapeo_sin_isbn_ni_titulo');
  const ventanaDias = a.ventana_dias ?? a.mapeo?.ventana_dias ?? plantilla?.ventana_dias ?? null;
  const moneda = String(a.moneda ?? a.mapeo?.moneda ?? plantilla?.moneda ?? 'UYU');
  const estimado = a.estimado ?? a.mapeo?.estimado ?? plantilla?.estimado ?? true;
  await ensureExternal(db);
  const id = await sha256Hex(csv);
  const prev = await db.prepare('SELECT id,filas_validas,created_at FROM ext_imports WHERE id=?').bind(id).first();
  if (prev) return { import_id: id, duplicado: true, filas_validas: Number(prev.filas_validas), cargado_en: Number(prev.created_at) };
  const { headers, rows, delimiter } = parseCsv(csv);
  if (!headers.length) throw new ImportError('csv_sin_cabeceras');
  if (rows.length > MAX_ROWS) throw new ImportError('csv_demasiadas_filas', 413);
  const check = validarMapeo(headers, columnas);
  if (!check.ok) throw new ImportError('columnas_faltantes', 422, { faltantes: check.faltantes, cabeceras_encontradas: headers, delimitador: delimiter });
  const col = campo => check.encontradas[campo];
  const seen = new Map();
  let validas = 0, invalidas = 0, duplicadas = 0;
  const stmts = [];
  for (const r of rows) {
    const c = r.celdas;
    const gtin = col('isbn') ? c[col('isbn')] : null, titulo = col('titulo') ? c[col('titulo')] : null;
    const isbn = gtin ? bookIsbn(gtin) : null;
    const vendedor = col('vendedor') ? c[col('vendedor')] || null : (a.vendedor ?? null);
    const precio = col('precio') ? num(c[col('precio')]) : null, vendidas = col('vendidas') ? num(c[col('vendidas')]) : null, ayer = col('vendidas_ayer') ? num(c[col('vendidas_ayer')]) : null;
    const logistica = col('logistica') ? c[col('logistica')] || null : null;
    let valida = 1, motivo = null;
    if (!isbn && !titulo) { valida = 0; motivo = gtin ? 'isbn_invalido' : 'sin_isbn_ni_titulo'; }
    else if (gtin && !isbn) motivo = 'isbn_invalido_queda_titulo';
    const key = valida ? [fuente, tipo, vendedor ?? '', isbn ?? titleKey(titulo), ventanaDias ?? '', precio ?? '', vendidas ?? ''].join('|') : null;
    let dupDe = null;
    if (key) { if (seen.has(key)) { dupDe = seen.get(key); duplicadas++; } else seen.set(key, r.fila); }
    if (valida) validas++; else invalidas++;
    stmts.push(db.prepare('INSERT INTO ext_rows(import_id,fila,isbn,gtin_raw,titulo,titulo_key,vendedor,precio,moneda,vendidas,vendidas_ayer,ventana_dias,logistica,estimado,valida,motivo,duplicada_de,dedupe_key,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(id, r.fila, isbn, gtin || null, titulo || null, titulo ? titleKey(titulo) : null, vendedor, precio, moneda, vendidas, ayer, ventanaDias, logistica, estimado ? 1 : 0, valida, motivo, dupDe, key, JSON.stringify(c)));
  }
  await db.prepare('INSERT INTO ext_imports(id,fuente,tipo,mercado,vendedor,extraccion,periodo_desde,periodo_hasta,ventana_dias,completitud,nombre_archivo,bytes,filas_total,filas_validas,filas_invalidas,filas_duplicadas,mapeo_json,plantilla,original_text,nota,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(id, fuente, tipo, String(a.mercado ?? 'MLU'), a.vendedor ?? null, a.extraccion ?? null, a.periodo_desde ?? null, a.periodo_hasta ?? null, ventanaDias, completitud, a.nombre_archivo ?? null, csv.length, rows.length, validas, invalidas, duplicadas,
      JSON.stringify({ columnas: check.encontradas, ventana_dias: ventanaDias, moneda, estimado: Boolean(estimado), plantilla_verificada: plantilla ? plantilla.verificado : null }), a.plantilla ?? null, csv, a.nota ?? null, nowMs).run();
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  return { import_id: id, duplicado: false, fuente, tipo, filas_total: rows.length, filas_validas: validas, filas_invalidas: invalidas, filas_duplicadas: duplicadas, columnas: check.encontradas, delimitador: delimiter, plantilla_verificada: plantilla ? plantilla.verificado : null,
    advertencia: plantilla && !plantilla.verificado ? 'Plantilla no verificada contra un archivo real: revisá que las columnas signifiquen lo que dice el mapeo.' : null };
}

export async function listImports(db, limit = 20) {
  await ensureExternal(db);
  const { results } = await db.prepare('SELECT id,fuente,tipo,mercado,vendedor,extraccion,periodo_desde,periodo_hasta,ventana_dias,completitud,nombre_archivo,bytes,filas_total,filas_validas,filas_invalidas,filas_duplicadas,plantilla,nota,created_at FROM ext_imports ORDER BY created_at DESC LIMIT ?').bind(Math.min(200, Math.max(1, limit))).all();
  return results.map(r => ({ ...r, created_at: Number(r.created_at) }));
}

// Señales externas por ISBN: la última observación de cada fuente/tipo/
// vendedor/ventana. No se suman entre sí ni entre ventanas.
export async function externalSignals(db, isbns) {
  const out = new Map();
  const valid = [...new Set(isbns.filter(Boolean))];
  if (!valid.length) return out;
  let rows;
  try {
    rows = (await db.prepare(`SELECT r.isbn,r.titulo,r.vendedor,r.precio,r.moneda,r.vendidas,r.vendidas_ayer,r.ventana_dias,r.logistica,r.estimado,r.fila,i.id AS import_id,i.fuente,i.tipo,i.extraccion,i.periodo_desde,i.periodo_hasta,i.completitud,i.created_at
      FROM ext_rows r JOIN ext_imports i ON i.id=r.import_id WHERE r.valida=1 AND r.duplicada_de IS NULL AND r.isbn IN (SELECT value FROM json_each(?)) ORDER BY i.created_at DESC, r.fila ASC`).bind(JSON.stringify(valid)).all()).results;
  } catch { return out; }
  for (const r of rows) {
    const list = out.get(r.isbn) ?? [];
    const key = `${r.fuente}|${r.tipo}|${r.vendedor ?? ''}|${r.ventana_dias ?? ''}`;
    if (list.some(x => x.clave === key)) continue; // ya está la observación más reciente
    list.push({ clave: key, fuente: r.fuente, tipo: r.tipo, vendedor: r.vendedor, precio: r.precio, moneda: r.moneda, vendidas: r.vendidas, vendidas_ayer: r.vendidas_ayer, ventana_dias: r.ventana_dias, logistica: r.logistica,
      etiqueta: Number(r.estimado) ? 'estimado' : 'observado', extraccion: r.extraccion, periodo: { desde: r.periodo_desde, hasta: r.periodo_hasta }, completitud: r.completitud, import_id: r.import_id, fila: r.fila });
    out.set(r.isbn, list);
  }
  return out;
}

// ISBN que aparecen en fuentes externas y no están en nuestro catálogo, con
// cruces: búsquedas sin resultado en la web y lista de espera (por título).
// Proveedores que ya nos vendieron ese ISBN (cualquier fecha) y disponibilidad
// vigente en el feed de SBS, para un ISBN externo: convierte un hallazgo de
// radar en "sabemos dónde conseguirlo" en vez de sólo "alguien más lo vende".
async function proveedorCrossCheck(db, isbns) {
  const out = new Map();
  if (!isbns.length) return out;
  try {
    const { results } = await db.prepare(`SELECT i.isbn, o.supplier, MAX(o.purchase_date_ms) AS d FROM purchase_items i JOIN purchase_orders o ON o.purchase_id=i.purchase_id
      WHERE o.superseded_by IS NULL AND COALESCE(o.document_type,'invoice')<>'credit_note' AND i.isbn IN (SELECT value FROM json_each(?)) GROUP BY i.isbn, o.supplier`).bind(JSON.stringify(isbns)).all();
    for (const r of results) {
      const e = out.get(r.isbn) ?? { proveedores: [], sbs: null };
      e.proveedores.push({ proveedor: r.supplier, ultima_compra: new Date(Number(r.d)).toISOString().slice(0, 10) });
      out.set(r.isbn, e);
    }
  } catch { /* sin compras cargadas */ }
  try {
    const feed = await db.prepare("SELECT id, source_date FROM sbs_supplier_feeds WHERE state='ready' ORDER BY source_date DESC LIMIT 1").first();
    if (feed) {
      const { results } = await db.prepare(`SELECT isbn, data_json FROM sbs_supplier_stock WHERE feed_id=? AND isbn IN (SELECT value FROM json_each(?))`).bind(feed.id, JSON.stringify(isbns)).all();
      for (const r of results) {
        const e = out.get(r.isbn) ?? { proveedores: [], sbs: null };
        let data = null; try { data = JSON.parse(r.data_json); } catch { data = null; }
        e.sbs = { disponible: data?.stock ?? 'no_figura', feed_fecha: feed.source_date };
        out.set(r.isbn, e);
      }
    }
  } catch { /* sin feed de SBS todavía */ }
  return out;
}

export async function radarExterno(db, catalog, { limit = 50, nowMs = Date.now() } = {}) {
  await ensureExternal(db);
  const own = new Set();
  for (const item of Array.isArray(catalog?.items) ? catalog.items : []) { const i = bookIsbn(item?.isbn); if (i) own.add(i); }
  const { results } = await db.prepare(`SELECT r.isbn, MAX(r.titulo) AS titulo, MAX(r.titulo_key) AS titulo_key, COUNT(DISTINCT i.fuente) AS fuentes, COUNT(DISTINCT COALESCE(r.vendedor,'')) AS vendedores, MAX(r.vendidas) AS vendidas_max, MAX(r.ventana_dias) AS ventana_dias, MIN(r.precio) AS precio_min, MAX(i.created_at) AS visto, GROUP_CONCAT(DISTINCT i.fuente) AS fuentes_lista
    FROM ext_rows r JOIN ext_imports i ON i.id=r.import_id WHERE r.valida=1 AND r.duplicada_de IS NULL AND r.isbn IS NOT NULL GROUP BY r.isbn ORDER BY vendidas_max DESC, visto DESC LIMIT ?`).bind(Math.min(500, limit * 4)).all();
  const externos = results.filter(r => !own.has(r.isbn)).slice(0, limit);
  let misses = [], waitlist = [];
  try { misses = (await db.prepare('SELECT query, SUM(count) AS n FROM search_misses WHERE date>=? GROUP BY query').bind(new Date(nowMs - 90 * 86400000).toISOString().slice(0, 10)).all()).results; } catch { misses = []; }
  try { waitlist = (await db.prepare("SELECT product_title, COUNT(*) AS n FROM stock_waitlist WHERE status='waiting' GROUP BY product_title").all()).results; } catch { waitlist = []; }
  const missKeys = misses.map(m => ({ key: titleKey(m.query), n: Number(m.n), query: m.query })).filter(m => m.key.length >= 6);
  const waitKeys = waitlist.map(w => ({ key: titleKey(w.product_title), n: Number(w.n), title: w.product_title })).filter(w => w.key.length >= 6);
  const proveedores = await proveedorCrossCheck(db, externos.map(r => r.isbn));
  return externos.map(r => {
    const tk = r.titulo_key ?? '';
    const buscado = tk.length >= 6 ? missKeys.filter(m => tk.includes(m.key) || m.key.includes(tk)) : [];
    const espera = tk.length >= 6 ? waitKeys.filter(w => tk.includes(w.key) || w.key.includes(tk)) : [];
    const prov = proveedores.get(r.isbn) ?? { proveedores: [], sbs: null };
    return { isbn: r.isbn, titulo: r.titulo, fuentes: Number(r.fuentes), fuentes_lista: String(r.fuentes_lista ?? '').split(','), vendedores: Number(r.vendedores), vendidas_max: r.vendidas_max == null ? null : Number(r.vendidas_max), ventana_dias: r.ventana_dias, precio_min: r.precio_min == null ? null : Number(r.precio_min),
      visto: Number(r.visto), etiqueta: 'estimado', buscado_sin_resultado: buscado.reduce((n, m) => n + m.n, 0), busquedas: buscado.slice(0, 3).map(m => m.query), lista_espera: espera.reduce((n, w) => n + w.n, 0), en_catalogo: false,
      proveedores_conocidos: prov.proveedores, sbs: prov.sbs };
  });
}
