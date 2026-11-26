// Sondeo de SOLO LECTURA (26/11/2026): Meli+ en Amado Libros. Cuántas activas tienen la marca
// loyalty_discount_eligible, de qué dominio, y qué promociones ofrece ML para 8 de ellas (tipos).
// El log es público: sólo conteos, tipos y códigos HTTP.
import { CUENTA } from './config.mjs';
import { crearCliente } from './ml.mjs';
import { fuenteTokenD1 } from '../../precio-ganador/src/token.mjs';
import { bulkItemsPath, bulkEntryItem } from '../../worker-sync/meli-bulk.js';

const ml = crearCliente(fuenteTokenD1(CUENTA), { intentos: 3, concurrencia: 3 });
const yo = await ml.get('/users/me');
if (String(yo?.id) !== CUENTA.sellerId) throw new Error('token_de_otra_cuenta');
const S = CUENTA.sellerId, out = {};
const t = await ml.sonda(`/users/${S}/items/search?status=active&tags=loyalty_discount_eligible&limit=100`);
out.busqueda_por_tag = { status: t.status, total: t.json?.paging?.total ?? null };
const ids = t.json?.results ?? [];
const its = []; for (let i = 0; i < ids.length; i += 20) { const d = await ml.get(bulkItemsPath(ids.slice(i, i + 20), 'id,domain_id,price,listing_type_id,tags,shipping,catalog_listing')); for (const e of d ?? []) { const x = bulkEntryItem(e); if (x) its.push(x); } }
const c = (f) => its.reduce((o, x) => (o[f(x)] = (o[f(x)] ?? 0) + 1, o), {});
out.dominios = c(x => x.domain_id); out.tipo_publicacion = c(x => x.listing_type_id); out.catalogo = c(x => String(!!x.catalog_listing));
out.promos_ofrecidas = {};
for (const x of its.slice(0, 8)) { const r = await ml.sonda(`/seller-promotions/items/${x.id}?app_version=v2`); for (const p of Array.isArray(r.json) ? r.json : []) { const k = `${p.type}|${p.status}|${p.sub_type ?? ''}`; out.promos_ofrecidas[k] = (out.promos_ofrecidas[k] ?? 0) + 1; } if (!r.ok) out.promos_ofrecidas[`http_${r.status}`] = (out.promos_ofrecidas[`http_${r.status}`] ?? 0) + 1; }
// Sin la marca: tipos de publicación para comparar (muestra de 200 activas que no son libro).
const todas = []; let scroll = null; for (let i = 0; i < 80; i++) { const d = await ml.get(`/users/${S}/items/search?status=active&search_type=scan&limit=100${scroll ? `&scroll_id=${encodeURIComponent(scroll)}` : ''}`); const r = d?.results ?? []; if (!r.length) break; todas.push(...r); scroll = d?.scroll_id; if (!scroll) break; }
const resto = []; for (let i = 0; i < todas.length && resto.length < 400; i += 20) { const d = await ml.get(bulkItemsPath(todas.slice(i, i + 20), 'id,domain_id,listing_type_id,tags,price')); for (const e of d ?? []) { const x = bulkEntryItem(e); if (x && !/-BOOKS$/.test(x.domain_id ?? '')) resto.push(x); } }
const conTag = resto.filter(x => (x.tags ?? []).includes('loyalty_discount_eligible')), sinTag = resto.filter(x => !(x.tags ?? []).includes('loyalty_discount_eligible'));
const tipo = l => l.reduce((o, x) => (o[x.listing_type_id] = (o[x.listing_type_id] ?? 0) + 1, o), {});
const precio = l => { const p = l.map(x => x.price).sort((a, b) => a - b); return p.length ? { min: p[0], mediana: p[Math.floor(p.length / 2)], max: p.at(-1) } : null; };
out.no_libros_leidos = resto.length; out.no_libros_con_marca = { n: conTag.length, tipo: tipo(conTag), precio: precio(conTag) }; out.no_libros_sin_marca = { n: sinTag.length, tipo: tipo(sinTag), precio: precio(sinTag) };
console.log(JSON.stringify(out, null, 1));
