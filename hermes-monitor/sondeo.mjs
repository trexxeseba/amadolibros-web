// Prueba temporal de lectura (no se mergea): estado de dos publicaciones normales de Arnoia.
import {CUENTAS} from '../precio-ganador/src/config.mjs';
import {fuenteTokenD1} from '../precio-ganador/src/token.mjs';
import {crearCliente} from '../precio-ganador/src/ml.mjs';
import {CUENTA_HERMES} from './lib.mjs';
const ml=crearCliente(fuenteTokenD1(CUENTAS[CUENTA_HERMES]),{concurrencia:1});
for(const id of ['MLU1540951816','MLU1541003330']){
 const it=await ml.get('/items/'+id);
 console.log(JSON.stringify({id:it.id,status:it.status,sub_status:it.sub_status,price:it.price,available_quantity:it.available_quantity,catalog_listing:it.catalog_listing,title:it.title??it.family_name,fotos:(it.pictures||[]).map(p=>[p.size,p.max_size]),free_shipping:it.shipping?.free_shipping,health:it.health,tags:it.tags,plazo:it.sale_terms?.find(t=>t.id==='MANUFACTURING_TIME')?.value_name,permalink:it.permalink,vintage:String(it.seller_id)===CUENTAS[CUENTA_HERMES].sellerId,atributos:(it.attributes||[]).filter(a=>['AUTHOR','BOOK_PUBLISHER','GTIN','LANGUAGE'].includes(a.id)).map(a=>a.id+'='+a.value_name)}));
 await new Promise(r=>setTimeout(r,500));
}
