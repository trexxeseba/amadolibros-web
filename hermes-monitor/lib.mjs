// Lógica pura del chequeo de Hermes (sin red), para poder probarla.
export const HERMES_SELLER_ID = 471589392; // HERMES_PROMOSML (verificado el 18/11/2026)
export const UMBRAL_CAMBIO_PRECIO = 0.05;
// GLIC (tienda oficial; trae los libros de Amazon.com). Seba, 20/11/2026: republicar sus mismos libros a 3 % menos, calculado sobre el
// PRECIO DE LISTA (el de antes del descuento: GLIC tenía descuentos de hasta 24 %), con un mínimo de $1.200.
export const GLIC_SELLER_ID = 345281879;
export const DESCUENTO_SOBRE_GLIC = 0.03;
export const PRECIO_MINIMO = 1200;
export function precioDesdeLista(oferta, descuento = DESCUENTO_SOBRE_GLIC) {
  const actual = Number(oferta?.price), lista = Number(oferta?.original_price);
  const base = Number.isFinite(lista) && lista > actual ? lista : actual;
  return Number.isFinite(base) && base > 0 ? Math.round(base * (1 - descuento)) : null;
}

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
export function armarPayload({producto, precio, categoria, nombre, familyName, usaFamilyName, isbn, plazoDias}) {
  const p = {
    site_id: 'MLU', category_id: categoria, price: precio, currency_id: 'UYU', available_quantity: 1,
    buying_mode: 'buy_it_now', listing_type_id: 'gold_special', condition: 'new',
    catalog_listing: true, catalog_product_id: producto, seller_custom_field: `HERMES-${producto}`,
  };
  if (usaFamilyName) p.family_name = String(familyName || nombre).slice(0, 60).trim(); else p.title = String(nombre).slice(0, 60).trim();
  if (isbn) p.attributes = [{id: 'GTIN', value_name: isbn}];
  if (plazoDias) p.sale_terms = [{id: 'MANUFACTURING_TIME', value_name: `${plazoDias} días`}]; // disponibilidad "a demanda"
  return p;
}

// Hermes va SIEMPRE a Amado Vintage (Seba, 18/11/2026). Amado Libros no se toca: un test lo exige.
export const CUENTA_HERMES = 'vintage';
// Techo diario TOTAL de altas en Vintage (Seba, 21/11/2026: 4.000 por día; antes 3.500, 3.000 y 2.500). Reparto: SBS 1.000 (campaign.json), Arnoia hasta 1.700
// (70 por hora las 24 horas) y Hermes hasta 300; la suma nunca pasa de 4.000.
export const TOPE_DIARIO_COMPARTIDO = 4000;
// SBS tiene prioridad (Seba, 22/11/2026): sube hasta 2.000 por día (campaign.json) y esa parte queda RESERVADA: Arnoia y GLIC solo pueden usar lo que
// sobra del techo después de la reserva de SBS, así nunca le quitan lugar.
export const SBS_RESERVA_DIARIA = 2000;
export const cupoParaOtros = (sbsHoy, otrosHoy) => Math.max(0, TOPE_DIARIO_COMPARTIDO - Math.max(Number(sbsHoy) || 0, SBS_RESERVA_DIARIA) - (Number(otrosHoy) || 0));
export const POR_CORRIDA = 25;
export const inicioDiaUy = (now = Date.now()) => { const d = new Date(now - 3 * 3600e3); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + 3 * 3600e3; };

