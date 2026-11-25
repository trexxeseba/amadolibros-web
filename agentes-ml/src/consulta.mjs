// Consulta de SOLO LECTURA de una publicación propia por título.
//
//   node agentes-ml/src/consulta.mjs "codigo de las mentes extraordinarias"
//
// Recorre las publicaciones activas de Amado Libros, encuentra las que contienen
// todas las palabras del título y muestra, de cada una: precio actual, precio
// visible (sale_price), historial de precios (/items/{id}/prices con fechas),
// promociones activas, stock, estado de competencia y fecha de alta. Solo GET.
// Precios y promos de nuestras propias publicaciones ya son visibles en Mercado
// Libre; no se imprimen datos de otros vendedores salvo el precio del ganador.
import { CUENTA } from './config.mjs';
import { crearCliente } from './ml.mjs';
import { texto, elegir, detalleError } from './sanear.mjs';
import { fuenteTokenD1 } from '../../precio-ganador/src/token.mjs';
import { bulkItemsPath, bulkEntryItem } from '../../worker-sync/meli-bulk.js';

const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const palabras = norm(process.argv.slice(2).join(' ')).split(/\s+/).filter(w => w.length > 2);
if (!palabras.length) { console.error('Falta el título'); process.exit(2); }

const ml = crearCliente(fuenteTokenD1(CUENTA), { intentos: 4, concurrencia: 4 });
const campos = 'id,title,price,base_price,original_price,available_quantity,sold_quantity,status,catalog_listing,catalog_product_id,date_created,last_updated,seller_custom_field,sale_terms,tags,listing_type_id';

const yo = await ml.get('/users/me');
if (String(yo?.id) !== CUENTA.sellerId) throw Object.assign(new Error('token_de_otra_cuenta'), { fatal: true });

const ids = []; let scroll = null;
for (let pagina = 0; pagina < 120; pagina++) {
  const d = await ml.get(`/users/${CUENTA.sellerId}/items/search?status=active&search_type=scan&limit=100${scroll ? `&scroll_id=${encodeURIComponent(scroll)}` : ''}`);
  const res = Array.isArray(d?.results) ? d.results : [];
  if (!res.length) break;
  ids.push(...res); scroll = d?.scroll_id; if (!scroll) break;
}
console.log(`Activas leídas: ${ids.length}`);

const lotes = []; for (let i = 0; i < ids.length; i += 20) lotes.push(ids.slice(i, i + 20));
const coinciden = [];
await Promise.all(lotes.map(async lote => {
  const d = await ml.get(bulkItemsPath(lote, campos));
  for (const e of Array.isArray(d) ? d : []) {
    const it = bulkEntryItem(e); if (!it) continue;
    const t = norm(it.title); if (palabras.every(p => t.includes(p))) coinciden.push(it);
  }
}));
console.log(`Coinciden con "${texto(palabras.join(' '))}": ${coinciden.length}`);

const intentar = async (path) => { const r = await ml.sonda(path); return r.ok ? r.json : { http: r.status, detalle: texto(JSON.stringify(r.json ?? {})) }; };
for (const it of coinciden.slice(0, 4)) {
  const dias = (Date.now() - Date.parse(it.date_created)) / 86400000;
  const manu = (it.sale_terms ?? []).find(s => s?.id === 'MANUFACTURING_TIME');
  const [venta, precios, promos, ptw] = await Promise.all([
    intentar(`/items/${it.id}/sale_price`),
    intentar(`/items/${it.id}/prices`),
    intentar(`/seller-promotions/items/${it.id}?app_version=v2`),
    intentar(`/items/${it.id}/price_to_win?version=v2`),
  ]);
  const promosVivas = (Array.isArray(promos) ? promos : []).filter(p => ['started', 'pending'].includes(p?.status))
    .map(p => elegir(p, ['id', 'type', 'status', 'name', 'price', 'original_price', 'meli_percentage', 'seller_percentage', 'start_date', 'finish_date']));
  console.log('\n=== ' + it.id);
  console.log(JSON.stringify({
    titulo: texto(it.title), precio: it.price, base_price: it.base_price, stock: it.available_quantity, vendidos: it.sold_quantity, catalogo: it.catalog_listing,
    entrega: manu ? `a pedido (${texto(manu.value_name)})` : 'inmediata (sin MANUFACTURING_TIME)', alta: it.date_created, dias_desde_alta: Math.floor(dias), ultima_modificacion: it.last_updated,
    sku: texto(it.seller_custom_field),
    precio_visible: elegir(venta, ['amount', 'regular_amount', 'metadata', 'http', 'detalle']),
    historial_precios: (precios?.prices ?? (Array.isArray(precios) ? precios : [])).map(p => elegir(p, ['id', 'type', 'amount', 'regular_amount', 'last_updated', 'conditions'])).concat(precios?.http ? [precios] : []),
    promos_activas_o_programadas: promosVivas,
    competencia: elegir(ptw, ['status', 'price_to_win', 'current_price', 'reason', 'visit_share', 'competitors_sharing_first_place', 'http', 'detalle']),
    ganador_precio: ptw?.winner?.price ?? null,
  }, null, 1));
}
console.log('\nEstadísticas:', JSON.stringify(ml.stats));
