// Decisión por publicación. Función pura: no llama a la API ni escribe.
//
// Entrada:
//   item       { id, seller_id, site_id, currency_id, status, variaciones, precio_administrado }
//   lectura    { precio, promo, automatizacion, comp }
//              precio: precio efectivo actual (sale_price) o null
//              promo: 'ninguna' | 'activa' | 'programada' | null (desconocida)
//              automatizacion: 'ninguna' | 'activa' | null (desconocida)
//              comp: { estado: 'ok'|'error', tipo: 'catalogo'|'sin_catalogo', C, fuente,
//                      competidor, comparable: true|false|null, motivoComparable, sinExternos, ptwStatus }
//   gestion    fila del estado si el motor ya la bajó (precio_base, ultimo_aplicado,
//              sin_competencia_consecutivas) o null
//   piso       número o null
//   regla      REGLA de config.mjs
// Salida: { accion, objetivo?, motivo, calc }
import { SELLER_ID, SITE_ID, MONEDA, REGLA } from '../config.mjs';

export const ESCRIBE = new Set(['bajar', 'recuperar', 'recuperar_base']);
export const objetivo99 = (c, factor = 0.99) => Math.floor(Number(c) * factor + 1e-9);
const fin = v => v !== null && v !== undefined && Number.isFinite(Number(v));

export function evaluar({ item, lectura, gestion = null, piso = null, regla = REGLA }) {
  const r = (accion, motivo, extra = {}) => ({ accion, motivo, ...extra, calc: { ...calc, ...(extra.calc ?? {}) } });
  const calc = { P: lectura?.precio ?? null, C: lectura?.comp?.C ?? null, base: gestion?.precio_base ?? null, piso };

  if (!item) return r('omitir_dato_ausente', 'no se pudo leer la publicación');
  if (String(item.seller_id) !== SELLER_ID) return r('omitir_seller', `seller ${item.seller_id}`);
  if (item.site_id && item.site_id !== SITE_ID) return r('omitir_sitio', item.site_id);
  if (item.currency_id !== MONEDA) return r('omitir_moneda', item.currency_id);
  if (item.status !== 'active') return r('omitir_no_activa', item.status);
  if (item.variaciones) return r('omitir_variaciones', 'precio por variación');
  if (item.precio_administrado) return r('omitir_precio_administrado', 'precio administrado por Mercado Libre');
  if (lectura.automatizacion === 'activa') return r('omitir_automatizacion', 'automatización de precios activa');
  if (lectura.automatizacion !== 'ninguna') return r('omitir_automatizacion_desconocida', 'no se pudo confirmar la automatización');
  if (lectura.promo === 'activa' || lectura.promo === 'programada') return r('omitir_promocion', `promoción ${lectura.promo}`);
  if (lectura.promo !== 'ninguna') return r('omitir_promo_desconocida', 'no se pudo confirmar si tiene promoción');
  if (!fin(lectura.precio)) return r('omitir_dato_ausente', 'sin precio efectivo');
  const P = Number(lectura.precio);
  if (gestion && Number(gestion.ultimo_aplicado) !== P) return r('detener_cambio_externo', `precio actual ${P}, último aplicado ${gestion.ultimo_aplicado}`);

  const comp = lectura.comp;
  if (!comp || comp.estado !== 'ok') return r(gestion ? 'mantener_dato_incierto' : 'omitir_dato_ausente', `competencia: ${comp?.error ?? 'sin respuesta'}`);
  if (comp.tipo !== 'catalogo') return r('revision_sin_comparable', 'sin catálogo: no hay competidor comparable confirmado');
  if (comp.comparable === false) return r('revision_comparabilidad', comp.motivoComparable ?? 'no comparable');
  if (comp.comparable !== true) return r('revision_comparabilidad', comp.motivoComparable ?? 'comparabilidad sin confirmar');

  return gestion ? gestionada({ P, comp, gestion, piso, regla, r }) : nueva({ P, comp, piso, regla, r });
}

