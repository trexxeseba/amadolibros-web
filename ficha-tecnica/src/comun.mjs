// Piezas comunes de Ficha técnica (pedido de Seba, 27/11/2026): completar los atributos que le faltan
// a la ficha técnica de los libros de Amado Libros para bajar "Con objetivos de calidad por lograr".
//
// Sólo Amado Libros (seller 440298103). El token se lee de D1 (lo renueva el Worker, nunca acá) y
// antes de nada se verifica con /users/me que el token es de Amado Libros.
// El repo es público: el log lleva sólo conteos y códigos; el detalle va al repo privado.
import { fuenteTokenD1 } from '../../precio-ganador/src/token.mjs';
import { crearCliente } from '../../precio-ganador/src/ml.mjs';

export const LIBROS = Object.freeze({ clave: 'libros', nombre: 'Amado Libros', sellerId: '440298103', token: { tabla: 'ml_oauth', appId: '4741021817925208' } });

// Atributos que este proceso nunca escribe: identificadores (cargar un ISBN puede pasar la
// publicación a Catálogo) y todo lo que no sea ficha técnica.
export const NUNCA = Object.freeze(new Set(['GTIN', 'ISBN', 'SELLER_SKU', 'ITEM_CONDITION', 'EMPTY_GTIN_REASON', 'BOOK_TITLE', 'MPN', 'SALE_FORMAT', 'UNITS_PER_PACK']));

export async function clienteLibros(opciones = {}) {
  const ml = crearCliente(fuenteTokenD1(LIBROS), { concurrencia: 4, ...opciones });
  const yo = await ml.get('/users/me');
  if (String(yo?.id) !== LIBROS.sellerId) throw Object.assign(new Error('token_de_otra_cuenta'), { code: 'token_de_otra_cuenta', fatal: true });
  return ml;
}

export async function idsPorEstado(ml, estado = 'active') {
  const out = []; let scroll = null;
  for (let pagina = 0; pagina < 500; pagina++) {
    const d = await ml.get(`/users/${LIBROS.sellerId}/items/search?status=${estado}&search_type=scan&limit=100${scroll ? `&scroll_id=${encodeURIComponent(scroll)}` : ''}`);
    const res = Array.isArray(d?.results) ? d.results : [];
    if (!res.length) break;
    out.push(...res); scroll = d?.scroll_id ?? null;
    if (!scroll) break;
  }
  return [...new Set(out)];
}

export async function enParalelo(lista, n, fn) {
  const cola = [...lista];
  await Promise.all(Array.from({ length: n }, async () => { while (cola.length) await fn(cola.shift()); }));
}

export const trozos = (lista, n) => Array.from({ length: Math.ceil(lista.length / n) }, (_, i) => lista.slice(i * n, i * n + n));

// Un atributo cuenta como cargado si tiene valor o si dice "no aplica" (value_id -1).
export function cargado(attr) {
  if (!attr) return false;
  if (String(attr.value_id ?? '') === '-1') return true;
  if (attr.value_name != null && String(attr.value_name).trim() !== '') return true;
  if (attr.value_id != null && String(attr.value_id).trim() !== '') return true;
  return Array.isArray(attr.values) && attr.values.some(v => (v?.name ?? v?.id ?? '') !== '' || v?.struct);
}

export function isbnDe(item) {
  for (const a of item?.attributes ?? []) {
    if (!['GTIN', 'ISBN'].includes(a?.id)) continue;
    for (const v of [a.value_name, ...(a.values ?? []).map(x => x?.name)]) {
      const d = String(v ?? '').replace(/[^0-9Xx]/g, '').toUpperCase();
      if (d.length === 13 && /^97[89]/.test(d)) return d;
      if (d.length === 10) return d;
    }
  }
  return null;
}

// Atributos principales de una categoría, según technical_specs/input (grupo MAIN) y, si no viene,
// los de relevancia 1 o requeridos. Excluye los ocultos, de sólo lectura y los de NUNCA. Función pura.
export function principales(atributosCategoria, specs) {
  const enMain = new Set();
  for (const g of Array.isArray(specs?.groups) ? specs.groups : []) {
    if (!/MAIN/i.test(String(g?.id ?? ''))) continue;
    for (const c of g.components ?? []) for (const a of c.attributes ?? []) if (a?.id) enMain.add(a.id);
  }
  const out = [];
  for (const a of Array.isArray(atributosCategoria) ? atributosCategoria : []) {
    const t = a?.tags ?? {};
    if (!a?.id || NUNCA.has(a.id) || t.hidden || t.read_only || t.fixed || t.others) continue;
    const main = enMain.size ? enMain.has(a.id) : (a.relevance === 1 || t.required || t.catalog_required);
    if (main) out.push({ id: a.id, nombre: a.name ?? a.id, tipo: a.value_type ?? null, requerido: !!(t.required || t.catalog_required), multivalor: !!t.multivalued, valores: Array.isArray(a.values) ? a.values.length : 0 });
  }
  return out;
}

export function faltantes(item, principalesCat) {
  const por = new Map((item?.attributes ?? []).map(a => [a.id, a]));
  return principalesCat.filter(p => !cargado(por.get(p.id))).map(p => p.id);
}

export const fechaUy = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Montevideo' }).format(d);
