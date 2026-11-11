// Guardas de las escrituras en Mercado Libre. Módulo puro: sin red, sin reloj
// implícito, sin secretos. Toda escritura de los jobs pasa por acá antes de salir.
// Si una guarda falla no se ejecuta; las violaciones de un límite dejan una fila
// Alerta en Airtable (filaAlerta). Las exclusiones normales (stock 1 o 2, libro
// médico, ítem nuevo...) no son alertas: se cuentan en el informe.
//
// Reglas de Seba (consigna del 09/11/2026):
//   - Descuento a cargo nuestro de 15 % o menos. Precio visible (sale_price) nunca
//     más de 16 % debajo del regular; después de cada escritura se relee y, si pasa
//     de 16 %, se saca el ítem.
//   - Promo + cupón: no más de $750 por libro.
//   - Nunca subir precios. Nunca "Amado Liquidacion 40/30/20". Nunca crear "Amado Week".
//   - Fuera de promo: stock 1 o 2, libros médicos, ítems con menos de 90 días,
//     ítems que ganan o no tienen competencia, y la lista manual de exclusión.
//   - LIGHTNING es irreversible: doble chequeo de precio y stock antes del POST y
//     stock de 3 o más después de reservar.
//   - DELETE siempre con promotion_type. Product Ads: ninguna escritura, nunca.
//   - Interruptor general: deja todo en solo lectura.
//
// Decisiones de Seba del 11/11/2026 (fila direccion|decisiones-seba-2026-11-11):
//   - Publicidad: tope de $20.000 por mes calendario (antes $30.000). Code sólo lo
//     lee y avisa; los ajustes de Ads los hace el agente único por navegador.
//   - Se mantiene la regla de cero escritura en Ads por API.
//   - Un pedido expreso de Seba sobre un título puede saltar las exclusiones de
//     selección (competencia, antigüedad, lista manual), nunca los límites ni los
//     bloqueos, y tampoco el stock mínimo ni los libros médicos (pedidoSeba).
//
// Supuestos tomados de las recomendaciones del 10/11/2026, a confirmar por Seba:
//   (1) Un ítem sin dato de competencia porque no es de catálogo (price_to_win
//       responde not_listed) entra como candidato. Una lectura que falla no se estima.
//   (2) Relámpago compartido (SMART_LIGHTNING): solo si lo que pone el vendedor es
//       15 % o menos; el visible total (con el aporte de ML) sigue limitado a 16 %.
//   (3) Cupón para el tope de $750: el monto real más alto entre los cupones vigentes
//       de la API; si no se pudo leer, la fila cupones|hecho más reciente de Airtable;
//       si tampoco hay, $500.

export const LIMITES = Object.freeze({
  descuentoMaxPct: 15,
  visibleMaxPct: 16,
  promoMasCuponMaxUyu: 750,
  cuponPorDefectoUyu: 500,
  stockMinimoParaPromo: 3,
  diasMinimosDesdeAlta: 90,
  stockMinimoTrasReservar: 3,
  adsMensualMaxUyu: 20000,
  adsAlertaPct: 80,
});

const DIA_MS = 86400000;
const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);
const redondear2 = v => Math.round(v * 100) / 100;
export const normalizar = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

// ── Modo de escritura ───────────────────────────────────────────────────────
// 'solo_lectura': interruptor general; no se escribe en Mercado Libre aunque lo demás
//                 diga real (los informes a Airtable siguen).
// 'prueba' (dry_run, el default): no toca Mercado Libre; Airtable lleva "[PRUEBA]".
// 'real': solo con AGENTES_ML_MODO=real, sin interruptor y sin dry_run.
export function modoDeEscritura(env = {}) {
  if (String(env.AGENTES_ML_SOLO_LECTURA ?? '').toLowerCase() === 'true') return 'solo_lectura';
  if (String(env.AGENTES_ML_DRY_RUN ?? '').toLowerCase() === 'true') return 'prueba';
  return String(env.AGENTES_ML_MODO ?? '').toLowerCase() === 'real' ? 'real' : 'prueba';
}