function nueva({ P, comp, piso, regla, r }) {
  if (comp.sinExternos || !fin(comp.C)) return r('sin_competencia', 'no hay otro vendedor en la ficha');
  if (!regla.incluirGanando && comp.ptwStatus === 'winning') return r('omitir_ya_gana', 'gana la ficha');
  return baja({ P, C: Number(comp.C), base: P, piso, regla, r });
}

// Baja con la regla del 1 %, comparando contra el precio actual y con el límite
// acumulado contra el precio base aprobado.
function baja({ P, C, base, piso, regla, r }) {
  const D = P - C;
  const calc = { P, C, D, base };
  if (D <= 0) return r('sin_accion_d_no_positiva', `diferencia ${D}`, { calc });
  if (D >= regla.umbralUyu) return r('no_tocar_umbral', `diferencia ${D} >= ${regla.umbralUyu}`, { calc });
  const objetivo = objetivo99(C, regla.factor);
  const descuentoCorrida = P - objetivo;
  const descAcumUyu = base - objetivo, descAcumPct = descAcumUyu / base;
  const c2 = { ...calc, objetivo, descuentoCorrida, supera400: descuentoCorrida > regla.umbralUyu, descAcumUyu, descAcumPct };
  if (!fin(piso)) return r('omitir_sin_piso', 'sin piso rentable confiable', { objetivo, calc: c2 });
  if (objetivo < piso) return r('omitir_bajo_piso', `objetivo ${objetivo} < piso ${piso}`, { objetivo, calc: c2 });
  if (descAcumPct > regla.limiteAcumPct || descAcumUyu > regla.limiteAcumUyu) return r('omitir_limite_acumulado', `acumulado ${descAcumUyu} (${(descAcumPct * 100).toFixed(1)} %) sobre base ${base}`, { objetivo, calc: c2 });
  if (objetivo >= P) return r('mantener', 'el objetivo no es menor al precio actual', { calc: c2 });
  return r('bajar', `diferencia ${D}${c2.supera400 ? `; descuento total ${descuentoCorrida} supera ${regla.umbralUyu} por el 1 %` : ''}`, { objetivo, calc: c2 });
}

function gestionada({ P, comp, gestion, piso, regla, r }) {
  const base = Number(gestion.precio_base);
  const propuesta = a => (regla.recuperacionHabilitada ? a : 'propuesta_' + a);
  // Desaparición de la competencia: sólo con lecturas correctas, confirmada en varias corridas.
  if (comp.sinExternos) {
    const vistas = Number(gestion.sin_competencia_consecutivas ?? 0) + 1;
    if (vistas < regla.confirmacionesDesaparicion) return r('mantener_confirmando_desaparicion', `sin competencia ${vistas}/${regla.confirmacionesDesaparicion}`, { sinCompetencia: vistas });
    if (P >= base) return r('mantener', 'ya está en el precio base', { sinCompetencia: vistas });
    return r(propuesta('recuperar_base'), 'competencia desaparecida (confirmada)', { objetivo: base, sinCompetencia: vistas });
  }
  if (!fin(comp.C)) return r('mantener_dato_incierto', 'competidor sin precio');
  const C = Number(comp.C), obj = objetivo99(C, regla.factor);
  if (obj > P) {
    const objetivo = Math.min(base, obj);
    if (objetivo - P < regla.pasoMinimoSubida) return r('mantener', `subiría ${objetivo - P}, menos de ${regla.pasoMinimoSubida}`, { calc: { C } });
    if (fin(piso) && objetivo < piso) return r('mantener_bajo_piso', `recuperación ${objetivo} < piso ${piso}`, { calc: { C } });
    return r(propuesta(objetivo >= base ? 'recuperar_base' : 'recuperar'), `el competidor subió a ${C}`, { objetivo, calc: { C, D: P - C } });
  }
  return baja({ P, C, base, piso, regla, r });
}
