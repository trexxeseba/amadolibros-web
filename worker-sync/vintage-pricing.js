import {validPolicy,PublicationError} from './publication-policy.js';
export const VINTAGE_MINIMUM_UYU=1600;
export function vintagePolicy(input){const policy=validPolicy(input);return {...policy,minimumSaleUyu:Math.max(VINTAGE_MINIMUM_UYU,policy.minimumSaleUyu)};}
export function requireVintagePrice(payload){if(payload?.currency_id!=='UYU'||!Number.isFinite(payload.price)||payload.price<VINTAGE_MINIMUM_UYU)throw new PublicationError('vintage_price_below_1600',422);}

