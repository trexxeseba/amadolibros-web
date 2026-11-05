import {normalizeSourceUrl} from '../../functions/_shared/preview-cover.js';
import {CARD_RECIPES,PRODUCTION_IMAGE_BUCKET,MAX_CARD_READINESS_ENTRIES} from '../../functions/_shared/card-variant-delivery.js';
export const BASE_READINESS_SHA256='fdc59f13a42150ac77cd6cb5c700bc0b963eed3efc48259891ef77f32a49adcf';
const hash=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');
// Pure preparation: no network, encoder or bucket writes. New aliases must
// reuse a master/extension already covered by the verified base index.
export async function extendCardReadiness({baseText,baseDigest,additions}){
 const encoder=new TextEncoder();
 if(encoder.encode(baseText).length>2_000_000||await hash(encoder.encode(baseText))!==baseDigest)throw Error('base-index-integrity');
 const base=JSON.parse(baseText);
 if(base.schema!=='verified-card-readiness-v1'||base.bucket!==PRODUCTION_IMAGE_BUCKET||JSON.stringify(base.recipes)!==JSON.stringify(CARD_RECIPES)||!base.cards||typeof base.cards!=='object'||Array.isArray(base.cards))throw Error('base-index-schema');
 if(!Array.isArray(additions)||additions.length!==29)throw Error('expected-exactly-29-additions');
 const known=new Set(Object.values(base.cards).map(r=>r.sha256+'.'+r.extension)),cards={...base.cards};
 for(const row of additions){
  if(!/^MLU\d+$/.test(row.id)||cards[row.id]||!/^[a-f0-9]{64}$/.test(row.sha256)||!['jpg','png','webp'].includes(row.extension)||!known.has(row.sha256+'.'+row.extension)||!normalizeSourceUrl(row.source_url))throw Error('unverified-or-duplicate-alias');
  cards[row.id]={sha256:row.sha256,extension:row.extension,source_url:normalizeSourceUrl(row.source_url)};
 }
 if(Object.keys(cards).length>MAX_CARD_READINESS_ENTRIES)throw Error('readiness-entry-budget');
 const text=JSON.stringify({...base,cards}),bytes=encoder.encode(text);
 if(bytes.length>2_000_000)throw Error('readiness-byte-budget');
 const digest=await hash(bytes);
 return {text,digest,key:`covers/card-readiness/v1/${digest}.json`,cards:Object.keys(cards).length,added:additions.length,bytes:bytes.length};
}
