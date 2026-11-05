// Diagnóstico de publicaciones puntuales (sólo lee). Para entender por qué ML
// aceptó un cambio de precio y la publicación quedó con otro.
//
//   node precio-ganador/src/diagnostico.mjs --cuenta vintage --ids MLU1,MLU2 [--salida DIR]
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CUENTAS } from './config.mjs';
import { fuenteTokenD1 } from './token.mjs';
import { crearCliente } from './ml.mjs';

const args = process.argv.slice(2);
const opt = (n, d = null) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const cuenta = CUENTAS[opt('cuenta')];
const ids = String(opt('ids', '')).split(/[,\s]+/).filter(id => /^MLU\d+$/.test(id));
if (!cuenta || !ids.length) { console.error('Usar --cuenta libros|vintage --ids MLU...,MLU...'); process.exit(2); }
const salida = opt('salida', 'salida');
const ml = crearCliente(fuenteTokenD1(cuenta), { concurrencia: 2 });
const intentar = async (path) => { try { return await ml.get(path); } catch (e) { return { error: e?.code ?? 'error', status: e?.status ?? null, detalle: e?.detalle ?? null }; } };

const yo = await ml.get('/users/me');
if (String(yo?.id) !== cuenta.sellerId) { console.error('token_de_otra_cuenta'); process.exit(1); }
const informe = {};
for (const id of ids) {
  const item = await intentar(`/items/${id}?attributes=id,title,price,base_price,original_price,currency_id,status,sub_status,tags,item_relations,deal_ids,last_updated,date_created,available_quantity,sold_quantity,catalog_listing,catalog_product_id,sale_terms,listing_type_id,health`);
  informe[id] = {
    item,
    precios: await intentar(`/items/${id}/prices`),
    precio_venta: await intentar(`/items/${id}/sale_price?context=channel_marketplace`),
    promociones: await intentar(`/seller-promotions/items/${id}?app_version=v2`),
    price_to_win: await intentar(`/items/${id}/price_to_win?version=v2`),
    automatizacion: await intentar(`/pricing-automation/items/${id}/rules`),
    gemelas: Array.isArray(item?.item_relations) ? await Promise.all(item.item_relations.map(r => intentar(`/items/${r.id}?attributes=id,price,status,catalog_listing,last_updated`))) : [],
  };
  console.log(id, JSON.stringify({ precio: item?.price, original_price: item?.original_price ?? null, tags: item?.tags, relaciones: item?.item_relations?.length ?? 0, deals: item?.deal_ids, last_updated: item?.last_updated, tipos_precio: Array.isArray(informe[id].precios?.prices) ? informe[id].precios.prices.map(p => `${p.type}:${p.amount}${p.metadata?.promotion_type ? ':' + p.metadata.promotion_type : ''}`) : informe[id].precios?.error }));
}
mkdirSync(salida, { recursive: true });
writeFileSync(join(salida, `${cuenta.clave}-diagnostico.json`), JSON.stringify(informe, null, 2));