// ── Descuentos ──────────────────────────────────────────────────────────────
// Porcentaje de descuento de un precio resultante sobre el regular.
export function descuentoPct(regular, precio) {
  const r = num(regular), p = num(precio);
  if (r === null || p === null || r <= 0 || p < 0) return null;
  return redondear2((1 - p / r) * 100);
}

// Cupón vigente para el tope de promo + cupón. Devuelve { monto, fuente }.
export function cuponVigente({ cuponesApi = null, filaAirtable = null, porDefecto = LIMITES.cuponPorDefectoUyu } = {}) {
  if (Array.isArray(cuponesApi)) {
    const montos = cuponesApi.filter(c => c && ['started', 'active'].includes(String(c.status ?? '').toLowerCase())).map(c => num(c.fixed_amount ?? c.amount)).filter(v => v !== null && v >= 0);
    if (montos.length) return { monto: Math.max(...montos), fuente: 'api' };
    // Una lista vacía y legible es un dato: no hay cupones vigentes.
    if (cuponesApi.every(c => !c || !['started', 'active'].includes(String(c.status ?? '').toLowerCase()))) return { monto: 0, fuente: 'api_sin_cupones' };
  }
  const delFila = num(filaAirtable?.monto_max);
  if (delFila !== null && delFila >= 0) return { monto: delFila, fuente: 'airtable' };
  return { monto: porDefecto, fuente: 'por_defecto' };
}

// ── Exclusiones de promoción ────────────────────────────────────────────────
export function esLibroMedico(titulo, config = {}) {
  const t = normalizar(titulo);
  return (config.palabras_medicas ?? []).map(normalizar).filter(Boolean).find(p => t.includes(p)) ?? null;
}

// price_to_win: 'gana' | 'sin_competencia' | 'compite' | 'sin_catalogo' | 'no_leido'
// not_listed / item_not_opted_in = el ítem no compite en catálogo: es un dato válido (supuesto 1).
export function clasificarCompetencia(ptw) {
  if (ptw === null || ptw === undefined || ptw.error || (ptw.http && ptw.http >= 400)) return 'no_leido';
  const estado = String(ptw.status ?? '').toLowerCase();
  if (estado === 'winning' || estado === 'sharing_first_place') return 'gana';
  if (estado === 'not_listed' || (Array.isArray(ptw.reason) && ptw.reason.includes('item_not_opted_in'))) return 'sin_catalogo';
  if (estado === 'competing') return 'compite';
  if (estado === 'listed') return 'sin_competencia';
  return 'no_leido';
}

// Razones por las que un ítem NO entra a promoción. Vacío = candidato.
export function exclusiones(item, { ahora = new Date(), config = {}, competencia = null } = {}) {
  const razones = [];
  const stock = num(item?.available_quantity);
  if (stock === null) razones.push({ guarda: 'stock_no_leido', tipo: 'bloqueo', motivo: 'No se pudo leer el stock.' });
  else if (stock < LIMITES.stockMinimoParaPromo) razones.push({ guarda: 'stock_bajo', tipo: 'exclusion', motivo: `Stock ${stock}: con menos de ${LIMITES.stockMinimoParaPromo} no participa.` });
  const medica = esLibroMedico(item?.title, config);
  if (medica) razones.push({ guarda: 'libro_medico', tipo: 'exclusion', motivo: `Libro médico (coincide con "${medica}").` });
  const alta = Date.parse(item?.date_created);
  if (!Number.isFinite(alta)) razones.push({ guarda: 'alta_no_leida', tipo: 'bloqueo', motivo: 'No se pudo leer la fecha de alta.' });
  else if ((ahora.getTime() - alta) / DIA_MS < LIMITES.diasMinimosDesdeAlta) razones.push({ guarda: 'item_nuevo', tipo: 'exclusion', motivo: `Menos de ${LIMITES.diasMinimosDesdeAlta} días desde el alta.` });
  if ((config.items ?? []).map(String).includes(String(item?.id))) razones.push({ guarda: 'lista_manual', tipo: 'exclusion', motivo: 'Está en la lista de exclusión manual.' });
  const comp = clasificarCompetencia(competencia);
  if (comp === 'no_leido') razones.push({ guarda: 'competencia_no_leida', tipo: 'bloqueo', motivo: 'No se pudo leer price_to_win; no se estima.' });
  else if (comp === 'gana') razones.push({ guarda: 'gana_el_catalogo', tipo: 'exclusion', motivo: 'Ya gana o comparte el primer lugar: no necesita descuento.' });
  else if (comp === 'sin_competencia') razones.push({ guarda: 'sin_competencia', tipo: 'exclusion', motivo: 'No tiene competencia.' });
  return razones;
}

