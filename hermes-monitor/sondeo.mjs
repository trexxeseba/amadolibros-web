// Prueba temporal de lectura: estado de la primera publicación (no se mergea).
import {CUENTAS} from '../precio-ganador/src/config.mjs';
import {fuenteTokenD1} from '../precio-ganador/src/token.mjs';
import {crearCliente} from '../precio-ganador/src/ml.mjs';
const ml=crearCliente(fuenteTokenD1(CUENTAS.libros),{concurrencia:1});
const it=await ml.get('/items/MLU1540288110');
console.log(JSON.stringify({id:it.id,status:it.status,sub_status:it.sub_status,price:it.price,available_quantity:it.available_quantity,catalog_listing:it.catalog_listing,catalog_product_id:it.catalog_product_id,listing_type_id:it.listing_type_id,free_shipping:it.shipping?.free_shipping,mode:it.shipping?.mode,health:it.health,title:it.title??it.family_name,tags:it.tags,permalink:it.permalink,seller_ok:String(it.seller_id)===CUENTAS.libros.sellerId}));
