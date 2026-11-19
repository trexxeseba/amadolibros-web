// Lógica pura del informe de promociones de Amado Vintage (sin red, sin reloj).
// Responde una sola pregunta: ¿cuánto descuento aguanta cada libro sin bajar de su piso?
// El piso es el que ya calcula Precio Ganador (precio-ganador/src/costos-vintage.mjs):
// costo según la lista de SBS, margen mínimo de 18 % y venta mínima. Acá no se decide ni
// se escribe nada: sólo se mide.

export const NIVELES_DESCUENTO = [5, 8, 10, 12, 15, 20];   // % sobre el precio publicado
export const MONTOS_CUPON = [100, 200, 300, 500];           // pesos fijos (UYU)

const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);

// Margen de maniobra de un libro: cuánto se le puede bajar el precio sin pisar el piso.
export function maniobra({ precio, piso }) {
  const p = num(precio), f = num(piso);
  if (p === null || p <= 0 || f === null || f <= 0) return null;
  const pesos = Math.max(0, p - f);
  return { pesos, pct: pesos / p };
}

export const TRAMOS = [
  { clave: 'menos_de_3', etiqueta: 'menos de 3 %', max: 0.03 },
  { clave: '3_a_7', etiqueta: '3 a 7 %', max: 0.07 },
  { clave: '7_a_12', etiqueta: '7 a 12 %', max: 0.12 },
  { clave: '12_o_mas', etiqueta: '12 % o más', max: Infinity },
];
export const tramoDe = pct => TRAMOS.find(t => pct < t.max) ?? TRAMOS[TRAMOS.length - 1];

// ¿Aguanta el libro un descuento de `pct` % (o de `monto` pesos) sin bajar del piso?
export const aguantaPct = ({ precio, piso }, pct) => num(piso) !== null && num(precio) !== null && precio * (1 - pct / 100) + 1e-9 >= piso;
export const aguantaMonto = ({ precio, piso }, monto) => num(piso) !== null && num(precio) !== null && precio - monto + 1e-9 >= piso;

const mediana = xs => { if (!xs.length) return null; const o = [...xs].sort((a, b) => a - b), m = o.length >> 1; return o.length % 2 ? o[m] : (o[m - 1] + o[m]) / 2; };
const redondeo = (v, d = 1) => v === null ? null : Math.round(v * 10 ** d) / 10 ** d;

// libros: [{ id, precio, piso|null, conDescuento }]
// conDescuento = ya tiene una promoción a la vista (original_price): su precio es el de la promo.
export function resumenMargen(libros) {
  const total = libros.length;
  const sinPiso = libros.filter(l => num(l.piso) === null).length;
  const yaConDescuento = libros.filter(l => l.conDescuento).length;
  const medibles = libros.filter(l => !l.conDescuento && maniobra(l));
  const tramos = Object.fromEntries(TRAMOS.map(t => [t.clave, 0]));
  for (const l of medibles) tramos[tramoDe(maniobra(l).pct).clave]++;
  const aguantan = {};
  for (const n of NIVELES_DESCUENTO) aguantan[`${n}%`] = medibles.filter(l => aguantaPct(l, n)).length;
  const aguantanMonto = {};
  for (const m of MONTOS_CUPON) aguantanMonto[`$${m}`] = medibles.filter(l => aguantaMonto(l, m)).length;
  return {
    total, medibles: medibles.length, sin_piso: sinPiso, ya_con_descuento: yaConDescuento,
    tramos, aguantan_descuento: aguantan, aguantan_cupon: aguantanMonto,
    mediana_pct: redondeo((mediana(medibles.map(l => maniobra(l).pct)) ?? 0) * 100),
  };
}