// ── Nombres prohibidos ──────────────────────────────────────────────────────
const LIQUIDACION_PROHIBIDA = /amado\s*liquidacion\s*(40|30|20)\b/;
export const esPromoProhibida = nombre => LIQUIDACION_PROHIBIDA.test(normalizar(nombre));
export const esNombreAmadoWeek = nombre => /amado\s*week/.test(normalizar(nombre));

// ── Evaluación de una escritura ─────────────────────────────────────────────
// accion: 'unirse_promo' | 'crear_campana' | 'sacar_de_promo' | 'lightning' | 'ads'
// ctx: { modo, item, venta:{amount,regular_amount}, promo:{id,type,name,price,original_price,seller_percentage},
//        cupon:{monto}, competencia, ahora, config, request:{method,path,query} }
// Devuelve { permitido, fallas:[{guarda,tipo,motivo,detalle}], alerta:boolean }.
export function evaluarEscritura(accion, ctx = {}) {
  const fallas = [];
  const falla = (guarda, tipo, motivo, detalle = {}) => fallas.push({ guarda, tipo, motivo, detalle });
  const modo = ctx.modo ?? 'prueba';
  const nombre = ctx.promo?.name ?? ctx.nombre ?? '';

  // Product Ads: ninguna escritura, nunca (ni por acción ni por ruta).
  if (accion === 'ads' || /\/advertising\b/i.test(String(ctx.request?.path ?? '')) && String(ctx.request?.method ?? 'GET').toUpperCase() !== 'GET') {
    falla('ads_solo_lectura', 'limite', 'Product Ads: ninguna escritura, nunca.');
    return resultado(fallas);
  }
  if (modo === 'solo_lectura') falla('interruptor_solo_lectura', 'bloqueo', 'El interruptor general deja todo en solo lectura.');
  else if (modo !== 'real') falla('modo_prueba', 'bloqueo', 'Modo prueba: se registra lo que se haría, no se toca Mercado Libre.');

  if (esPromoProhibida(nombre)) falla('promo_prohibida', 'limite', 'Las promos "Amado Liquidacion 40/30/20" no se usan.', { nombre });
  if (esNombreAmadoWeek(nombre)) falla('amado_week', 'limite', 'Nunca se crea ni se usa nada llamado "Amado Week".', { nombre });

  if (accion === 'sacar_de_promo') {
    // Salir de una promo solo baja el descuento. DELETE sin promotion_type borra todas las ofertas del ítem.
    const tipo = String(ctx.promo?.type ?? ctx.request?.query?.promotion_type ?? '').trim();
    if (!tipo) falla('delete_sin_tipo', 'limite', 'DELETE sin promotion_type borraría todas las ofertas del ítem.');
    if (!String(ctx.item?.id ?? '').trim()) falla('delete_sin_item', 'limite', 'Falta el ítem.');
    return resultado(fallas);
  }

  if (accion === 'crear_campana') {
    // La campaña la crea el vendedor: tope de descuento y nombre; no hay ítem todavía.
    const pct = num(ctx.promo?.discount_pct);
    if (pct === null) falla('descuento_no_leido', 'bloqueo', 'La campaña no informa su descuento.');
    else if (pct > LIMITES.descuentoMaxPct) falla('descuento_alto', 'limite', `Descuento ${pct}% mayor al máximo de ${LIMITES.descuentoMaxPct}%.`, { pct });
    return resultado(fallas);
  }

  // unirse_promo | lightning: hay un ítem y un precio resultante.
  for (const r of exclusiones(ctx.item, { ahora: ctx.ahora ?? new Date(), config: ctx.config, competencia: ctx.competencia })) fallas.push({ ...r, detalle: {} });

  const regular = num(ctx.venta?.regular_amount) ?? num(ctx.venta?.amount);
  const visibleHoy = num(ctx.venta?.amount);
  const precio = num(ctx.promo?.price);
  if (regular === null || visibleHoy === null) falla('precio_no_leido', 'bloqueo', 'No se pudo leer sale_price; no se estima.');
  if (precio === null || precio <= 0) falla('precio_promo_no_leido', 'bloqueo', 'La promoción no informa un precio resultante.');
  if (regular !== null && visibleHoy !== null && precio !== null && precio > 0) {
    if (precio > visibleHoy) falla('subiria_el_precio', 'limite', 'La promoción dejaría el ítem más caro que hoy: nunca se suben precios.', { visibleHoy, precio });
    const visiblePct = descuentoPct(regular, precio);
    if (visiblePct > LIMITES.visibleMaxPct) falla('visible_alto', 'limite', `Precio visible ${visiblePct}% bajo el regular: el máximo es ${LIMITES.visibleMaxPct}%.`, { visiblePct });
    // Lo que pone el vendedor: seller_percentage si la promo lo informa (aporte de ML aparte); si no, el total.
    const propio = num(ctx.promo?.seller_percentage) ?? visiblePct;
    if (propio > LIMITES.descuentoMaxPct) falla('descuento_alto', 'limite', `Descuento a cargo nuestro ${propio}% mayor al máximo de ${LIMITES.descuentoMaxPct}%.`, { propio });
    const cupon = num(ctx.cupon?.monto);
    if (cupon === null) falla('cupon_no_leido', 'bloqueo', 'No se conoce el cupón vigente.');
    else if (redondear2(regular - precio) + cupon > LIMITES.promoMasCuponMaxUyu) falla('promo_mas_cupon', 'limite', `Promo + cupón superan $${LIMITES.promoMasCuponMaxUyu} por libro.`, { promo: redondear2(regular - precio), cupon });
  }
  if (accion === 'lightning') for (const f of evaluarLightning(ctx.lightning)) fallas.push(f);
  return resultado(fallas);
}

