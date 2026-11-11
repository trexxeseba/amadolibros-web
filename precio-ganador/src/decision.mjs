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
export function decidir({ item, comp, promo = false, previo, piso = null, tocarStock = false, stockDemanda = STOCK_DEMANDA_DEFAULT, umbral = UMBRAL_UYU, topePct = TOPE_PCT, umbralInclusivo = false, descuento = 0, pasoMinimoSubida = 1, seguir = false, confirmarSubida = 2, fraccionSubida = 0.5, memoriaDias = 3, ahora = Date.now(), ganarCompartida = false }) {
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

  const reglas = { umbral, topePct, umbralInclusivo, descuento, pasoMinimoSubida, confirmarSubida, fraccionSubida, memoriaDias, ahora, ganarCompartida };
  const r = previo ? decidirConEstado({ precio, comp, previo, piso, seguir, ...reglas }) : decidirNueva({ precio, comp, piso, ...reglas });
  if (!CAMBIA.has(r.accion)) return r;
  // Precio administrado por Mercado Libre (tag dynamic_standard_price): el PUT a
  // /items/{id} responde 400. El 06/11/2026 falló así MLU660973661 en Libros. No se intenta.
  if (item.precio_dinamico) return { accion: 'saltear_precio_dinamico', motivo: 'precio administrado por Mercado Libre (dynamic_standard_price)' };
  if (promo === true) return { accion: 'saltear_promo', motivo: 'promoción activa' };
  if (promo === null) return { accion: 'saltear_promo_desconocida', motivo: 'no se pudo confirmar si tiene promoción' };

  // Stock de las a demanda: al bajar, stock fijo; al restaurar, el original.
  if (tocarStock && item.demanda) {
    if (r.accion === 'bajar' && Number(item.available_quantity) !== stockDemanda) r.stock = stockDemanda;
    if (r.accion === 'restaurar' && fin(previo?.stock_original) && Number(previo.stock_original) !== Number(item.available_quantity)) r.stock = Number(previo.stock_original);
  }
  return r;
}

// Comparte el primer lugar (Seba, 11/11/2026: "quiero ganar siempre, 1 %"): bajar 1 % para
// ganar sola. Una sola vez cada `memoriaDias`: si el otro iguala, no se persigue (no hay
// guerra de precios hacia abajo). Respeta umbral, tope y piso como cualquier baja.
export const PCT_COMPARTIDA = 0.01;
const compartida = comp => !comp?.marcada && !comp?.bloqueo && comp?.estado === 'sharing_first_place';

