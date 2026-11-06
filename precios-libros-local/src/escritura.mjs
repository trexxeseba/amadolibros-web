// Escritura segura de un precio. Sólo la llama run.mjs en modo real.
//
//   1. Relee todo y recalcula justo antes (decidir()). Si la decisión o el objetivo
//      cambiaron, no escribe.
//   2. PUT /items/{id} { price }.
//      - timeout / transporte / 429 / 5xx: primero consulta el precio; si ya quedó, no
//        repite; si no, espera creciente y vuelve al paso 1 (máximo `intentos`).
//      - 409: relee y recalcula (vuelve al paso 1), nunca repite a ciegas.
//      - otro 4xx: rechazo, no se reintenta.
//   3. Verifica el precio efectivo después (item.price y sale_price).
import { ESCRIBE } from './regla.mjs';
import { itemFresco, precioEfectivo } from './lectura.mjs';

const TRANSITORIO = e => e?.code === 'timeout' || e?.code === 'transporte' || e?.status === 429 || (e?.status >= 500);

export async function escribirPrecio(ml, itemId, objetivoPrevisto, decidir, { intentos = 3, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  let ultimoError = null;
  for (let intento = 1; intento <= intentos; intento++) {
    const d = await decidir();
    if (!ESCRIBE.has(d.accion) || d.objetivo !== objetivoPrevisto) return { resultado: 'cancelada_recalculo', decision: d };
    try {
      await ml.put(`/items/${itemId}`, { price: d.objetivo });
      return await verificar(ml, itemId, d.objetivo, d);
    } catch (e) {
      if (e?.fatal) throw e;
      ultimoError = e;
      if (e?.status === 409) { await sleep(1000 * intento); continue; }
      if (!TRANSITORIO(e)) return { resultado: 'rechazada', error: e?.code ?? 'error', detalle: e?.detalle ?? null, decision: d };
      // No se sabe si quedó: consultar antes de repetir.
      const it = await itemFresco(ml, itemId);
      if (it && it.price === d.objetivo) return await verificar(ml, itemId, d.objetivo, d);
      await sleep(2000 * 2 ** intento);
    }
  }
  return { resultado: 'fallida', error: ultimoError?.code ?? 'error' };
}

async function verificar(ml, itemId, objetivo, decision) {
  const [it, sale] = await Promise.all([itemFresco(ml, itemId), precioEfectivo(ml, itemId)]);
  const precio = it?.price ?? null, efectivo = sale?.precio ?? null;
  if (precio === objetivo && (efectivo === null || efectivo === objetivo)) return { resultado: 'aplicada', precio, efectivo, decision };
  // ML aceptó y no aplicó, o aplicó otra cosa (automatización, promo nueva): grave.
  return { resultado: 'precio_inesperado', precio, efectivo, decision };
}
