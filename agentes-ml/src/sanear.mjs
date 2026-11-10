// El repo y sus logs de Actions son públicos. Lo que se imprime son formas
// (claves y tipos), nunca montos de ventas, visitas, métricas de publicidad ni
// datos de terceros. Los precios y promociones de nuestras publicaciones ya se ven
// en Mercado Libre: esos sí pueden salir con valor cuando hace falta verificarlos.
const ISO = /^\d{4}-\d{2}-\d{2}/;

// Forma de un valor: claves con el tipo de cada una; los números y textos se tapan.
export function forma(v, prof = 0) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return v.length ? [forma(v[0], prof + 1), `n=${v.length}`] : [];
  if (typeof v === 'object') {
    if (prof > 6) return 'obj';
    const o = {};
    for (const k of Object.keys(v).slice(0, 80)) o[k] = forma(v[k], prof + 1);
    return o;
  }
  if (typeof v === 'number') return 'num';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'string') return ISO.test(v) ? 'fecha' : 'str';
  return typeof v;
}

// Texto corto y sin caracteres raros para mensajes de error de la API.
export const texto = s => String(s ?? '').replace(/[^\w .,:;()/%_=|-]/g, '').slice(0, 200);

// Identificador tapado: deja ver que existe sin exponerlo entero.
export const mascara = id => { const s = String(id ?? ''); return s.length <= 4 ? '****' : s.slice(0, 3) + '…' + s.slice(-2); };

// Quedarse con algunas claves de un objeto (para imprimir valores permitidos).
export function elegir(obj, claves) {
  const o = {};
  if (obj && typeof obj === 'object') for (const k of claves) if (obj[k] !== undefined) o[k] = obj[k];
  return o;
}

// Detalle de un MlError apto para log: código, HTTP y mensaje saneado.
export function detalleError(e) {
  return { error: texto(e?.code ?? e?.message ?? 'error'), http: e?.status ?? null, detalle: e?.detalle ? texto(JSON.stringify(e.detalle)) : null };
}
