// Private run configuration and supplier data live in D1, never in this repo.
export const SELLER_ID = '440298103';
export const APP_ID = '4741021817925208';
export const PUBLICATION_PATH = '/operations/publication';

export class PublicationError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
export function canonicalIsbn(input) {
  let s = String(input ?? '').replace(/[^0-9Xx]/g, '').toUpperCase();
  const check13 = x => /^\d{13}$/.test(x) && [...x].reduce((n, c, i) => n + Number(c) * (i % 2 ? 3 : 1), 0) % 10 === 0;
  if (/^\d{9}[\dX]$/.test(s) && [...s].reduce((n,c,i) => n + (10-i) * (c === 'X' ? 10 : Number(c)), 0) % 11 === 0) {
    const stem = '978' + s.slice(0,9);
    s = stem + ((10 - [...stem].reduce((n,c,i) => n + Number(c)*(i%2?3:1),0)%10)%10);
  }
  if (!check13(s)) throw new PublicationError('invalid_isbn');
  return s;
}
export function hasSupplierStock(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0;
  return typeof value === 'string' && /^\+?\d+$/.test(value.trim()) && Number(value.trim()) > 0;
}
export function validPolicy(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PublicationError('invalid_policy');
  const keys = ['supplierDiscount','arsPerUyu','usdPerUyu','freightUsdKg','laborUyu','margin','mlFee','deliveryUyu','minimumContributionUyu','minimumSaleUyu','roundUyu','availabilityDays','additionalPricePct'];
  const p = Object.fromEntries(keys.map(k => [k, raw[k] ?? (k === 'additionalPricePct' ? 0 : undefined)]));
  if (keys.some(k => typeof p[k] !== 'number' || !Number.isFinite(p[k])) ||
      p.supplierDiscount < 0 || p.supplierDiscount >= 1 || p.arsPerUyu <= 0 || p.usdPerUyu <= 0 ||
      p.freightUsdKg < 0 || p.laborUyu < 0 || p.margin < 0 || p.mlFee < 0 || p.margin+p.mlFee >= 1 ||
      p.deliveryUyu < 0 || p.minimumContributionUyu < 0 || p.minimumSaleUyu <= 0 || p.roundUyu <= 0 ||
      !Number.isInteger(p.availabilityDays) || p.availabilityDays < 0 || p.availabilityDays > 60 ||
      p.additionalPricePct < 0 || p.additionalPricePct > 1 || !['gold_special','gold_pro'].includes(raw.listingTypeId)) throw new PublicationError('invalid_policy');
  // Catálogo obligatorio: sólo con la política explícita 'required_only'. El valor
  // forma parte del hash, así que habilitarlo exige un lote y una aprobación nuevos.
  const catalogListing = raw.catalogListing ?? false;
  if (!CATALOG_LISTING_POLICIES.includes(catalogListing)) throw new PublicationError('invalid_policy');
  // Precio competitivo: apagado por defecto. Sólo cuando es true entran al hash
  // `competitive` y `competitiveFloorMargin`, así las políticas ya aprobadas
  // conservan exactamente el mismo hash. El piso de margen lo fija Seba (0 a
  // `margin`): nunca se publica por debajo de ese margen sobre el costo.
  const competitive = raw.competitive ?? false;
  if (typeof competitive !== 'boolean') throw new PublicationError('invalid_policy');
  let competitivePart = {};
  if (competitive) {
    const floorMargin = raw.competitiveFloorMargin;
    if (typeof floorMargin !== 'number' || !Number.isFinite(floorMargin) || floorMargin < 0 || floorMargin > p.margin || floorMargin + p.mlFee >= 1) throw new PublicationError('invalid_policy');
    competitivePart = { competitive: true, competitiveFloorMargin: floorMargin };
  }
  return {...p, listingTypeId:raw.listingTypeId, catalogListing, currencyId:'UYU', condition:'new', ...competitivePart};
}
export const CATALOG_LISTING_POLICIES = [false, 'required_only'];
export function normalizeSupplierRow(raw) {
  const isbn = canonicalIsbn(raw?.isbn);
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!title || title.length > 600) throw new PublicationError('invalid_title');
  const row = {isbn,title,author:String(raw.author??'').slice(0,300),publisher:String(raw.publisher??'').slice(0,200),
    listArs:raw.listArs,weightKg:raw.weightKg,stock:String(raw.stock??'').trim()};
  if (raw.competitor !== undefined && raw.competitor !== null) {
    const price = raw.competitor.price, at = raw.competitor.at, days = raw.competitor.days ?? null;
    if ((price !== null && !(typeof price === 'number' && Number.isFinite(price) && price > 0)) || !Number.isFinite(at)) throw new PublicationError('invalid_competitor');
    if (days !== null && !(typeof days === 'number' && Number.isInteger(days) && days >= 0 && days <= 365)) throw new PublicationError('invalid_competitor');
    row.competitor = { price, at, days };
  }
  if (typeof row.listArs !== 'number' || !Number.isFinite(row.listArs) || row.listArs <= 0) throw new PublicationError('invalid_supplier_price');
  if (typeof row.weightKg !== 'number' || !Number.isFinite(row.weightKg) || row.weightKg <= 0 || row.weightKg > 30) throw new PublicationError('invalid_weight');
  return row;
}
export const COMPETITIVE_UNDERCUT = 0.01;
// Precio del ganador de la ficha guardado en el renglón del proveedor:
// row.competitor = {price:number|null, at:ms}. null = nadie más vende ese libro.
export function competitorPriceOf(row) {
  const price = row?.competitor?.price;
  return typeof price === 'number' && Number.isFinite(price) && price > 0 ? price : null;
}
// Días de disponibilidad del ganador (MANUFACTURING_TIME). 0 = entrega inmediata,
// null = no se pudo leer. Bajar el precio contra un ganador que entrega antes que
// nosotros no gana la ficha: ahí ML nos marca perdiendo por stock, no por precio.
export function competitorDaysOf(row) {
  const days = row?.competitor?.days;
  return typeof days === 'number' && Number.isFinite(days) && days >= 0 ? days : null;
}
// Precio objetivo y piso a partir del costo, con una sola fórmula para los dos:
// el margen que se le pase. `base` es el costo sin el envío que regalamos.
export function priceFromBase(base, policy, margin) {
  const p = validPolicy(policy), cost = base + p.deliveryUyu;
  const target = Math.max(base/(1-p.mlFee-margin)+p.deliveryUyu/(1-p.mlFee),(cost+p.minimumContributionUyu)/(1-p.mlFee),p.minimumSaleUyu);
  return Math.ceil((target*(1+p.additionalPricePct)-1e-9)/p.roundUyu)*p.roundUyu;
}
// Costo de una publicación ya activa, dando marcha atrás a la fórmula con la que
// se publicó. Es una ESTIMACIÓN: vale sólo si ese libro se publicó con esta misma
// política (margen, comisión, envío y redondeo). Sirve para calcular su piso sin
// tener el renglón del proveedor, que en una publicación vieja ya no está.
//
// El error tiene una sola dirección, y es la que conviene: el precio publicado es
// el mayor entre el término del margen, la contribución mínima y la venta mínima,
// así que cuando no manda el margen el precio es MÁS alto de lo que ese término
// pediría y el costo estimado sale por ENCIMA del real. Un costo de más levanta el
// piso, y un piso alto de más nunca baja un precio por debajo de lo que conviene:
// deja fichas sin ganar, no plata sobre la mesa. Lo que sí la deja es un margen
// declarado distinto del que se usó al publicar: por eso el margen asumido viaja
// en la respuesta.
export function estimatedBaseFromPrice(price, policy) {
  const p = validPolicy(policy);
  if (!(typeof price === 'number' && Number.isFinite(price) && price > 0)) return null;
  const base = (price/(1+p.additionalPricePct) - p.deliveryUyu/(1-p.mlFee)) * (1-p.mlFee-p.margin);
  return base > 0 ? base : null;
}
// Qué hacer con una publicación activa: bajar a ganador -1% sin pasar el piso,
// dejarla como está, o marcar por qué no se toca. Mismas reglas que al publicar.
export function competitiveDecision({price, rivalPrice, rivalDays, ownDays}, policy) {
  const p = validPolicy(policy);
  if (!p.competitive) throw new PublicationError('invalid_policy');
  const base = estimatedBaseFromPrice(price, policy);
  if (base === null) return {mode:'cost_unknown', newPrice:price, floor:null, estimatedCost:null};
  const floor = Math.min(price, priceFromBase(base, policy, p.competitiveFloorMargin));
  const estimatedCost = base + p.deliveryUyu;
  const mine = typeof ownDays === 'number' ? ownDays : p.availabilityDays;
  const out = {mode:'kept', newPrice:price, floor, estimatedCost, ownDays:mine};
  if (rivalPrice === null || rivalPrice === undefined) return {...out, mode:'no_competitor'};
  if (rivalDays === null || rivalDays === undefined) return {...out, mode:'rival_delivery_unknown'};
  if (rivalDays < mine) return {...out, mode:'rival_faster_delivery'};
  const wanted = Math.floor((rivalPrice*(1-COMPETITIVE_UNDERCUT)+1e-9)/p.roundUyu)*p.roundUyu;
  if (wanted >= price) return {...out, mode:'already_cheaper'};
  if (wanted < floor) return {...out, mode:'below_floor'};
  return {...out, mode:'lower', newPrice:wanted, contribution:wanted*(1-p.mlFee)-estimatedCost};
}
export function quoteMercadoLibre(row, policy) {
  const p = validPolicy(policy);
  const book = row.listArs*(1-p.supplierDiscount)/p.arsPerUyu;
  const freight = row.weightKg*p.freightUsdKg*p.usdPerUyu;
  const base = book+freight+p.laborUyu;
  const cost = base+p.deliveryUyu;
  const full = priceFromBase(base, p, p.margin);
  const result = {price:full,currencyId:'UYU',book,freight,cost};
  if (!p.competitive) return {...result,contribution:full*(1-p.mlFee)-cost};
  // Piso: el mayor entre el margen mínimo fijado por Seba, la contribución mínima
  // y la venta mínima. Nunca se publica por debajo.
  const floor = Math.min(full, priceFromBase(base, p, p.competitiveFloorMargin));
  const rival = competitorPriceOf(row), rivalDays = competitorDaysOf(row);
  let price = full,mode = rival===null?'no_competitor':'kept',skip=null;
  if (rival!==null) {
    const wanted = Math.floor((rival*(1-COMPETITIVE_UNDERCUT)+1e-9)/p.roundUyu)*p.roundUyu;
    // Sólo el precio decide cuando nuestra entrega no es peor que la del ganador.
    if (rivalDays===null) mode = 'rival_delivery_unknown';
    else if (rivalDays < p.availabilityDays) mode = 'rival_faster_delivery';
    else if (wanted < full) {
      if (wanted >= floor) { price = wanted; mode = 'matched'; }
      else { mode = 'below_floor'; skip = 'not_competitive'; }
    }
  }
  return {...result,price,contribution:price*(1-p.mlFee)-cost,competitive:{mode,floor,fullPrice:full,competitorPrice:rival,competitorDays:rivalDays,ownDays:p.availabilityDays},...(skip?{skip}:{})};
}
export function stockIsFresh(sourceDate, now=Date.now(), maxHours=24) {
  const date = Date.parse(sourceDate);
  return Number.isFinite(date) && date <= now+300_000 && now-date <= maxHours*3600_000;
}
export function normalizedTitle(value) { return String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,''); }
export async function sha256(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
}
export async function policyHash(raw) { return sha256(JSON.stringify(validPolicy(raw))); }
export function safeCode(error) { return error instanceof PublicationError ? error.code : 'internal_error'; }
