// Bandeja de oportunidades: lo que el panel sugiere hacer (subir un precio,
// reponer, tener con entrega inmediata) guardado en D1 con estado, evidencia y
// fecha, para que una sugerencia no se pierda al día siguiente ni se avise dos
// veces. Cada oportunidad tiene un id determinista (tipo:ISBN): volver a
// calcularla actualiza la evidencia y "visto por última vez", nunca el estado
// que Seba ya le puso.
//
// No cambia precios ni compra: sólo ordena decisiones con su evidencia.
// Cantidades: objetivo − stock físico − tránsito confirmado, nunca menos de 0,
// y 2 o 3 unidades sólo con repetición real de ventas y costo conocido.
import { bookIsbn } from './isbn.js';

export const OPPORTUNITY_STATES = Object.freeze(['pendiente', 'aprobado', 'descartado', 'pedido', 'recibido', 'resultado']);
export const OPPORTUNITY_TYPES = Object.freeze({
  subir_precio: 'Subir el precio',
  reponer: 'Reponer',
  tener_inmediato: 'Tener con entrega inmediata',
});
const CONFIDENCE_RANK = { alta: 3, media: 2, baja: 1 };
const DAY_MS = 86400000, HOUR_MS = 3600000;
// Una oportunidad que no se volvió a observar en 3 días deja de ser vigente
// (sigue en la bandeja con su estado, pero no cuenta como pendiente de hoy).
export const VIGENTE_DAYS = 3;
const LEAD_DAYS = 15;

