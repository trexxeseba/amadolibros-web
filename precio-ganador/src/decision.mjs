// Decisión por publicación. Función pura: no llama a la API, no escribe nada.
//
// Entrada:
//   item   { id, price, currency_id, variaciones, demanda, available_quantity }
//   comp   { marcada, ganador, techo, error }   (ver competencia.mjs)
//   promo  true | false | null (null = no se pudo saber)
//   previo entrada del estado si el sistema ya la bajó antes, o undefined
//   piso   número o null
// Salida: { accion, precio?, stock?, motivo }
//   Acciones que cambian algo: 'bajar', 'ajustar', 'subir', 'restaurar'.
import { UMBRAL_UYU, STOCK_DEMANDA_DEFAULT, TOPE_PCT } from './config.mjs';

export const CAMBIA = new Set(['bajar', 'ajustar', 'subir', 'restaurar']);

// ML de Uruguay publica en pesos enteros. Se redondea hacia abajo: redondear
// hacia arriba dejaría el precio por encima del que gana.
const fin = v => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
export const entero = n => Math.floor(Number(n) + 1e-9);

// umbralInclusivo: la diferencia igual al umbral también se baja (Vintage: <= 400).
// descuento: fracción por debajo del ganador (Vintage 0.01 = 99 % del ganador).
export function decidir({ item, comp, promo = false, previo, piso = null, tocarStock = false, stockDemanda = STOCK_DEMANDA_DEFAULT, umbral = UMBRAL_UYU, topePct = TOPE_PCT, umbralInclusivo = false, descuento = 0, pasoMinimoSubida = 1 }) {
  const precio = Number(item.price);
  if (comp?.error) return { accion: 'error_consulta', motivo: comp.error };
  if (item.currency_id !== 'UYU') return { accion: 'saltear_moneda', motivo: item.currency_id };
  if (item.variaciones) return { accion: 'saltear_variaciones', motivo: 'precio por variación' };

  // Promoción visible en la publicación (original_price): no se toca, y si la
  // habíamos bajado no se libera (el precio que se ve es el de la promo).
  if (item.original_price !== null && item.original_price !== undefined) {
    return previo ? { accion: 'mantener_promo', motivo: 'promoción en curso' } : (comp?.marcada ? { accion: 'saltear_promo', motivo: 'promoción en curso' } : { accion: 'sin_marcar', motivo: comp?.estado ?? '' });
  }
  // Ya la bajamos antes, pero alguien le cambió el precio a mano: queda fuera del sistema.
  if (previo && Number(previo.precio_aplicado) !== precio) return { accion: 'liberar_editada', motivo: `precio actual ${precio}, aplicado ${previo.precio_aplicado}` };

  const reglas = { umbral, topePct, umbralInclusivo, descuento, pasoMinimoSubida };
  const r = previo ? decidirConEstado({ precio, comp, previo, piso, ...reglas }) : decidirNueva({ precio, comp, piso, ...reglas });
  if (!CAMBIA.has(r.accion)) return r;
  if (promo === true) return { accion: 'saltear_promo', motivo: 'promoción activa' };
  if (promo === null) return { accion: 'saltear_promo_desconocida', motivo: 'no se pudo confirmar si tiene promoción' };

  // Stock de las a demanda: al bajar, stock fijo; al restaurar, el original.
  if (tocarStock && item.demanda) {
    if (r.accion === 'bajar' && Number(item.available_quantity) !== stockDemanda) r.stock = stockDemanda;
    if (r.accion === 'restaurar' && fin(previo?.stock_original) && Number(previo.stock_original) !== Number(item.available_quantity)) r.stock = Number(previo.stock_original);
  }
  return r;
}

