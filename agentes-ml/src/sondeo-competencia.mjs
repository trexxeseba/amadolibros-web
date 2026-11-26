// Sondeo de SOLO LECTURA (26/11/2026): qué fuentes de Mercado Libre dejan ver la competencia
// ahora que /products/{id}/items responde 403 (PolicyAgent) a la app de Amado Libros.
//
//   node agentes-ml/src/sondeo-competencia.mjs
//
// Toma 5 publicaciones propias de catálogo y 5 sin catálogo (con ISBN) y prueba cada fuente con
// y sin token. El log es público: sólo imprime la fuente, el código HTTP y si trajo ofertas
// (cantidad), nunca ids, precios ni vendedores.
import { CUENTA } from './config.mjs';
import { crearCliente } from './ml.mjs';
import { fuenteTokenD1 } from '../../precio-ganador/src/token.mjs';
import { bulkItemsPath, bulkEntryItem } from '../../worker-sync/meli-bulk.js';

const fuente = fuenteTokenD1(CUENTA);
const ml = crearCliente(fuente, { intentos: 2, concurrencia: 2 });
const yo = await ml.get('/users/me');
if (String(yo?.id) !== CUENTA.sellerId) throw new Error('token_de_otra_cuenta');
const S = CUENTA.sellerId;

const ids = (await ml.get(`/users/${S}/items/search?status=active&limit=100`))?.results ?? [];
const items = [];
for (let i = 0; i < ids.length; i += 20) { const d = await ml.get(bulkItemsPath(ids.slice(i, i + 20), 'id,catalog_listing,catalog_product_id,attributes,title')); for (const e of d ?? []) { const it = bulkEntryItem(e); if (it) items.push(it); } }
const isbn = it => (it.attributes ?? []).find(a => a.id === 'GTIN' || a.id === 'ISBN')?.value_name?.split(',')[0]?.trim();
const cat = items.filter(i => i.catalog_listing && i.catalog_product_id).slice(0, 5);
const sin = items.filter(i => !i.catalog_listing && isbn(i)).slice(0, 5);

const res = {};
const anotar = (fuente, status, n) => { const r = res[fuente] ??= { codigos: {}, con_ofertas: 0 }; r.codigos[status] = (r.codigos[status] ?? 0) + 1; if (n > 0) r.con_ofertas++; };
const UA = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36', 'Accept-Language': 'es-UY,es;q=0.9' };
const crudo = async (url, headers = {}) => { try { const r = await fetch(url, { headers: { ...UA, ...headers } }); const t = await r.text(); return { status: r.status, t }; } catch (e) { return { status: 'red', t: '' }; } };
const tok = () => fuente.getToken();

for (const it of cat) {
  const p = it.catalog_product_id;
  let r = await ml.sonda(`/products/${p}/items?limit=50`); anotar('api /products/{id}/items con token', r.status, r.json?.results?.length);
  r = await ml.sonda(`/products/${p}`); anotar('api /products/{id} con token (buy_box_winner)', r.status, r.json?.buy_box_winner ? 1 : 0);
  r = await ml.sonda(`/sites/MLU/search?product_id=${p}`); anotar('api /sites/MLU/search?product_id con token', r.status, r.json?.results?.length);
  r = await ml.sonda(`/items/${it.id}/price_to_win?version=v2`); anotar('api price_to_win con token', r.status, r.json?.price_to_win ? 1 : 0);
  let c = await crudo(`https://api.mercadolibre.com/products/${p}/items?limit=50`); anotar('api /products/{id}/items sin token', c.status, (c.t.match(/"item_id"/g) ?? []).length);
  c = await crudo(`https://www.mercadolibre.com.uy/p/${p}/s`); anotar('web /p/{id}/s (otras opciones de compra)', c.status, (c.t.match(/POLYCARD|item_id/g) ?? []).length);
}
for (const it of sin) {
  const q = isbn(it);
  let r = await ml.sonda(`/sites/MLU/search?q=${encodeURIComponent(q)}`); anotar('api /sites/MLU/search?q con token', r.status, r.json?.results?.length);
  let c = await crudo(`https://api.mercadolibre.com/sites/MLU/search?q=${encodeURIComponent(q)}`); anotar('api /sites/MLU/search?q sin token', c.status, (c.t.match(/"id":"MLU/g) ?? []).length);
  c = await crudo(`https://listado.mercadolibre.com.uy/${encodeURIComponent(q)}`); anotar('web listado.mercadolibre.com.uy/{isbn}', c.status, c.t.split('POLYCARD').length - 1);
  c = await crudo(`https://api.mercadolibre.com/sites/MLU/search?q=${encodeURIComponent(q)}`, { Authorization: `Bearer ${await tok().catch(() => '')}` }); anotar('api search con token por fetch directo', c.status, (c.t.match(/"id":"MLU/g) ?? []).length);
}
console.log(JSON.stringify({ catalogo_probadas: cat.length, sin_catalogo_probadas: sin.length, fuentes: res }, null, 1));