function decidirNueva({ precio, comp, piso, umbral, topePct, umbralInclusivo, descuento, ganarCompartida, ahora }) {
  if (ganarCompartida && compartida(comp)) {
    const objetivo = entero(precio * (1 - PCT_COMPARTIDA));
    if (fin(piso) && objetivo < piso) return { accion: 'saltear_piso', precio: objetivo, motivo: `piso ${piso}` };
    if (objetivo >= precio || objetivo <= 0) return { accion: 'sin_marcar', motivo: 'comparte (1 % no cambia el precio)' };
    return { accion: 'bajar', precio: objetivo, motivo: 'comparte el primer lugar: 1 % para ganar sola', memoria: { compartida_fecha: new Date(ahora).toISOString() } };
  }
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

// Subida con memoria (Seba, 07/11/2026: los precios iban y venían en cada corrida).
// ML no elige sólo por precio: subir hasta un peso abajo del competidor volvía a
// perder en la corrida siguiente. Ahora, para una publicación que el sistema bajó:
//   - sube sólo después de ganar `confirmarSubida` corridas seguidas;
//   - sube una fracción (`fraccionSubida`) de lo que falta hasta el techo, no todo;
//   - si después de subir vuelve a perder, recuerda ese precio (`perdio_en`) durante
//     `memoriaDias` días y no vuelve a subir hasta ahí.
// Así el precio se acerca de a poco al máximo con el que todavía gana y se queda ahí.
// La memoria viaja en el estado: { ganando, perdio_en, perdio_fecha }.
function decidirConEstado({ precio, comp, previo, piso, seguir = false, umbral, topePct, umbralInclusivo, descuento, pasoMinimoSubida, confirmarSubida, fraccionSubida, memoriaDias, ahora, ganarCompartida }) {
  const original = Number(previo.precio_original);
  const fecha = new Date(ahora).toISOString();
  // Marcada contra un ganador a demanda (o sin filtro de plazo): seguirlo.
  if (comp?.marcada && !comp?.bloqueo && fin(comp.ganador)) {
    const ganador = entero(comp.ganador), diferencia = original - ganador;
    const objetivo = Math.min(objetivoDe(ganador, descuento), original);
    // Perdió con el precio actual: se recuerda para no volver a subir hasta acá.
    const memoria = objetivo < precio ? { ganando: 0, perdio_en: precio, perdio_fecha: fecha } : { ganando: 0 };
    const con = r => ({ ...r, memoria });
    // seguir: excepción por publicación (precio-ganador/seguir/<cuenta>.json, pedida por Seba): sigue al
    // ganador aunque quede a más del umbral del original. El tope de porcentaje y el piso siguen.
    if ((!seguir && (umbralInclusivo ? diferencia > umbral : diferencia >= umbral)) || (topePct !== null && diferencia / original > topePct)) return con({ accion: 'mantener_umbral', motivo: `ganador ${ganador}, original ${original}` });
    if (fin(piso) && objetivo < piso) return con({ accion: 'mantener_piso', motivo: `piso ${piso}` });
    if (objetivo === precio) return con({ accion: 'mantener', motivo: 'sigue al ganador' });
    if (objetivo >= original) return con({ accion: 'restaurar', precio: original, motivo: 'el ganador llegó al original' });
    return con({ accion: 'ajustar', precio: objetivo, motivo: objetivo > precio ? 'el ganador subió' : 'el ganador bajó' });
  }
  // Ya no marcada (gana, o el ganador es de entrega inmediata, contra el que no se compite):
  // subir hacia el original sin pasarlo, hasta donde siga ganándole al competidor
  // a demanda más barato (techo, ya con el descuento aplicado), con la subida con memoria.
  // Comparte el primer lugar: 1 % para ganar sola, una vez cada memoriaDias (no se persigue al otro).
  if (ganarCompartida && compartida(comp)) {
    const reciente = previo.compartida_fecha && ahora - Date.parse(previo.compartida_fecha) < memoriaDias * 86400_000;
    if (reciente) return { accion: 'mantener', motivo: 'comparte; ya bajó 1 % hace menos de 3 días', memoria: { ganando: 0 } };
    const objetivo = entero(precio * (1 - PCT_COMPARTIDA)), dif = original - objetivo;
    const memoria = { ganando: 0, compartida_fecha: fecha };
    if ((umbralInclusivo ? dif > umbral : dif >= umbral) || (topePct !== null && dif / original > topePct)) return { accion: 'mantener_umbral', motivo: `comparte; 1 % pasaría el tope contra el original ${original}`, memoria: { ganando: 0 } };
    if (fin(piso) && objetivo < piso) return { accion: 'mantener_piso', motivo: `piso ${piso}`, memoria: { ganando: 0 } };
    if (objetivo < precio) return { accion: 'ajustar', precio: objetivo, motivo: 'comparte el primer lugar: 1 % para ganar sola', memoria };
  }
  const ganando = Number(previo.ganando ?? 0) + 1;
  const memoriaVigente = fin(previo.perdio_en) && ahora - Date.parse(previo.perdio_fecha ?? '') < memoriaDias * 86400_000;
  let techo = Math.min(original, fin(comp?.techo) ? entero(comp.techo) : original);
  if (memoriaVigente) techo = Math.min(techo, entero(previo.perdio_en) - pasoMinimoSubida);
  const motivo = comp?.bloqueo ? `ganador de entrega inmediata, no se compite` : null;
  const queda = r => ({ ...r, memoria: { ganando } });
  if (techo <= precio) return queda({ accion: 'mantener', motivo: motivo ?? (memoriaVigente && techo < Math.min(original, fin(comp?.techo) ? entero(comp.techo) : original) ? `perdió en ${previo.perdio_en}, no sube hasta ahí` : 'gana con el precio aplicado') });
  if (ganando < confirmarSubida) return queda({ accion: 'mantener', motivo: `gana ${ganando} de ${confirmarSubida} corridas antes de subir` });
  // Una fracción de lo que falta; si lo que falta es poco, todo.
  const falta = techo - precio;
  const paso = falta <= 2 * pasoMinimoSubida ? falta : Math.max(pasoMinimoSubida, entero(falta * fraccionSubida));
  const objetivo = precio + paso;
  if (paso < pasoMinimoSubida) return queda({ accion: 'mantener', motivo: `subiría ${paso}, menos de ${pasoMinimoSubida}` });
  // Después de subir vuelve a contar desde cero: la próxima subida espera otra confirmación.
  const sube = r => ({ ...r, memoria: { ganando: 0 } });
  if (objetivo >= original) return sube({ accion: 'restaurar', precio: original, motivo: motivo ?? 'sin competidor más barato' });
  return sube({ accion: 'subir', precio: objetivo, motivo: motivo ?? `sube ${paso} de ${falta} hacia ${techo}${comp?.techo_de ? ` (competidor en ${comp.techo_de})` : ''}` });
}