export const OPPORTUNITY_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS comp_opportunities(id TEXT PRIMARY KEY,isbn TEXT NOT NULL,tipo TEXT NOT NULL,titulo TEXT,estado TEXT NOT NULL DEFAULT 'pendiente',accion TEXT,impacto_mes REAL,confianza TEXT,cantidad INTEGER,cantidad_nivel TEXT,evidencia_json TEXT NOT NULL,enlaces_json TEXT,first_seen_at INTEGER NOT NULL,last_seen_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,estado_at INTEGER,nota TEXT,notificado_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS comp_opportunities_estado ON comp_opportunities(estado,last_seen_at)`,
];

export async function ensureOpportunities(db) {
  for (const sql of OPPORTUNITY_SCHEMA) await db.prepare(sql).run();
}

const round10 = v => Math.floor(v / 10) * 10;
const money = v => `$ ${Math.round(v).toLocaleString('es-UY')}`;

// Cuántas unidades pedir. Objetivo = lo que se vende en el plazo del proveedor
// más un mes, acotado a 1, 2 o 3. Para pasar de 1 hace falta repetición real
// (3 o más en el año y 2 o más en 90 días), costo conocido y ventana de ventas
// completa; si falta algo, queda en 1 como prueba (provisional) y el 2/3 se
// marca bloqueado con el motivo. Una señal externa aislada en un ISBN sin
// ventas propias vale una prueba de 1, nunca 3.
export function cantidadSugerida({ u90 = 0, u365 = 0, stock = 0, en_transito = 0, costo_conocido = false, ventana_completa = true, senal_externa = false, lead_days = LEAD_DAYS } = {}) {
  const faltantes = [];
  if (!costo_conocido) faltantes.push('costo');
  if (!ventana_completa) faltantes.push('ventas_365d');
  if (!(u90 > 0) && !(u365 > 0) && !senal_externa) return { objetivo: 0, cantidad: 0, nivel: 'bloqueado', motivo: 'sin ventas propias ni señal externa', faltantes };
  let objetivo = Math.min(3, Math.max(1, Math.round((u90 / 3) * (lead_days + 30) / 30)));
  let nivel = 'firme', motivo = null;
  const repeticion = u365 >= 3 && u90 >= 2;
  if (!(u90 > 0) && !(u365 > 0)) { objetivo = 1; nivel = 'provisional'; motivo = 'una sola señal externa: probar con 1'; }
  else if (objetivo > 1 && !repeticion) { objetivo = 1; nivel = 'provisional'; motivo = 'sin repetición real de ventas: probar con 1'; }
  else if (objetivo > 1 && faltantes.length) { objetivo = 1; nivel = 'provisional'; motivo = `2 o 3 bloqueado hasta completar ${faltantes.join(' y ')}: probar con 1`; }
  else if (faltantes.length) { nivel = 'provisional'; motivo = `faltan ${faltantes.join(' y ')}`; }
  const cantidad = Math.max(0, objetivo - Math.max(0, Number(stock) || 0) - Math.max(0, Number(en_transito) || 0));
  return { objetivo, cantidad, nivel, motivo, faltantes };
}

function confianzaPrecio(f, { costoConocido, agotado, comparables = 0 }) {
  if (agotado || f.foto_edad_horas > 48 || f.captura_posterior) return 'baja';
  if (comparables >= 2 && costoConocido) return 'alta';
  return 'media';
}

// Oportunidades a partir del resultado de loadBi (panel-bi) y, si se tienen,
// los hechos de reposición por ISBN (en tránsito, ventana de ventas). `meta`:
// ISBN → {title, thumbnail, permalink, item} del catálogo, para tapa y enlaces.
export function opportunitiesFromBi(bi, { facts = new Map(), meta = new Map(), nowMs = Date.now() } = {}) {
  const out = [];
  const links = isbn => { const m = meta.get(isbn); return { panel: `/panel/reposicion?q=${isbn}`, ml: m?.permalink ?? (m?.item ? `https://articulo.mercadolibre.com.uy/${m.item.replace(/^MLU/, 'MLU-')}` : null), tapa: m?.thumbnail ?? null }; };
  const comp = bi?.competencia?.ok ? bi.competencia.data?.facts : null;
  const books = bi?.abc?.ok ? bi.abc.data.sorted : [];
  const byIsbn = new Map(books.map(b => [b.isbn, b]));
  if (bi?.precios?.ok && bi.precios.data) {
    for (const b of bi.precios.data.lista) {
      const f = comp?.get(b.isbn), costoConocido = Boolean(b.margenActual);
      const fuentes = `${b.competidores} ${b.aPedido ? 'a pedido' : 'con entrega inmediata'} en la ficha de catálogo de ML`;
      out.push({
        id: `subir_precio:${b.isbn}`, isbn: b.isbn, tipo: 'subir_precio', titulo: b.title ?? null,
        accion: `Subir de ${money(b.actual)} a ${money(b.sugerido)} (+${b.subaPct}%)${b.agotado ? ' cuando lo repongas' : ''}`,
        impacto_mes: b.agotado ? null : b.ganaMes, confianza: f ? confianzaPrecio(f, { costoConocido, agotado: b.agotado, comparables: b.competidores }) : 'baja',
        cantidad: null, cantidad_nivel: null,
        evidencia: { tu_precio: b.actual, sugerido: b.sugerido, suba_pct: b.subaPct, mas_barato: b.min, comparables: b.competidores, a_pedido: Boolean(b.aPedido), u90: b.u90, stock: b.stock, agotado: b.agotado,
          margen_actual: b.margenActual?.margin ?? null, margen_sugerido: b.margenSugerido?.margin ?? null, costo_conocido: costoConocido, foto: f?.foto ?? null, foto_edad_horas: f?.foto_edad_horas ?? null, fuentes,
          texto: `Lo tenés a ${money(b.actual)} y el más barato ${b.aPedido ? 'a pedido' : 'con entrega inmediata'} está a ${money(b.min)} (${fuentes}). Sugerencia: ${money(b.sugerido)}, 2% debajo. ${b.ganaMes ? `Al ritmo de 90 días son ${money(b.ganaMes)} más por mes si sigue vendiendo igual.` : ''}${costoConocido ? '' : ' Sin costo cargado: el margen no se puede confirmar.'}`.trim() },
        enlaces: links(b.isbn),
      });
    }
  }
  const inv = bi?.inventario?.ok ? bi.inventario.data : null;
  for (const b of inv?.aSinStock ?? []) {
    if (!b.mercado || !['solo', 'sostenible'].includes(b.mercado.estado)) continue;
    const f = comp?.get(b.isbn), r = facts.get(b.isbn), costoConocido = b.costo != null;
    const q = cantidadSugerida({ u90: b.u90, u365: b.u365, stock: b.stock, en_transito: r?.compras?.en_transito_estimado ?? 0, costo_conocido: costoConocido, ventana_completa: r?.ventas?.ventana_365d_completa ?? true });
    const margenMin = b.mercado.margenAlMin ?? b.margen?.margin ?? null;
    const compraTxt = b.compra ? ` Última compra: ${b.compra.supplier} el ${new Date(b.compra.d).toISOString().slice(0, 10)}.` : ' Sin compra registrada con ISBN.';
    const transito = r?.compras?.en_transito_estimado ? ` Hay ${r.compras.en_transito_estimado} en camino: se descuenta.` : '';
    out.push({
      id: `reponer:${b.isbn}`, isbn: b.isbn, tipo: 'reponer', titulo: b.title ?? null,
      accion: q.cantidad > 0 ? `Reponer ${q.cantidad}${q.nivel === 'provisional' ? ' (prueba)' : ''}` : 'Ya cubierto con stock y tránsito',
      impacto_mes: margenMin != null ? Math.round((b.u90 / 3) * margenMin) : null,
      confianza: !f ? 'baja' : f.foto_edad_horas > 48 ? 'baja' : costoConocido && (r?.ventas?.ventana_365d_completa ?? true) ? 'alta' : 'media',
      cantidad: q.cantidad, cantidad_nivel: q.nivel,
      evidencia: { u90: b.u90, u365: b.u365, stock: b.stock, en_transito: r?.compras?.en_transito_estimado ?? 0, mercado: b.mercado.estado, comparables: b.mercado.nacionales ?? 0, mas_barato: b.mercado.min ?? null, a_pedido: f?.competidores_a_pedido ?? 0,
        costo: b.costo ?? null, margen_al_minimo: margenMin, costo_conocido: costoConocido, objetivo: q.objetivo, cantidad_motivo: q.motivo, faltantes: q.faltantes, foto: f?.foto ?? null, foto_edad_horas: f?.foto_edad_horas ?? null, ultima_compra: b.compra ?? null,
        texto: `${b.mercado.texto}${transito}${compraTxt} Vendiste ${b.u90} en 90 días y ${b.u365} en el año.${q.motivo ? ` Cantidad: ${q.motivo}.` : ''}` },
      enlaces: links(b.isbn),
    });
  }
  // Nadie lo tiene con entrega inmediata, todos a pedido, y nosotros sin stock:
  // evaluar tenerlo en mano. Sólo para libros que vendimos y no son A sin stock
  // (esos ya salen como "reponer").
  const reponerIds = new Set(out.filter(o => o.tipo === 'reponer').map(o => o.isbn));
  if (comp) for (const [isbn, f] of comp) {
    const b = byIsbn.get(isbn);
    if (!b || reponerIds.has(isbn) || b.stock > 0 || !(b.u90 > 0) || f.competidores_comparables || !f.competidores_a_pedido) continue;
    const q = cantidadSugerida({ u90: b.u90, u365: b.u365, stock: b.stock, costo_conocido: false, ventana_completa: facts.get(isbn)?.ventas?.ventana_365d_completa ?? true });
    out.push({
      id: `tener_inmediato:${isbn}`, isbn, tipo: 'tener_inmediato', titulo: b.title ?? null,
      accion: `Evaluar tenerlo inmediato: probar con ${Math.max(1, q.cantidad)}`,
      impacto_mes: null, confianza: f.foto_edad_horas > 48 ? 'baja' : 'media', cantidad: Math.max(1, q.cantidad), cantidad_nivel: 'provisional',
      evidencia: { u90: b.u90, u365: b.u365, stock: b.stock, a_pedido: f.competidores_a_pedido, mas_barato_a_pedido: f.precio_minimo_a_pedido, tu_precio_promedio: b.avgPrice ?? null, foto: f.foto, foto_edad_horas: f.foto_edad_horas,
        texto: `${f.competidores_a_pedido} vendedor${f.competidores_a_pedido === 1 ? '' : 'es'} lo ofrece${f.competidores_a_pedido === 1 ? '' : 'n'} a pedido desde ${money(f.precio_minimo_a_pedido)} y nadie con entrega inmediata en la ficha de ML (foto del ${f.foto}). Vendiste ${b.u90} en 90 días. Tenerlo en mano puede quedarse con la venta: probar con 1 y medir.` },
      enlaces: links(isbn),
    });
  }
  return out.map(o => ({ ...o, evidencia: { ...o.evidencia, calculado: new Date(nowMs).toISOString() } }));
}

