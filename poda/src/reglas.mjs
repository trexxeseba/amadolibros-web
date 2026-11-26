// Reglas de poda de anuncios de Mercado Ads (acordadas con Seba el 11/11/2026; las de pausa cambian el 26/11/2026, ver evaluarAnuncio).
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
// 10. Venta cara (agregada el 14/11/2026): con venta en 30 días igual se pausa si ya
//     gastó su tope y el costo por venta (gasto / ventas) supera pctCostoVenta del
//     precio. Una venta sola no alcanza si costó más de lo que deja.
//     Un anuncio pausado por venta cara se reactiva sólo con una venta en órdenes
//     posterior a la pausa (sus ventas atribuidas de antes no cuentan).
//  6 (ajuste del 14/11/2026): reactiva si el precio BAJÓ o entró en promoción. Una suba
//     de precio no lo hace más fácil de vender: no reactiva.

export const REGLAS = Object.freeze({
  pctTope: 0.10,
  pisoTope: 150,
  techoTope: 400,
  minClics: 5,
  pctClicCaro: 0.04,
  // Regla 10: costo por venta máximo, como fracción del precio (propuesta: 20 %).
  pctCostoVenta: 0.20,
  // En observación: sin venta y con la mitad del tope o más gastado.
  pctObservacion: 0.5,
  maxPorCorrida: 25,
  maxPorDia: 60,
  diasVentana: 30,
  // Reglas del 26/11/2026.
  clicsSinVenta: 15,
  clicsObservacion: 10,
  diasSeguidos: 3,
  roasMinimo: 2.5,
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

// Regla 10: costo por venta y su peso sobre el precio. Sin precio o sin ventas, null.
export function costoPorVenta({ gasto, ventas, precio }) {
  const g = num(gasto) ?? 0, v = num(ventas), p = num(precio);
  if (!v || v <= 0 || p === null || p <= 0) return null;
  return { porVenta: r2(g / v), pct: Math.round((g / v / p) * 1000) / 1000 };
}

// Reglas de pausa de Seba del 26/11/2026 (reemplazan las 1 a 4, 7 y 10 del 11/11), métricas a 30 días:
//  A. 15 o más clics sin ninguna venta (atribuida o en órdenes).
//  B. 3 días seguidos (los últimos 3 completos) con gasto y sin ventas.
//  C. ROAS sostenido abajo de 2,5: el de 30 días y el de 7 días (si gastó en la semana) por debajo.
// Si el anuncio tuvo clics en los últimos 7 días, la pausa es PROVISORIA: una venta de esos clics
// puede atribuirse más tarde. Siguen valiendo las excepciones (regla 8) y las reactivaciones 5 y 6.
// Devuelve { accion: 'pausar' | 'mantener' | 'observar' | 'no_aplica' | 'protegido' | 'revisar', motivo,
//   regla, provisoria, roas30, roas7, ... }
const roas = (monto, gasto) => { const m = num(monto), g = num(gasto); return m !== null && g ? r2(m / g) : null; };
export function evaluarAnuncio(a) {
  const gasto = num(a.gasto) ?? 0, clics = num(a.clics) ?? 0;
  const cpc = costoPorClic({ cpc: a.cpc, gasto, clics });
  const precio = precioParaTope({ precio: a.precio, precioLista: a.precioLista ?? a.precioTope });
  const roas30 = roas(a.monto, gasto), roas7 = roas(a.monto7, a.gasto7);
  const provisoria = (num(a.clics7) ?? 0) > 0;
  const base = { tope: null, topeClics: REGLAS.clicsSinVenta, cpc, precio, clicCaro: false, roas30, roas7, provisoria };
  const res = (accion, motivo, regla = null) => ({ ...base, accion, regla, motivo: accion === 'pausar' && provisoria ? `${motivo} PROVISORIA: tuvo clics en los últimos 7 días.` : motivo });

  if (a.estado !== 'ACTIVE') return res('no_aplica', `Estado ${a.estado ?? 'desconocido'}: no se poda.`);
  if (a.protegido) return res('protegido', a.protegido);
  const ventas = Math.max(num(a.ventasAtribuidas) ?? 0, num(a.ventasOrdenes) ?? 0);
  const pausar = (motivo, regla) => a.revisar ? res('revisar', a.revisar) : res('pausar', motivo, regla);
  if (ventas === 0 && clics >= REGLAS.clicsSinVenta) return pausar(`${clics} clics sin venta en 30 días (regla A: 15 o más).`, 'A');
  const d = Array.isArray(a.dias3) ? a.dias3 : null;
  if (d && d.length === REGLAS.diasSeguidos && d.every(x => (num(x?.gasto) ?? 0) > 0 && !((num(x?.ventas) ?? 0) > 0))) return pausar(`${REGLAS.diasSeguidos} días seguidos con gasto y sin ventas (regla B).`, 'B');
  if (ventas > 0 && roas30 !== null && roas30 < REGLAS.roasMinimo && (roas7 === null || roas7 < REGLAS.roasMinimo)) return pausar(`ROAS ${roas30} en 30 días${roas7 !== null ? ` y ${roas7} en 7` : ''}, abajo de ${REGLAS.roasMinimo} (regla C).`, 'C');
  if (ventas > 0) return res('mantener', `Tuvo venta; ROAS ${roas30 ?? 'sin dato'} en 30 días.`);
  if (clics >= REGLAS.clicsObservacion) return res('observar', `${clics} clics sin venta (se pausa en ${REGLAS.clicsSinVenta}).`);
  return res('mantener', `Menos de ${REGLAS.clicsObservacion} clics sin venta.`);
}

// Reglas 5 y 6 para un anuncio pausado por la poda.
//   registro: { precio_lista, promo } al pausar
//   ahora: { ventasAtribuidas, ventasOrdenesDesdePausa, precioLista, promo }
export const fuePorVentaCara = registro => /^Venta cara/i.test(String(registro?.motivo ?? ''));

export function evaluarReactivacion(registro, ahora) {
  if (!fuePorVentaCara(registro) && (num(ahora.ventasAtribuidas) ?? 0) > 0) return { accion: 'reactivar', regla: 5, motivo: 'Venta atribuida tarde (regla 5).' };
  if ((num(ahora.ventasOrdenesDesdePausa) ?? 0) > 0) return { accion: 'reactivar', regla: 5, motivo: 'Venta en órdenes después de la pausa (regla 5).' };
  const antes = num(registro?.precio_lista), hoy = num(ahora.precioLista);
  if (antes !== null && hoy !== null && antes - hoy >= 1) return { accion: 'reactivar', regla: 6, motivo: `Bajó el precio de ${antes} a ${hoy} (regla 6): el gasto se cuenta de cero.` };
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
