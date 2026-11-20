// Temporal (solo lectura): mira la tienda GLIC de Mercado Libre Uruguay (libros) para entender qué vende y a qué precio.
import {CUENTAS} from '../precio-ganador/src/config.mjs';
import {fuenteTokenD1} from '../precio-ganador/src/token.mjs';
import {crearCliente} from '../precio-ganador/src/ml.mjs';
import {CUENTA_HERMES} from './lib.mjs';
const ml = crearCliente(fuenteTokenD1(CUENTAS[CUENTA_HERMES]), {concurrencia: 1});
const pausa = ms => new Promise(r => setTimeout(r, ms));
const r = await ml.get('/sites/MLU/search?nickname=GLIC&limit=50&sort=sold_quantity_desc').catch(e => ({error: e.code, body: JSON.stringify(e.body ?? '').slice(0, 200)}));
if (r.error) { console.log('busqueda fallo', r.error, r.body); process.exit(0); }
console.log('SELLER', JSON.stringify(r.seller ?? null), 'TOTAL', r.paging?.total);
const vistos = r.results ?? [];
let c = 0, ean = 0;
for (const it of vistos.slice(0, 25)) {
  c++;
  const isbn = (it.attributes ?? []).find(a => ['GTIN', 'ISBN'].includes(a.id))?.value_name ?? '-';
  console.log('ITEM', it.id, '|', it.title?.slice(0, 55), '|', it.price, '|vend', it.sold_quantity, '|', it.condition, '|', it.shipping?.free_shipping ? 'envio gratis' : 'sin envio gratis', '|', it.shipping?.logistic_type, '|', isbn, '|', it.catalog_listing ? 'catalogo' : 'normal');
}
const logi = {}; const cond = {};
for (const it of vistos) { logi[it.shipping?.logistic_type] = (logi[it.shipping?.logistic_type] || 0) + 1; cond[it.condition] = (cond[it.condition] || 0) + 1; }
console.log('LOGISTICA', JSON.stringify(logi), 'CONDICION', JSON.stringify(cond));