function decidirNueva({ precio, comp, piso, umbral, topePct, umbralInclusivo, descuento }) {
  // Ganador de entrega inmediata, o sin dato de plazo: no se compite por precio.
  if (comp?.bloqueo) return { accion: 'saltear_' + comp.bloqueo, motivo: comp.motivo_bloqueo ?? MOTIVO_BLOQUEO[comp.bloqueo] ?? comp.bloqueo };
  if (!comp?.marcada) return { accion: 'sin_marcar', motivo: comp?.estado ?? 'gana o comparte' };
  if (!fin(comp.ganador)) return { accion: 'saltear_sin_precio', motivo: 'marcada sin precio ganador' };
  const ganador = entero(comp.ganador), diferencia = precio - ganador;
  if (ganador >= precio) return { accion: 'sin_marcar', motivo: 'el ganador no es más barato' };
  if (umbralInclusivo ? diferencia > umbral : diferencia >= umbral) return { accion: 'sin_tocar_umbral', precio: ganador, motivo: `diferencia ${diferencia}` };
  if (topePct !== null && diferencia / precio > topePct) return { accion: 'sin_tocar_pct', precio: ganador, motivo: `baja ${Math.round(diferencia / precio * 100)} %` };
  const objetivo = objetivoDe(ganador, descuento);
  if (fin(piso) && objetivo < piso) return { accion: 'saltear_piso', precio: objetivo, motivo: `piso ${piso}` };
  if (objetivo <= 0) return { accion: 'saltear_sin_precio', motivo: 'precio ganador inválido' };
  return { accion: 'bajar', precio: objetivo, motivo: `diferencia ${diferencia}` };
}

const MOTIVO_BLOQUEO = { ganador_inmediato: 'el ganador entrega de inmediato', ganador_sin_dato: 'sin dato del plazo del ganador' };

// Precio objetivo: el ganador menos el descuento, hacia abajo al peso.
export const objetivoDe = (ganador, descuento = 0) => entero(ganador * (1 - (descuento || 0)));

function decidirConEstado({ precio, comp, previo, piso, umbral, topePct, umbralInclusivo, descuento, pasoMinimoSubida }) {
  const original = Number(previo.precio_original);
  // Marcada contra un ganador a demanda (o sin filtro de plazo): seguirlo.
  if (comp?.marcada && !comp?.bloqueo && fin(comp.ganador)) {
    const ganador = entero(comp.ganador), diferencia = original - ganador;
    const objetivo = Math.min(objetivoDe(ganador, descuento), original);
    // Más que el umbral contra el precio original: no se sigue bajando, se mantiene lo aplicado.
    if ((umbralInclusivo ? diferencia > umbral : diferencia >= umbral) || (topePct !== null && diferencia / original > topePct)) return { accion: 'mantener_umbral', motivo: `ganador ${ganador}, original ${original}` };
    if (fin(piso) && objetivo < piso) return { accion: 'mantener_piso', motivo: `piso ${piso}` };
    if (objetivo === precio) return { accion: 'mantener', motivo: 'sigue al ganador' };
    if (objetivo >= original) return { accion: 'restaurar', precio: original, motivo: 'el ganador llegó al original' };
    return { accion: 'ajustar', precio: objetivo, motivo: objetivo > precio ? 'el ganador subió' : 'el ganador bajó' };
  }
  // Ya no marcada (o el ganador es de entrega inmediata, contra el que no se compite):
  // subir hacia el original sin pasarlo, hasta donde siga ganándole al competidor
  // a demanda más barato (techo, ya con el descuento aplicado).
  const techo = fin(comp?.techo) ? entero(comp.techo) : original;
  const objetivo = Math.min(original, techo);
  const motivo = comp?.bloqueo ? `ganador de entrega inmediata, no se compite` : null;
  if (objetivo <= precio) return { accion: 'mantener', motivo: motivo ?? 'gana con el precio aplicado' };
  if (objetivo >= original) return { accion: 'restaurar', precio: original, motivo: motivo ?? 'sin competidor más barato' };
  if (objetivo - precio < pasoMinimoSubida) return { accion: 'mantener', motivo: `subiría ${objetivo - precio}, menos de ${pasoMinimoSubida}` };
  return { accion: 'subir', precio: objetivo, motivo: motivo ?? `competidor a demanda más barato en ${comp?.techo_de ?? '?'}` };
}