const rankOf = o => (o.impacto_mes ?? -1) * 1000 + (CONFIDENCE_RANK[o.confianza] ?? 0);

// Guarda o actualiza. El estado existente no se toca; la evidencia y la fecha
// de última observación sí. Devuelve cuántas son nuevas.
export async function upsertOpportunities(db, list, nowMs = Date.now()) {
  await ensureOpportunities(db);
  const ids = list.map(o => o.id);
  const existing = new Set(ids.length ? (await db.prepare('SELECT id FROM comp_opportunities WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(ids)).all()).results.map(r => r.id) : []);
  const stmts = list.map(o => db.prepare(`INSERT INTO comp_opportunities(id,isbn,tipo,titulo,estado,accion,impacto_mes,confianza,cantidad,cantidad_nivel,evidencia_json,enlaces_json,first_seen_at,last_seen_at,updated_at) VALUES(?,?,?,?,'pendiente',?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET titulo=COALESCE(excluded.titulo,comp_opportunities.titulo),accion=excluded.accion,impacto_mes=excluded.impacto_mes,confianza=excluded.confianza,cantidad=excluded.cantidad,cantidad_nivel=excluded.cantidad_nivel,evidencia_json=excluded.evidencia_json,enlaces_json=excluded.enlaces_json,last_seen_at=excluded.last_seen_at,updated_at=excluded.updated_at`)
    .bind(o.id, o.isbn, o.tipo, o.titulo ?? null, o.accion ?? null, o.impacto_mes ?? null, o.confianza ?? null, o.cantidad ?? null, o.cantidad_nivel ?? null, JSON.stringify(o.evidencia ?? {}), JSON.stringify(o.enlaces ?? {}), nowMs, nowMs, nowMs));
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  return { total: list.length, nuevas: ids.filter(id => !existing.has(id)).length, actualizadas: ids.filter(id => existing.has(id)).length };
}

const parse = r => ({ ...r, impacto_mes: r.impacto_mes == null ? null : Number(r.impacto_mes), cantidad: r.cantidad == null ? null : Number(r.cantidad),
  evidencia: JSON.parse(r.evidencia_json || '{}'), enlaces: JSON.parse(r.enlaces_json || '{}'), vigente: null });

// Lista ordenada por impacto sustentado y confianza; `vigente` dice si se
// volvió a observar en los últimos días.
export async function listOpportunities(db, { estado = 'pendiente', limit = 100, nowMs = Date.now(), tipo = null } = {}) {
  await ensureOpportunities(db);
  const where = ['1=1'], args = [];
  if (estado && estado !== 'todas') { where.push('estado=?'); args.push(estado); }
  if (tipo) { where.push('tipo=?'); args.push(tipo); }
  const { results } = await db.prepare(`SELECT * FROM comp_opportunities WHERE ${where.join(' AND ')} ORDER BY last_seen_at DESC LIMIT ?`).bind(...args, Math.min(500, Math.max(1, limit))).all();
  const since = nowMs - VIGENTE_DAYS * DAY_MS;
  return results.map(parse).map(o => ({ ...o, vigente: Number(o.last_seen_at) >= since, visto_hace_horas: Math.round((nowMs - Number(o.last_seen_at)) / HOUR_MS) }))
    .sort((a, b) => Number(b.vigente) - Number(a.vigente) || rankOf(b) - rankOf(a) || Number(b.last_seen_at) - Number(a.last_seen_at));
}

export async function setOpportunityState(db, id, estado, { nota = null, nowMs = Date.now() } = {}) {
  if (!OPPORTUNITY_STATES.includes(estado)) throw new Error('invalid_state');
  await ensureOpportunities(db);
  const r = await db.prepare('UPDATE comp_opportunities SET estado=?,estado_at=?,updated_at=?,nota=COALESCE(?,nota) WHERE id=?').bind(estado, nowMs, nowMs, nota ? String(nota).slice(0, 500) : null, String(id)).run();
  return Number(r?.meta?.changes ?? 0) > 0;
}

export async function opportunitySummary(db, nowMs = Date.now()) {
  await ensureOpportunities(db);
  const since = nowMs - VIGENTE_DAYS * DAY_MS;
  const { results } = await db.prepare('SELECT estado, COUNT(*) AS n, SUM(CASE WHEN last_seen_at>=? THEN 1 ELSE 0 END) AS vigentes, SUM(CASE WHEN estado=\'pendiente\' AND notificado_at IS NULL AND last_seen_at>=? THEN 1 ELSE 0 END) AS sin_avisar FROM comp_opportunities GROUP BY estado').bind(since, since).all();
  const por_estado = Object.fromEntries(OPPORTUNITY_STATES.map(s => [s, { total: 0, vigentes: 0 }]));
  let sin_avisar = 0;
  for (const r of results) { por_estado[r.estado] = { total: Number(r.n), vigentes: Number(r.vigentes) }; sin_avisar += Number(r.sin_avisar || 0); }
  return { por_estado, pendientes_vigentes: por_estado.pendiente.vigentes, sin_avisar };
}

// Para el correo: pendientes vigentes que todavía no se avisaron, por impacto.
export async function pendingToNotify(db, { limit = 8, nowMs = Date.now() } = {}) {
  const all = await listOpportunities(db, { estado: 'pendiente', limit: 500, nowMs });
  return all.filter(o => o.vigente && o.notificado_at == null).slice(0, limit);
}
export async function markNotified(db, ids, nowMs = Date.now()) {
  if (!ids.length) return;
  await db.prepare('UPDATE comp_opportunities SET notificado_at=? WHERE id IN (SELECT value FROM json_each(?)) AND notificado_at IS NULL').bind(nowMs, JSON.stringify(ids)).run();
}

// Índice ISBN → tapa, enlace y publicación, desde catalog.json.
export function catalogMeta(catalog) {
  const meta = new Map();
  for (const item of Array.isArray(catalog?.items) ? catalog.items : []) {
    const isbn = bookIsbn(item?.isbn);
    if (!isbn) continue;
    const m = meta.get(isbn) ?? { title: item.title ?? null, thumbnail: null, permalink: null, item: null };
    if (item.status === 'active' || !m.item) { m.item = item.id ?? m.item; m.permalink = item.permalink ?? m.permalink; m.thumbnail = item.thumbnail ?? m.thumbnail; }
    meta.set(isbn, m);
  }
  return meta;
}

// Recalcula la bandeja a partir de Brújula (loadBi) y los hechos de reposición.
// Lo llama el Worker antes del correo diario y la ruta manual; nunca lanza.
export async function refreshOpportunities(db, { bi, catalog = null, factsFor = null, precios = null, nowMs = Date.now() } = {}) {
  try {
    // Si vino la revisión de precios de todo el catálogo (más completa: rango,
    // costo con fecha, comisión, faltantes), reemplaza las subas de Brújula.
    const merge = list => (Array.isArray(precios) ? [...list.filter(o => o.tipo !== 'subir_precio'), ...precios] : list);
    const list0 = merge(opportunitiesFromBi(bi, { meta: catalogMeta(catalog), nowMs }));
    let facts = new Map();
    const isbns = [...new Set(list0.filter(o => o.tipo !== 'subir_precio').map(o => o.isbn))].slice(0, 50);
    if (factsFor && isbns.length) {
      try { facts = new Map((await factsFor(isbns)).resultados.filter(r => r.isbn).map(r => [r.isbn, r])); } catch { facts = new Map(); }
    }
    const list = facts.size ? merge(opportunitiesFromBi(bi, { facts, meta: catalogMeta(catalog), nowMs })) : list0;
    const r = await upsertOpportunities(db, list, nowMs);
    return { state: 'ok', ...r, con_hechos: facts.size, con_revision_precios: Array.isArray(precios) ? precios.length : null };
  } catch (error) {
    return { state: 'error', code: error?.code || error?.message || 'error' };
  }
}