const resultado = fallas => ({
  permitido: fallas.length === 0,
  fallas,
  // Alerta solo cuando se tocó un límite o falta un dato: lo normal (modo prueba, exclusiones) no alerta.
  alerta: fallas.some(f => f.tipo === 'limite' || f.tipo === 'bloqueo' && !['modo_prueba', 'interruptor_solo_lectura'].includes(f.guarda)),
});

// ── LIGHTNING: irreversible ─────────────────────────────────────────────────
// ctx.lightning = { lectura1:{precio,stock}, lectura2:{precio,stock}, reservar }
// Dos lecturas independientes tienen que coincidir y quedar stock de 3 o más después de reservar.
export function evaluarLightning(l) {
  const f = [];
  const falla = (guarda, motivo, detalle = {}) => f.push({ guarda, tipo: 'limite', motivo, detalle });
  const a = l?.lectura1, b = l?.lectura2, reservar = num(l?.reservar);
  if (!a || !b) { falla('lightning_sin_doble_chequeo', 'La relámpago es irreversible: hacen falta dos lecturas de precio y stock.'); return f; }
  const [p1, p2, s1, s2] = [num(a.precio), num(b.precio), num(a.stock), num(b.stock)];
  if ([p1, p2, s1, s2].some(v => v === null)) { falla('lightning_lectura_incompleta', 'Una de las dos lecturas no trae precio o stock.'); return f; }
  if (p1 !== p2 || s1 !== s2) falla('lightning_lecturas_distintas', 'Las dos lecturas no coinciden: se descarta, no se reserva stock a ciegas.', { p1, p2, s1, s2 });
  if (reservar === null || reservar < 1) falla('lightning_reserva_invalida', 'No se informa cuánto stock reservar.');
  else if (Math.min(s1, s2) - reservar < LIMITES.stockMinimoTrasReservar) falla('lightning_stock_insuficiente', `Después de reservar ${reservar} tiene que quedar stock de ${LIMITES.stockMinimoTrasReservar} o más.`, { stock: Math.min(s1, s2), reservar });
  return f;
}