// ---- Publicación tradicional (sin ficha de catálogo): para los libros de Arnoia que Mercado Libre aún no tiene ----
const ARTICULOS = 'LA|EL|LOS|LAS|UN|UNA|L\'|LES|LO';
export const titulo1 = t => t.toLowerCase().replace(/(^|[\s(\-:¿¡"])([a-záéíóúñü])/g, (m, a, b) => a + b.toUpperCase());
// "HORA ANTES DEL ALBA, LA (PREMIO PLANETA 2026)" -> "La Hora Antes Del Alba"
export function normalizarTitulo(t) {
  let x = String(t ?? '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  const m = x.match(new RegExp(`^(.*),\\s*(${ARTICULOS})$`, 'i'));
  if (m) x = `${m[2]} ${m[1]}`;
  return titulo1(x).replace(/\s+/g, ' ');
}
// "ALLENDE, ISABEL" -> "Isabel Allende"
export function normalizarAutor(a) {
  const x = String(a ?? '').trim(); if (!x) return '';
  const p = x.split(',').map(s => s.trim());
  return titulo1(p.length === 2 ? `${p[1]} ${p[0]}` : x);
}
export function armarPayloadTradicional({ean, titulo, autor, editorial, precio, plazoDias, usaFamilyName, imagenes, pesoGramos = 450, idioma = 'Español'}) {
  const t = normalizarTitulo(titulo), a = normalizarAutor(autor);
  const nombre = (a && `${t} - ${a}`.length <= 60) ? `${t} - ${a}` : t;
  const p = {
    site_id: 'MLU', category_id: 'MLU1196', price: precio, currency_id: 'UYU', available_quantity: 1,
    buying_mode: 'buy_it_now', listing_type_id: 'gold_special', condition: 'new', catalog_listing: false,
    seller_custom_field: `ARNOIA-${ean}`,
    pictures: imagenes.map(i => (typeof i === 'string' ? {source: i} : i)), // una URL o {id} de una foto ya subida
    attributes: [
      {id: 'GTIN', value_name: ean}, {id: 'BOOK_TITLE', value_name: t},
      ...(a ? [{id: 'AUTHOR', value_name: a}] : []),
      ...(editorial ? [{id: 'BOOK_PUBLISHER', value_name: titulo1(editorial)}] : []),
      {id: 'LANGUAGE', value_name: idioma},
      ...paqueteDeVendedor(pesoGramos),
    ],
  };
  if (plazoDias) p.sale_terms = [{id: 'MANUFACTURING_TIME', value_name: `${plazoDias} días`}];
  if (usaFamilyName) p.family_name = nombre.slice(0, 60); else p.title = nombre.slice(0, 60);
  return p;
}

// ---- Precio de los libros de Celesa (Seba, 22/11/2026: "estimale un descuento promedio de 15 % y una ganancia de 25 % sobre el precio del libro") ----
// Hasta tener el costo real de Celesa se estima: costo del libro = precio en euros menos 15 %, al euro de venta del BROU; flete de USD 15 por kilo (Seba, 22/11/2026; peso estimado,
// el archivo no lo trae) con 100 g de embalaje; envío local de $230; ganancia de 25 % sobre el libro con un piso de $500 (la regla de Seba para Arnoia);
// la comisión de Mercado Libre (17 %) se calcula sobre el precio final; mínimo $1.200 y redondeo a 10.
export const CELESA = {descuento: 0.15, ganancia: 0.25, gananciaMinima: 500, eurUyu: 46.99, usdUyu: 41.8, fleteUsdKg: 15, embalajeG: 100, envioLocal: 230, comision: 0.17, minimo: 1200};
export const pesoEstimadoCelesa = eur => eur < 12 ? 300 : eur < 20 ? 450 : eur < 30 ? 650 : 900;
export function precioCelesa(eur, pesoG, c = CELESA) {
  const libro = Number(eur) * (1 - c.descuento) * c.eurUyu;
  const peso = Number(pesoG) > 0 ? Number(pesoG) : pesoEstimadoCelesa(Number(eur));
  const flete = (peso + c.embalajeG) / 1000 * c.fleteUsdKg * c.usdUyu;
  const ganancia = Math.max(libro * c.ganancia, c.gananciaMinima);
  const precio = (libro + flete + c.envioLocal + ganancia) / (1 - c.comision);
  return Math.max(c.minimo, Math.round(precio / 10) * 10);
}

// Medidas y peso del paquete que exige Mercado Libre (misma regla que el publicador de la cola: bandas por peso).
const PACKAGE_BANDS = [[.4, 25, 18, 4], [.8, 30, 22, 6], [1.5, 35, 25, 10], [Infinity, 40, 30, 15]];
export function paqueteDeVendedor(pesoLibroGramos) {
  const kg = (Number(pesoLibroGramos) + 100) / 1000; // + embalaje
  const [, largo, ancho, alto] = PACKAGE_BANDS.find(([max]) => kg <= max);
  const gramos = Math.ceil((Math.round(kg * 1000) + 150) / 100) * 100;
  return [{id: 'SELLER_PACKAGE_HEIGHT', value_name: `${alto} cm`}, {id: 'SELLER_PACKAGE_LENGTH', value_name: `${largo} cm`}, {id: 'SELLER_PACKAGE_WIDTH', value_name: `${ancho} cm`}, {id: 'SELLER_PACKAGE_WEIGHT', value_name: `${gramos} g`}];
}

// ---- Control de tapas antes de publicar (decisión de Seba, 19/11/2026) ----
// Mercado Libre pausa las fotos con datos de contacto, direcciones web, redes sociales o etiquetas propias. Un lector de texto (OCR)
// mira cada tapa antes de usarla; si encuentra algo de esto, el libro se salta como publicación normal.
export function textoNoPermitido(texto) {
  const t = String(texto ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (/@\s?[a-z0-9_.]{3,}/.test(t)) return 'arroba_o_correo'; // una @ suelta suele ser ruido de la ilustración
  if (/\bwww\b|https?|\bwww\.|\.(com|net|org|es|uy|ar|mx|cl|co|io|me)\b/.test(t)) return 'direccion_web';
  if (/instagram|facebook|twitter|tiktok|youtube|whatsapp|telegram|pinterest/.test(t)) return 'red_social';
  if (/mercado ?libre|mercadolibre|mercado ?pago|mercado ?envios|envio gratis|\bfull\b/.test(t)) return 'etiqueta_mercado_libre';
  if (/\bdomicilio\b|\bimportador\b|\bcuit\b|\bcuil\b/.test(t)) return 'domicilio_o_datos_fiscales';
  // teléfono: una racha de 9 o más dígitos que no sea un ISBN (978/979)
  for (const m of t.matchAll(/\+?\d[\d\s().-]{6,}\d/g)) {
    const digitos = m[0].replace(/\D/g, '');
    if (digitos.length >= 9 && !/^97[89]/.test(digitos)) return 'telefono';
  }
  return null;
}
