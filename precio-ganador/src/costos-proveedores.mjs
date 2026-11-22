// Costos de proveedores que no están en la lista de SBS (Arnoia; Celesa cuando esté).
//
// Las listas con el costo por libro se bajan con la sesión de Seba en el portal del
// proveedor y se guardan en el repo PRIVADO (rama estado/precio-ganador, carpeta costos/):
// el costo de compra no va al repo público. Formato de costos/arnoia.json:
//   { fuente, fecha, cotizacion: { eur_uyu, fuente }, flete_usd_kg, iva_en_costo,
//     libros: { "<ean>": { costo_eur, iva, pvp_eur, descuento, disponible, peso_g, ... } } }
// costo_eur es el precio de distribución que da el portal (sin IVA, con el descuento
// de cada libro). Igual que la lista de Arnoia de la semana 45, el costo se toma con IVA
// (iva_en_costo: true): si no lo cobran, el error es a favor nuestro.
//
// Sólo lectura: lo usa el cotizador (acciones cotizar y cotizar_todas), nunca el que
// escribe precios.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { quoteMercadoLibre } from '../../worker-sync/publication-policy.js';

export const FLETE_ESPANA_USD_KG = 16;   // el mismo de la lista de Arnoia de la semana 45
export const PESO_POR_DEFECTO_G = 450;   // el de las publicaciones normales de Arnoia
export const MAX_DIAS_COSTOS = 30;       // con una lista más vieja no se cotiza

export function leerCostos(dir, proveedor) {
  const archivo = dir ? join(dir, `${proveedor}.json`) : null;
  if (!archivo || !existsSync(archivo)) return null;
  const d = JSON.parse(readFileSync(archivo, 'utf8'));
  if (!d?.libros || !(Number(d?.cotizacion?.eur_uyu) > 0)) throw Object.assign(new Error(`costos_${proveedor}_invalidos`), { fatal: true });
  return d;
}

// Puro: el costo del libro puesto en Uruguay y los precios, con la misma fórmula del
// publicador (quoteMercadoLibre): el libro ya viene en pesos uruguayos y el flete es el
// de España.
export function cotizarDesdeCostos(lista, ean, politica, ahora = Date.now()) {
  const l = lista?.libros?.[ean];
  if (!l || !(Number(l.costo_eur) > 0)) return null;
  const dias = (ahora - Date.parse(lista.fecha)) / 86400e3;
  if (!Number.isFinite(dias) || dias > MAX_DIAS_COSTOS) return null;
  const conIva = lista.iva_en_costo === false ? 1 : 1 + (Number(l.iva) || 0) / 100;
  const libroUyu = Number(l.costo_eur) * conIva * Number(lista.cotizacion.eur_uyu);
  const pesoKg = (Number(l.peso_g) > 0 ? Number(l.peso_g) : PESO_POR_DEFECTO_G) / 1000;
  const pol = { ...politica, supplierDiscount: 0, arsPerUyu: 1, freightUsdKg: Number(lista.flete_usd_kg) || FLETE_ESPANA_USD_KG };
  const fila = { listArs: libroUyu, weightKg: pesoKg };
  const completo = quoteMercadoLibre({ ...fila }, pol);
  const piso = quoteMercadoLibre({ ...fila, competitor: { price: 1, at: ahora, days: pol.availabilityDays ?? null } }, pol);
  return { completo, piso_18: Number(piso?.competitive?.floor), disponible: l.disponible !== false };
}

export const eanDeSku = (sku, prefijo) => new RegExp(`^${prefijo}-(\\d{10,13})$`).exec(String(sku ?? ''))?.[1] ?? null;

// Publicaciones de Arnoia en catálogo: el publicador las guarda en la rama hermes-datos
// (publicadas-vintage.json, clave "arnoia:<ean>" con item_id). Su SKU es HERMES-<producto> y
// muchas no tienen GTIN propio, así que el EAN sale de acá. Devuelve Map(item_id -> ean).
export function arnoiaPorPublicacion(dir) {
  const archivo = dir ? join(dir, 'publicadas-vintage.json') : null;
  const out = new Map();
  if (!archivo || !existsSync(archivo)) return out;
  try {
    for (const v of Object.values(JSON.parse(readFileSync(archivo, 'utf8')) ?? {}))
      if (v?.fuente === 'arnoia' && v.item_id && /^\d{10,13}$/.test(String(v.ean ?? ''))) out.set(String(v.item_id), String(v.ean));
  } catch { /* sin mapa */ }
  return out;
}