// ── Pedido expreso de Seba sobre un título ──────────────────────────────────
// Las exclusiones de selección (competencia, antigüedad, lista manual) no aplican a
// un título que Seba pidió por su nombre. Los límites y los bloqueos siguen; el stock
// mínimo y los libros médicos también (son reglas de no quedarse sin stock y de
// catálogo, no de selección).
const EXCLUSIONES_FIRMES = new Set(['stock_bajo', 'libro_medico']);
export function aplicarPedidoSeba(r) {
  const fallas = r.fallas.filter(f => f.tipo !== 'exclusion' || EXCLUSIONES_FIRMES.has(f.guarda));
  const saltadas = r.fallas.filter(f => !fallas.includes(f)).map(f => f.guarda);
  return { ...resultado(fallas), saltadas };
}

// ── Publicidad: gasto del mes contra el tope ────────────────────────────────
// Sólo lectura. Devuelve el estado frente al tope mensual: 'dentro', 'alerta' (desde
// el 80 %) o 'superado'. Un gasto que no se pudo leer es 'no_leido', nunca 'dentro'.
export function evaluarGastoAds(gastoMes, tope = LIMITES.adsMensualMaxUyu) {
  const gasto = num(gastoMes), max = num(tope);
  if (gasto === null || max === null || max <= 0 || gasto < 0) return { estado: 'no_leido', pct: null, tope: max };
  const pct = redondear2(100 * gasto / max);
  const estado = gasto > max ? 'superado' : pct >= LIMITES.adsAlertaPct ? 'alerta' : 'dentro';
  return { estado, pct, tope: max, restante: Math.max(0, redondear2(max - gasto)) };
}

// ── Después de cada escritura ───────────────────────────────────────────────
// Se relee sale_price: si el visible quedó más de 16 % bajo el regular, se saca el ítem.
export function verificarPostEscritura(venta) {
  const regular = num(venta?.regular_amount), amount = num(venta?.amount);
  if (amount === null) return { ok: false, accion: 'sacar', motivo: 'No se pudo releer sale_price: se saca por seguridad.', visiblePct: null };
  if (regular === null) return { ok: true, accion: 'ninguna', visiblePct: 0 };
  const visiblePct = descuentoPct(regular, amount);
  return visiblePct > LIMITES.visibleMaxPct
    ? { ok: false, accion: 'sacar', motivo: `Visible ${visiblePct}% bajo el regular: pasa de ${LIMITES.visibleMaxPct}%.`, visiblePct }
    : { ok: true, accion: 'ninguna', visiblePct };
}

// ── Fila de Airtable ────────────────────────────────────────────────────────
// Upsert por Clave: correr dos veces el mismo día no duplica. En modo prueba el título lleva "[PRUEBA]".
export function filaAlerta({ fecha, modo = 'prueba', accion, item, promo, resultado: r }) {
  const guardas = r.fallas.filter(f => f.tipo !== 'exclusion').map(f => f.guarda).sort();
  const id = String(item?.id ?? 'sin-item');
  const prefijo = modo === 'real' ? '' : '[PRUEBA] ';
  return {
    Clave: `promos|alerta|${guardas.join('+') || 'guarda'}|${id}|${fecha}`,
    Propuesta: `${prefijo}Promos ${fecha}: guarda frenó ${accion} en ${id}`,
    Fecha: fecha, Rama: 'Promos y cupones', Tarea: 'Promociones en la nube', Tipo: 'Alerta',
    Prioridad: r.fallas.some(f => f.tipo === 'limite') ? 'Alta' : 'Media',
    Publicacion: id,
    Dato: r.fallas.map(f => `${f.guarda}: ${f.motivo}`).join('\n'),
    'Opcion recomendada': 'No se ejecutó. Revisar la publicación o la regla antes de reintentar.',
    Estado: 'Nueva',
  };
}
