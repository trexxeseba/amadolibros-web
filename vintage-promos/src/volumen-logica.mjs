// Lógica pura de la renovación de una promoción de volumen de Amado Vintage ("llevá N, X % de
// descuento"). Sin red ni reloj implícito. La parte con red está en renovar-volumen.mjs.

const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);
const lista = j => Array.isArray(j) ? j : Array.isArray(j?.results) ? j.results : [];
export const normalizar = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

// Promoción de volumen vigente (started) con ese nombre; si hay varias, la que termina más tarde.
export function buscarActual(promos, nombre) {
  const n = normalizar(nombre);
  const cand = lista(promos).filter(p => p?.type === 'VOLUME' && normalizar(p.name) === n && String(p.status).toLowerCase() === 'started');
  cand.sort((a, b) => Date.parse(b.finish_date) - Date.parse(a.finish_date));
  return cand[0] ?? null;
}

// ¿Ya hay una renovación cargada? Misma promo de volumen (pending o started) que empieza
// después de que termine la actual. Evita crear dos veces si el workflow se corre de nuevo.
export function buscarRenovada(promos, actual) {
  const n = normalizar(actual?.name), fin = Date.parse(actual?.finish_date);
  return lista(promos).find(p => p?.type === 'VOLUME' && p.id !== actual?.id && normalizar(p.name) === n
    && ['pending', 'started'].includes(String(p.status).toLowerCase()) && Date.parse(p.start_date) >= fin) ?? null;
}

const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

// Cuerpo del POST para renovar "igual": mismos N, mismo porcentaje, misma combinación, mismo
// largo, empezando justo cuando termina la actual. `porcentajeEsperado` frena si la promo
// actual no es la que Seba aprobó (30 %).
export function planRenovacion({ actual, ficha, porcentajeEsperado, ahora = Date.now() }) {
  const f = { ...actual, ...ficha };
  const buy = num(f.buy_quantity), pct = num(f.discount_percentage);
  const ini = Date.parse(f.start_date), fin = Date.parse(f.finish_date);
  if (f.type !== 'VOLUME') return { error: 'no_es_volumen' };
  if (buy === null || buy < 2 || pct === null || pct <= 0 || pct >= 100) return { error: 'ficha_incompleta' };
  if (porcentajeEsperado !== undefined && pct !== Number(porcentajeEsperado)) return { error: 'porcentaje_distinto_del_aprobado', actual: pct };
  if (!Number.isFinite(ini) || !Number.isFinite(fin) || fin <= ini) return { error: 'fechas_invalidas' };
  const nuevoIni = fin + 1000;                       // 02:59:59Z + 1 s = 03:00:00Z = 00:00 de Uruguay
  if (nuevoIni <= ahora) return { error: 'la_actual_ya_termino' };
  const largo = fin - ini + 1000;                    // mismo largo que la actual
  return {
    body: {
      promotion_type: 'VOLUME', sub_type: f.sub_type ?? 'SPONTH', name: f.name,
      start_date: iso(nuevoIni), finish_date: iso(nuevoIni + largo - 1000),
      buy_quantity: buy, discount_percentage: pct, allow_combination: f.allow_combination !== false,
    },
    dias: Math.round(largo / 86400e3),
  };
}

// Cuerpo para sumar un libro a la promoción nueva (mismo formato que las otras promos).
export const cuerpoItem = promoId => ({ promotion_id: promoId, promotion_type: 'VOLUME' });

// Ids de libros de una página de la promoción (clave `id` de cada entrada).
export const idsDePagina = r => lista(r).map(e => e?.id).filter(id => typeof id === 'string' && /^MLU\d+$/.test(id));

// Resumen de los resultados de sumar libros: por código, sin ids ni montos.
export function contar(resultados) {
  const c = {};
  for (const r of resultados) c[r] = (c[r] ?? 0) + 1;
  return c;
}
