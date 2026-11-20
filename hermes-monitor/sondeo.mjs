// Temporal (solo lectura): inspeccionar la página pública de la tienda GLIC.
const r = await fetch('https://www.mercadolibre.com.uy/tienda/glic', {headers: {'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'es-UY'}});
const t = await r.text();
console.log('PAG', r.status, t.length);
const uniq = a => [...new Set(a)];
console.log('PAG seller_id', uniq([...t.matchAll(/"(?:seller_id|sellerId|user_id|userId)"\s*:\s*"?(\d{5,})/g)].map(m => m[1])).slice(0, 5).join(','));
const ids = uniq([...t.matchAll(/MLU-?(\d{8,})/g)].map(m => 'MLU' + m[1]));
console.log('PAG items', ids.length, ids.slice(0, 20).join(','));
console.log('PAG titulos', uniq([...t.matchAll(/"title"\s*:\s*"([^"]{8,100})"/g)].map(m => m[1])).slice(0, 12).join(' || '));
console.log('PAG total', (t.match(/(\d[\d.]*)\s*(?:resultados|publicaciones|productos)/g) ?? []).slice(0, 5).join(' | '));
console.log('PAG api', uniq([...t.matchAll(/https?:\/\/[^"'\s\\]*(?:api|graphql|search|listado)[^"'\s\\]{0,120}/g)].map(m => m[0])).slice(0, 8).join('\nPAG api '));
