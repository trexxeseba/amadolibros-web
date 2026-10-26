import {validPolicy,PublicationError} from './publication-policy.js';
// Precio completo (margen pleno): nunca menos de UYU 1.600.
export const VINTAGE_MINIMUM_UYU=1600;
// Precio igualado para ganar la ficha: nunca menos de UYU 1.500. Es el piso absoluto
// de cualquier publicación de Vintage.
export const VINTAGE_COMPETITIVE_MINIMUM_UYU=1500;
// Precio competitivo de Vintage, fijado por Seba (26/10/2026): ganador de la ficha -1 %,
// con margen mínimo del 18 % sobre el costo y nunca menos de UYU 1.500. Si ganarle exige
// bajar de ese piso, el libro se publica igual a precio completo ('full').
export const VINTAGE_COMPETITIVE={competitive:true,competitiveFloorMargin:.18,competitiveMinimumSaleUyu:VINTAGE_COMPETITIVE_MINIMUM_UYU,competitiveBelowFloor:'full'};
export function vintagePolicy(input){
 const policy=validPolicy(input),out={...policy,minimumSaleUyu:Math.max(VINTAGE_MINIMUM_UYU,policy.minimumSaleUyu)};
 if(out.competitive)out.competitiveMinimumSaleUyu=Math.min(out.minimumSaleUyu,Math.max(VINTAGE_COMPETITIVE_MINIMUM_UYU,out.competitiveMinimumSaleUyu??out.minimumSaleUyu));
 return out;
}
// La política vigente con el precio competitivo de Vintage aplicado.
export function vintageCompetitivePolicy(input){return vintagePolicy({...input,...VINTAGE_COMPETITIVE});}
// Mínimo de venta para un alta según la política: 1.600 a precio completo, 1.500 si es competitiva.
export function vintageMinimumFor(policy){return policy?.competitive?VINTAGE_COMPETITIVE_MINIMUM_UYU:VINTAGE_MINIMUM_UYU;}
export function requireVintagePrice(payload,minimum=VINTAGE_MINIMUM_UYU){
 const floor=Math.max(VINTAGE_COMPETITIVE_MINIMUM_UYU,minimum);
 if(payload?.currency_id!=='UYU'||!Number.isFinite(payload.price)||payload.price<floor)throw new PublicationError(`vintage_price_below_${floor}`,422);
}
