// Reglas de poda de anuncios de Mercado Ads (acordadas con Seba el 11/11/2026).
// Módulo puro: sin red, sin reloj implícito, sin secretos. Lo usan la corrida diaria
// y los tests. Cada "anuncio" es un grupo de anuncios de Mercado Ads (ad group): la
// fila que se ve en la consola. Para una publicación tradicional es la publicación;
// para una de catálogo agrupa nuestras publicaciones de ese producto.
//
//  1. Tope de gasto sin venta = 10 % del precio del libro, piso $150, techo $400.
//  2. Clics que se le aguantan sin venta = tope / costo por clic, mínimo 5.
//     Nunca se pausa con menos de 5 clics.
//  3. Se pausa al llegar al tope de gasto o al tope de clics sin ninguna venta
//     atribuida en los 30 días.
//  4. No se pausa si tuvo una venta, atribuida o no (órdenes sin canceladas), en
//     los últimos 30 días.
//  5. Se reactiva un anuncio pausado por la poda si aparece una venta atribuida
//     tarde o una venta en órdenes.
//  6. Se reactiva si cambió el precio o entró en promoción, y el gasto se vuelve a
//     contar desde ese día.
//  7. Clic caro: costo por clic mayor al 4 % del precio. Sólo se informa.
//  8. Excepciones: campañas protegidas, sin precio legible, deshabilitados.
//  9. Con promoción se usa el precio de lista para el tope (no pausa de más).

export const REGLAS = Object.freeze({
  pctTope: 0.10,
  pisoTope: 150,
  techoTope: 400,
  minClics: 5,
  pctClicCaro: 0.04,
  // En observación: sin venta y con la mitad del tope o más gastado.
  pctObservacion: 0.5,
  maxPorCorrida: 25,
  maxPorDia: 60,
  diasVentana: 30,
});

const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);
const r2 = v => Math.round(v * 100) / 100;

// Regla 1.
export function topeGasto(precio) {
  const p = num(precio);
  if (p === null || p <= 0) return null;
  return Math.min(REGLAS.techoTope, Math.max(REGLAS.pisoTope, r2(p * REGLAS.pctTope)));
}

// Regla 2. Sin costo por clic conocido no hay tope de clics (queda el de gasto).
export function topeClics(tope, cpc) {
  const t = num(tope), c = num(cpc);
  if (t === null || c === null || c <= 0) return null;
  return Math.max(REGLAS.minClics, Math.floor(t / c));
}

// Costo por clic: el que informa Mercado Ads; si no viene, gasto / clics.
export function costoPorClic({ cpc, gasto, clics }) {
  const c = num(cpc);
  if (c !== null && c > 0) return c;
  const g = num(gasto), k = num(clics);
  return g !== null && k ? r2(g / k) : null;
}

// Regla 9: precio para el tope. Con promoción, el de lista (el mayor).
export function precioParaTope({ precio, precioLista }) {
  const p = num(precio), l = num(precioLista);
  if (l !== null && l > 0 && (p === null || l > p)) return l;
  return p !== null && p > 0 ? p : null;
}

// Reglas 1 a 4, 7 y 8 para un anuncio activo. Devuelve:
//   { accion: 'pausar' | 'mantener' | 'observar' | 'no_aplica' | 'falta_precio' | 'protegido' | 'revisar',
//     motivo, tope, topeClics, cpc, clicCaro }
export function evaluarAnuncio(a) {
  const gasto = num(a.gasto) ?? 0, clics = num(a.clics) ?? 0;
  const cpc = costoPorClic({ cpc: a.cpc, gasto, clics });
  const precio = precioParaTope({ precio: a.precio, precioLista: a.precioLista });
  const tope = topeGasto(precio);
  const tc = topeClics(tope, cpc);
  const clicCaro = precio !== null && cpc !== null && cpc > REGLAS.pctClicCaro * precio;
  const base = { tope, topeClics: tc, cpc, precio, clicCaro };
  const res = (accion, motivo) => ({ ...base, accion, motivo });

  if (a.estado !== 'ACTIVE') return res('no_aplica', `Estado ${a.estado ?? 'desconocido'}: no se poda.`);
  if (a.protegido) return res('protegido', a.protegido);
  const atribuidas = num(a.ventasAtribuidas) ?? 0, ordenes = num(a.ventasOrdenes) ?? 0;
  if (atribuidas > 0 || ordenes > 0) return res('mantener', 'Tuvo venta en los últimos 30 días (regla 4).');
  if (clics < REGLAS.minClics) return res('mantener', `Menos de ${REGLAS.minClics} clics.`);
  if (tope === null) return res('falta_precio', 'No se pudo leer el precio: no se poda.');
  const porGasto = gasto >= tope, porClics = tc !== null && clics >= tc;
  if (porGasto || porClics) {
    if (a.revisar) return res('revisar', a.revisar);
    return res('pausar', porGasto ? `Gastó ${r2(gasto)} sin venta, tope ${tope}.` : `${clics} clics sin venta, tope ${tc} clics.`);
  }
  if (gasto >= tope * REGLAS.pctObservacion) return res('observar', `Sin venta, gastó ${r2(gasto)} de un tope de ${tope}.`);
  return res('mantener', 'Debajo del tope.');
}

// Reglas 5 y 6 para un anuncio pausado por la poda.
//   registro: { precio_lista, promo } al pausar
//   ahora: { ventasAtribuidas, ventasOrdenesDesdePausa, precioLista, promo }
export function evaluarReactivacion(registro, ahora) {
  if ((num(ahora.ventasAtribuidas) ?? 0) > 0) return { accion: 'reactivar', regla: 5, motivo: 'Venta atribuida tarde (regla 5).' };
  if ((num(ahora.ventasOrdenesDesdePausa) ?? 0) > 0) return { accion: 'reactivar', regla: 5, motivo: 'Venta en órdenes después de la pausa (regla 5).' };
  const antes = num(registro?.precio_lista), hoy = num(ahora.precioLista);
  if (antes !== null && hoy !== null && Math.abs(hoy - antes) >= 1) return { accion: 'reactivar', regla: 6, motivo: `Cambió el precio de ${antes} a ${hoy} (regla 6): el gasto se cuenta de cero.` };
  if (ahora.promo && !registro?.promo) return { accion: 'reactivar', regla: 6, motivo: 'Entró en una promoción (regla 6): el gasto se cuenta de cero.' };
  return { accion: 'mantener', regla: null, motivo: 'Sigue pausado.' };
}

// Freno: cuántas pausas nuevas entran en esta corrida. Las que sobran no se proponen.
export function aplicarFreno(candidatos, { nuevasHoy = 0 } = {}) {
  const lugar = Math.max(0, Math.min(REGLAS.maxPorCorrida, REGLAS.maxPorDia - nuevasHoy));
  const orden = [...candidatos].sort((a, b) => (num(b.gasto) ?? 0) - (num(a.gasto) ?? 0));
  const excedentes = orden.length > lugar ? orden.slice(lugar) : [];
  return { entran: orden.slice(0, lugar), excedentes, lugar, alerta: excedentes.length > 0 };
}