// Una candidata de campaña (entrada de /seller-promotions/promotions/{id}/items): ¿le cierra al piso?
// Conservador: se mira el precio que paga el comprador, sin contar lo que ponga Mercado Libre.
export function evaluarEntrada({ promo, entrada, precio, piso }) {
  const f = num(piso), p = num(precio);
  if (f === null) return { estado: 'sin_piso' };
  if (p === null || p <= 0) return { estado: 'sin_datos' };
  const tipo = promo?.type;
  let final = null, minimo = null;
  if (['SELLER_CAMPAIGN', 'DEAL', 'PRICE_DISCOUNT'].includes(tipo)) {
    // max_discounted_price = el precio con MENOR descuento que acepta la campaña.
    final = num(entrada?.max_discounted_price) ?? num(entrada?.suggested_discounted_price);
    minimo = num(entrada?.min_discounted_price);
  } else if (['SMART', 'SMART_LIGHTNING', 'MARKETPLACE_CAMPAIGN'].includes(tipo)) {
    const fijo = num(entrada?.price);
    final = fijo !== null && fijo > 0 ? fijo : num(entrada?.suggested_discounted_price);
  } else if (tipo === 'VOLUME') {
    const d = num(entrada?.discount_percentage);
    final = d === null ? null : p * (1 - d / 100);
  } else if (tipo === 'SELLER_COUPON_CAMPAIGN') {
    const m = num(entrada?.fixed_amount);
    final = m === null ? null : p - m;
  }
  if (final === null || final <= 0) return { estado: 'sin_datos' };
  const descuentoPct = redondeo(((p - final) / p) * 100);
  const entra = final + 1e-9 >= f;
  return { estado: entra ? 'entra' : 'no_entra', precioFinal: redondeo(final, 0), descuentoPct, ...(minimo !== null ? { minimoCampana: minimo } : {}) };
}

// Resumen de lo leído de una campaña: cuántas candidatas entran, no entran o no se pueden medir.
export function resumenCampana(promo, evaluaciones) {
  const c = { entra: 0, no_entra: 0, sin_piso: 0, sin_datos: 0, fuera_de_muestra: 0 };
  for (const e of evaluaciones) c[e.estado] = (c[e.estado] ?? 0) + 1;
  return { id: promo.id, tipo: promo.type, estado: promo.status, nombre: promo.name ?? null, desde: promo.start_date ?? null, hasta: promo.finish_date ?? promo.deadline_date ?? null, leidas: evaluaciones.length, ...c };
}

const pct = (n, d) => d ? `${Math.round((n / d) * 100)} %` : '-';

// Texto del informe: sólo agregados (nunca costo, piso ni margen de un libro puntual).
export function armarResumen({ fecha, cuenta, pisos, margen, campanas, errores = [] }) {
  const L = [];
  L.push(`# Informe de promociones de Amado Vintage (${fecha})`, '');
  L.push(`Cuenta verificada con Mercado Libre: ${cuenta}. Solo lectura: no se escribió nada.`, '');
  L.push(`Lista de SBS usada para el costo: ${pisos?.lista_sbs ?? 'sin dato'} (${pisos?.dias_lista ?? '?'} días, ${pisos?.lista_vigente ? 'vigente' : 'VENCIDA: sin piso, no se mide nada'}).`, '');
  L.push('## Cuánto descuento aguantan los libros activos', '');
  L.push(`Publicaciones activas leídas: ${margen.total}. Medibles (con costo conocido y sin promo a la vista): ${margen.medibles}. Sin costo conocido: ${margen.sin_piso}. Ya con descuento a la vista: ${margen.ya_con_descuento}.`, '');
  L.push('Margen de maniobra sobre el precio publicado (hasta el piso de 18 % de margen):', '');
  for (const t of TRAMOS) L.push(`- ${t.etiqueta}: ${margen.tramos[t.clave]} libros (${pct(margen.tramos[t.clave], margen.medibles)})`);
  L.push(`- Mediana: ${margen.mediana_pct} %`, '');
  L.push('Libros que aguantan un descuento sin bajar del piso:', '');
  for (const [k, v] of Object.entries(margen.aguantan_descuento)) L.push(`- ${k}: ${v} (${pct(v, margen.medibles)})`);
  L.push('', 'Libros que aguantan un cupón de monto fijo:', '');
  for (const [k, v] of Object.entries(margen.aguantan_cupon)) L.push(`- ${k}: ${v} (${pct(v, margen.medibles)})`);
  L.push('', '## Campañas y cupones de la cuenta', '');
  if (!campanas.length) L.push('No se pudieron leer campañas (ver errores abajo).');
  for (const c of campanas) L.push(`- ${c.tipo} "${c.nombre ?? c.id}" (${c.estado}${c.hasta ? `, hasta ${String(c.hasta).slice(0, 10)}` : ''}): leídas ${c.leidas}, entran ${c.entra}, no entran ${c.no_entra}, sin costo ${c.sin_piso}, sin dato ${c.sin_datos}, fuera de la muestra ${c.fuera_de_muestra}.`);
  if (errores.length) { L.push('', '## Errores', ''); for (const e of errores) L.push(`- ${e}`); }
  L.push('', 'Nota: "entra" mide el precio que paga el comprador contra el piso, sin contar el aporte de Mercado Libre en las campañas compartidas (conservador).');
  return L.join('\n');
}
