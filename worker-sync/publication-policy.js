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
  return {...p, listingTypeId:raw.listingTypeId, catalogListing:false, currencyId:'UYU', condition:'new'};
}
export function normalizeSupplierRow(raw) {
  const isbn = canonicalIsbn(raw?.isbn);
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!title || title.length > 600) throw new PublicationError('invalid_title');
  const row = {isbn,title,author:String(raw.author??'').slice(0,300),publisher:String(raw.publisher??'').slice(0,200),
    listArs:raw.listArs,weightKg:raw.weightKg,stock:String(raw.stock??'').trim()};
  if (typeof row.listArs !== 'number' || !Number.isFinite(row.listArs) || row.listArs <= 0) throw new PublicationError('invalid_supplier_price');
  if (typeof row.weightKg !== 'number' || !Number.isFinite(row.weightKg) || row.weightKg <= 0 || row.weightKg > 30) throw new PublicationError('invalid_weight');
  return row;
}
export function quoteMercadoLibre(row, policy) {
  const p = validPolicy(policy);
  const book = row.listArs*(1-p.supplierDiscount)/p.arsPerUyu;
  const freight = row.weightKg*p.freightUsdKg*p.usdPerUyu;
  const base = book+freight+p.laborUyu;
  const cost = base+p.deliveryUyu;
  const target = Math.max(base/(1-p.mlFee-p.margin)+p.deliveryUyu/(1-p.mlFee),(cost+p.minimumContributionUyu)/(1-p.mlFee),p.minimumSaleUyu);
  const price = Math.ceil((target*(1+p.additionalPricePct)-1e-9)/p.roundUyu)*p.roundUyu;
  return {price,currencyId:'UYU',book,freight,cost,contribution:price*(1-p.mlFee)-cost};
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
