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

export function decidir({ item, comp, promo = false, previo, piso = null, tocarStock = false, stockDemanda = STOCK_DEMANDA_DEFAULT, umbral = UMBRAL_UYU, topePct = TOPE_PCT }) {
  const precio = Number(item.price);
  if (comp?.error) return { accion: 'error_consulta', motivo: comp.error };
  if (item.currency_id !== 'UYU') return { accion: 'saltear_moneda', motivo: item.currency_id };
  if (item.variaciones) return { accion: 'saltear_variaciones', motivo: 'precio por variación' };

  // Ya la bajamos antes, pero alguien le cambió el precio a mano: queda fuera del sistema.
  if (previo && Number(previo.precio_aplicado) !== precio) return { accion: 'liberar_editada', motivo: `precio actual ${precio}, aplicado ${previo.precio_aplicado}` };

  const r = previo ? decidirConEstado({ precio, comp, previo, piso, umbral, topePct }) : decidirNueva({ precio, comp, piso, umbral, topePct });
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

function decidirNueva({ precio, comp, piso, umbral, topePct }) {
  if (!comp?.marcada) return { accion: 'sin_marcar', motivo: comp?.estado ?? 'gana o comparte' };
  if (!fin(comp.ganador)) return { accion: 'saltear_sin_precio', motivo: 'marcada sin precio ganador' };
  const objetivo = entero(comp.ganador);
  if (objetivo >= precio) return { accion: 'sin_marcar', motivo: 'el ganador no es más barato' };
  if (precio - objetivo >= umbral) return { accion: 'sin_tocar_umbral', precio: objetivo, motivo: `diferencia ${precio - objetivo}` };
  if ((precio - objetivo) / precio > topePct) return { accion: 'sin_tocar_pct', precio: objetivo, motivo: `baja ${Math.round((precio - objetivo) / precio * 100)} %` };
  if (fin(piso) && objetivo < piso) return { accion: 'saltear_piso', precio: objetivo, motivo: `piso ${piso}` };
  if (objetivo <= 0) return { accion: 'saltear_sin_precio', motivo: 'precio ganador inválido' };
  return { accion: 'bajar', precio: objetivo, motivo: `diferencia ${precio - objetivo}` };
}

function decidirConEstado({ precio, comp, previo, piso, umbral, topePct }) {
  const original = Number(previo.precio_original);
  if (comp?.marcada && fin(comp.ganador)) {
    const objetivo = Math.min(entero(comp.ganador), original);
    // Más de 360 contra el precio original: no se sigue bajando, se mantiene lo aplicado.
    if (original - objetivo >= umbral || (original - objetivo) / original > topePct) return { accion: 'mantener_umbral', motivo: `ganador ${objetivo}, original ${original}` };
    if (fin(piso) && objetivo < piso) return { accion: 'mantener_piso', motivo: `piso ${piso}` };
    if (objetivo === precio) return { accion: 'mantener', motivo: 'sigue al ganador' };
    if (objetivo >= original) return { accion: 'restaurar', precio: original, motivo: 'el ganador llegó al original' };
    return { accion: 'ajustar', precio: objetivo, motivo: objetivo > precio ? 'el ganador subió' : 'el ganador bajó' };
  }
  // Ya no está marcada: subir hacia el original sin pasarlo, hasta donde siga ganando.
  const techo = fin(comp?.techo) ? entero(comp.techo) : original;
  const objetivo = Math.min(original, techo);
  if (objetivo <= precio) return { accion: 'mantener', motivo: 'gana con el precio aplicado' };
  if (objetivo >= original) return { accion: 'restaurar', precio: original, motivo: 'sin competidor más barato' };
  return { accion: 'subir', precio: objetivo, motivo: `competidor más barato en ${techo + 1}` };
}
