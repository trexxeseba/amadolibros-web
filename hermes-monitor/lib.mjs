// Lógica pura del chequeo de Hermes (sin red), para poder probarla.
export const HERMES_SELLER_ID = 471589392; // HERMES_PROMOSML (verificado el 18/11/2026)
export const UMBRAL_CAMBIO_PRECIO = 0.05;

// De la lista de ofertas de una ficha, la de Hermes (o null si ya no ofrece).
export function ofertaDeHermes(ofertas, sellerId = HERMES_SELLER_ID) {
  return (ofertas ?? []).find(o => Number(o?.seller_id) === Number(sellerId)) ?? null;
}

// Estado de una ficha: 'ofrece', 'sin_oferta' o 'error' (no se pudo leer: nunca se actúa sobre un error).
export function estadoFicha(lectura) {
  if (!lectura || lectura.error) return 'error';
  return lectura.oferta ? 'ofrece' : 'sin_oferta';
}

// Última fila anterior de cada ficha, desde el historial.
export function ultimosPorFicha(historial) {
  const m = new Map();
  for (const h of historial ?? []) m.set(h.producto, h);
  return m;
}

export function cambioDePrecio(anterior, actual, umbral = UMBRAL_CAMBIO_PRECIO) {
  if (!(anterior > 0) || !(actual > 0)) return null;
  const pct = (actual - anterior) / anterior;
  return Math.abs(pct) > umbral ? pct : null;
}

// Frena si parece una falla general (muchas fichas "sin oferta" de golpe): no se pausa nada.
export function fallaGeneral(estados, {minimo = 20, proporcion = 0.5} = {}) {
  const n = estados.length;
  const sin = estados.filter(e => e === 'sin_oferta' || e === 'error').length;
  return n >= minimo && sin / n > proporcion;
}

export const hoyUy = (now = Date.now()) => new Date(now - 3 * 3600e3).toISOString().slice(0, 10);

export function armarResumen({fecha, real, filas, pausadas, cambios, falla}) {
  const sin = filas.filter(f => f.estado === 'sin_oferta');
  const err = filas.filter(f => f.estado === 'error');
  const L = [];
  L.push(`Chequeo de Hermes del ${fecha}: ${filas.length} fichas revisadas, ${sin.length} sin oferta de Hermes, ${cambios.length} con cambio de precio de más del 5 %.`);
  L.push(real ? 'Modo real: las publicaciones asignadas se pausan solas.' : 'Modo de prueba: no se pausó nada.');
  if (falla) L.push('AVISO: muchas fichas figuran sin oferta de golpe. Parece una falla de lectura y no se pausó nada.');
  L.push('', `Fichas que quedaron sin stock o pausadas del lado de Hermes (${sin.length}):`);
  for (const f of sin.slice(0, 60)) L.push(`- ${f.n}. ${f.titulo} (${f.producto})${f.mi_mlu ? ` - mi publicación ${f.mi_mlu}` : ' - sin publicación mía asignada'}`);
  if (sin.length > 60) L.push(`... y ${sin.length - 60} más en el historial.`);
  L.push('', `Publicaciones mías pausadas hoy (${pausadas.length}):`);
  for (const p of pausadas) L.push(`- ${p.mi_mlu} (ficha ${p.n}, ${p.resultado})`);
  L.push('', `Cambios de precio de Hermes de más del 5 % (${cambios.length}):`);
  for (const c of cambios) L.push(`- ${c.n}. ${c.titulo}: de $${c.antes} a $${c.ahora} (${c.pct > 0 ? '+' : ''}${(c.pct * 100).toFixed(1)} %)`);
  if (err.length) L.push('', `No se pudieron leer ${err.length} fichas (no se tocó nada con ellas).`);
  L.push('', 'Nota: Mercado Libre no deja leer el stock de publicaciones ajenas; "sin stock" se detecta porque Hermes deja de ofrecer la ficha.');
  return L.join('\n');
}

// Precio de la publicación mía: 1 % menos que Hermes (decisión de Seba, 18/11/2026), en pesos enteros.
export const DESCUENTO_SOBRE_HERMES = 0.01;
export const precioMio = (precioHermes, descuento = DESCUENTO_SOBRE_HERMES) => Math.round(Number(precioHermes) * (1 - descuento));

// Publicación de catálogo directa, 1 unidad. El envío lo decide Mercado Libre al validar (variantes A, B, C).
export function armarPayload({producto, precio, categoria, nombre, familyName, usaFamilyName, isbn}) {
  const p = {
    site_id: 'MLU', category_id: categoria, price: precio, currency_id: 'UYU', available_quantity: 1,
    buying_mode: 'buy_it_now', listing_type_id: 'gold_special', condition: 'new',
    catalog_listing: true, catalog_product_id: producto, seller_custom_field: `HERMES-${producto}`,
  };
  if (usaFamilyName) p.family_name = String(familyName || nombre).slice(0, 60).trim(); else p.title = String(nombre).slice(0, 60).trim();
  if (isbn) p.attributes = [{id: 'GTIN', value_name: isbn}];
  return p;
}
