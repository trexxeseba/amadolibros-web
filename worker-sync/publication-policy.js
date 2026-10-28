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
    // Opcionales (sólo entran al hash si se fijan): venta mínima para un precio
    // igualado (puede ser menor que minimumSaleUyu, que rige el precio completo) y qué
    // hacer cuando ganarle al rival exige bajar del piso: 'skip' (no publicar, el
    // comportamiento original) o 'full' (publicar al precio de margen completo).
    if (raw.competitiveMinimumSaleUyu !== undefined) {
      const min = raw.competitiveMinimumSaleUyu;
      if (typeof min !== 'number' || !Number.isFinite(min) || min <= 0 || min > p.minimumSaleUyu) throw new PublicationError('invalid_policy');
      competitivePart.competitiveMinimumSaleUyu = min;
    }
    if (raw.competitiveBelowFloor !== undefined) {
      if (!['skip','full'].includes(raw.competitiveBelowFloor)) throw new PublicationError('invalid_policy');
      competitivePart.competitiveBelowFloor = raw.competitiveBelowFloor;
    }
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
export function quoteMercadoLibre(row, policy) {
  const p = validPolicy(policy);
  const book = row.listArs*(1-p.supplierDiscount)/p.arsPerUyu;
  const freight = row.weightKg*p.freightUsdKg*p.usdPerUyu;
  const base = book+freight+p.laborUyu;
  const cost = base+p.deliveryUyu;
  const target = Math.max(base/(1-p.mlFee-p.margin)+p.deliveryUyu/(1-p.mlFee),(cost+p.minimumContributionUyu)/(1-p.mlFee),p.minimumSaleUyu);
  const full = Math.ceil((target*(1+p.additionalPricePct)-1e-9)/p.roundUyu)*p.roundUyu;
  const result = {price:full,currencyId:'UYU',book,freight,cost};
  if (!p.competitive) return {...result,contribution:full*(1-p.mlFee)-cost};
  // Piso: el mayor entre el margen mínimo fijado por Seba, la contribución mínima
  // y la venta mínima. Nunca se publica por debajo.
  const floorTarget = Math.max(base/(1-p.mlFee-p.competitiveFloorMargin)+p.deliveryUyu/(1-p.mlFee),(cost+p.minimumContributionUyu)/(1-p.mlFee),p.competitiveMinimumSaleUyu ?? p.minimumSaleUyu);
  const floor = Math.min(full,Math.ceil((floorTarget-1e-9)/p.roundUyu)*p.roundUyu);
  const rival = competitorPriceOf(row), rivalDays = competitorDaysOf(row);
  let price = full,mode = rival===null?'no_competitor':'kept',skip=null;
  if (rival!==null) {
    const wanted = Math.floor((rival*(1-COMPETITIVE_UNDERCUT)+1e-9)/p.roundUyu)*p.roundUyu;
    // Sólo el precio decide cuando nuestra entrega no es peor que la del ganador.
    if (rivalDays===null) mode = 'rival_delivery_unknown';
    else if (rivalDays < p.availabilityDays) mode = 'rival_faster_delivery';
    else if (wanted < full) {
      if (wanted >= floor) { price = wanted; mode = 'matched'; }
      else if (p.competitiveBelowFloor === 'full') mode = 'below_floor_full_price';
      else { mode = 'below_floor'; skip = 'not_competitive'; }
    }
  }
  return {...result,price,contribution:price*(1-p.mlFee)-cost,competitive:{mode,floor,fullPrice:full,competitorPrice:rival,competitorDays:rivalDays,ownDays:p.availabilityDays},...(skip?{skip}:{})};
}
// Amado Vintage acepta una lista de SBS de hasta 48 h: si SBS se saltea un día, sigue
// publicando con la anterior. Amado Libros sigue con 24 h (el valor por defecto).
export const VINTAGE_STOCK_MAX_HOURS = 48;
// Con la lista al día la conexión de la PC vence a las 24 h de su fecha (así baja la nueva
// cada madrugada). Con una lista de entre 24 y 48 h dura 2 h, para volver a mirar el portal.
export function vintageAccessExpiry(sourceDate, now=Date.now()) {
  const date = Date.parse(sourceDate);
  return Math.max(date + 24*3600_000, Math.min(date + VINTAGE_STOCK_MAX_HOURS*3600_000, now + 2*3600_000));
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
