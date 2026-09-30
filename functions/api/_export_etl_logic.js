// Lógica pura del export para Encontrá tu Libro. Sin red, sin secretos, sin
// reloj propio: todo lo que decide se prueba sin levantar nada.
//
// Reglas que vienen de la decisión de Seba y que conviene no perder de vista:
//
//  - NO se reusa `isEligibleForFeed`. Ese filtro sirve a Google Merchant y
//    exige cosas que acá no corresponden, como el permalink de Mercado Libre.
//    Un libro vendible sin portada validada y sin ISBN tiene que entrar.
//  - NO se deduplica por ISBN. Dos publicaciones con el mismo ISBN pueden ser
//    ofertas distintas en condición, edición o formato. Entra cada una con su
//    id.
//  - NO se asume la condición. Si Mercado Libre no la informa, va
//    `desconocida`; el feed de Merchant asume `used` y eso acá sería inventar.
//  - NO se publican cantidades exactas. La disponibilidad es una etiqueta.
//  - NO se inventa un ISBN. Si no hay uno válido, va `null`.

import { TRANSFER_FACTOR } from './_orders_logic.js';
import { isBookProduct } from '../feed.xml.js';
import { isGenericAuthor, normalizeValidIsbn } from '../_shared/showcase-ranking.js';
import { slugify } from '../_shared/slug.js';
import { BASE } from '../_shared/catalog.js';

// Lista explícita de campos. Lo que no esté acá no sale, venga de donde venga.
export const CAMPOS_EXPORTADOS = Object.freeze([
  'id', 'titulo', 'autor', 'isbn13', 'precio_tarjeta_uyu',
  'precio_transferencia_uyu', 'condicion', 'disponibilidad', 'url_ficha',
]);

// Motivos de exclusión, en el orden en que se evalúan. Se cuentan uno por
// ítem —el primero que aplica— para que los números sumen el universo.
export const MOTIVOS_EXCLUSION = Object.freeze([
  'id_invalido', 'no_activo', 'sin_stock', 'sin_precio', 'moneda_no_uyu', 'no_es_libro',
]);

function limpiar(valor) {
  return String(valor ?? '').replace(/\s+/g, ' ').trim();
}

// Primer motivo que descalifica, o null si el ítem entra. El orden importa
// sólo para el conteo; el resultado de incluir o no es el mismo.
export function motivoDeExclusion(item) {
  if (!item || !/^MLU\d+$/.test(String(item.id || ''))) return 'id_invalido';
  if (item.status !== 'active') return 'no_activo';
  if (!(Number(item.available_quantity) > 0)) return 'sin_stock';
  if (!(Number(item.price) > 0)) return 'sin_precio';
  const moneda = limpiar(item.currency || item.currency_id).toUpperCase();
  // No se infiere la moneda: un precio sin moneda declarada es ambiguo y
  // publicarlo como UYU sería suponer.
  if (moneda !== 'UYU') return 'moneda_no_uyu';
  // Único filtro discutible de la lista: deja fuera antigüedades, mazos y
  // juegos. Se cuenta aparte justamente para poder revisar cuánto saca.
  if (!isBookProduct(item)) return 'no_es_libro';
  return null;
}

// Misma regla y mismo redondeo que la ficha y que el checkout: se importa la
// constante en vez de repetir el 0,88, que ya está copiado en cuatro archivos.
export function precioTransferencia(precioTarjeta) {
  const precio = Number(precioTarjeta);
  if (!(precio > 0)) return null;
  return Math.round(precio * TRANSFER_FACTOR);
}

// 'new' y 'used' son los valores que informa Mercado Libre. Cualquier otra
// cosa, incluida la ausencia, es 'desconocida'.
export function condicionDe(item) {
  const cruda = limpiar(item?.condition).toLowerCase();
  if (cruda === 'new') return 'nuevo';
  if (cruda === 'used') return 'usado';
  return 'desconocida';
}

// Un autor genérico ("Varios", el nombre de la editorial) es un hueco con
// forma de dato: se informa como ausente.
export function autorDe(item) {
  const autor = limpiar(item?.author);
  if (!autor || isGenericAuthor(item?.author)) return null;
  return autor;
}

// La ficha propia, nunca el permalink de Mercado Libre.
export function urlFichaDe(item) {
  return `${BASE}/libro/${encodeURIComponent(String(item.id))}/${slugify(String(item.title || ''))}`;
}

export function aRegistroExportado(item) {
  const precioTarjeta = Math.round(Number(item.price));
  return {
    id: String(item.id),
    titulo: limpiar(item.title) || null,
    autor: autorDe(item),
    isbn13: normalizeValidIsbn(item?.isbn) || null,
    precio_tarjeta_uyu: precioTarjeta,
    precio_transferencia_uyu: precioTransferencia(precioTarjeta),
    condicion: condicionDe(item),
    // Etiqueta, no número: la cantidad exacta es información interna.
    disponibilidad: 'en_stock',
    url_ficha: urlFichaDe(item),
  };
}

export function construirExport(catalogo) {
  const items = Array.isArray(catalogo?.items) ? catalogo.items : [];
  const excluidos = Object.fromEntries(MOTIVOS_EXCLUSION.map(motivo => [motivo, 0]));
  const libros = [];

  for (const item of items) {
    const motivo = motivoDeExclusion(item);
    if (motivo) { excluidos[motivo] += 1; continue; }
    libros.push(aRegistroExportado(item));
  }

  // La fecha tiene que ser la del catálogo, no la de la descarga. Si la
  // fuente no la trae, se dice que no se pudo determinar en vez de poner
  // `new Date()` y hacer pasar la hora de la consulta por fecha del dato.
  const fuenteActualizada = limpiar(catalogo?.updated_at) || null;

  return {
    esquema: 1,
    // Es una foto COMPLETA del universo elegible: lo que no está acá ya no se
    // vende, y el receptor tiene que retirarlo de su índice.
    tipo: 'foto_completa',
    fuente_actualizada: fuenteActualizada,
    fuente_actualizada_nota: fuenteActualizada
      ? null
      : 'El catálogo de origen no informó updated_at; no se pudo determinar la fecha del dato.',
    alcance: 'libros activos con stock inmediato; sin agotados ni publicaciones por encargo',
    totales: {
      en_catalogo: items.length,
      incluidos: libros.length,
      excluidos: Object.values(excluidos).reduce((a, b) => a + b, 0),
      excluidos_por_motivo: excluidos,
    },
    libros,
  };
}
