/**
 * Amado Libros - Sync Incremental
 * Sincroniza catálogo desde Mercado Libre a Cloudflare KV
 * Solo actualiza items que cambiaron (precio, stock, etc)
 */

const MELI_USER_ID = '440298103'; // AMADO LIBROS
const MELI_TOKEN = process.env.MELI_TOKEN;
const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const KV_NAMESPACE_ID = '6ea0ff4682d647118442a24fe384abc4';

const timestamp = new Date().toISOString();

console.log(`\n${'='.repeat(100)}`);
console.log('🔄 SYNC INCREMENTAL - AMADOLIBROS.COM');
console.log(`${'='.repeat(100)}`);
console.log(`⏰ Timestamp: ${timestamp}\n`);

/**
 * Obtener items de Mercado Libre usando search_type=scan
 * Esto evita el límite de offset de 1000 items
 */
async function getItemsFromMELI() {
  console.log('📋 PASO 1: Obteniendo items de Mercado Libre...');
  
  try {
    let allItems = [];
    let scrollId = null;
    let totalProcessed = 0;
    
    // Primera request
    let url = `https://api.mercadolibre.com/users/${MELI_USER_ID}/listings?search_type=scan`;
    
    while (url && totalProcessed < 10000) { // Límite de seguridad
      console.log(`   📍 Fetch: ${url.substring(0, 80)}...`);
      
      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${MELI_TOKEN}` }
      });
      
      if (!response.ok) {
        throw new Error(`MELI API error: ${response.status} ${response.statusText}`);
      }
      
      const data = await response.json();
      
      // Procesar items
      if (data.results) {
        for (const itemId of data.results) {
          try {
            // Obtener detalle completo del item
            const itemResponse = await fetch(
              `https://api.mercadolibre.com/items/${itemId}`,
              { headers: { 'Authorization': `Bearer ${MELI_TOKEN}` } }
            );
            
            if (itemResponse.ok) {
              const item = await itemResponse.json();
              
              allItems.push({
                id: item.id,
                title: item.title,
                price: item.price,
                currency_id: item.currency_id,
                available_quantity: item.available_quantity,
                sold_quantity: item.sold_quantity,
                status: item.status,
                permalink: item.permalink,
                thumbnail: item.thumbnail,
                condition: item.condition,
                updated_at: new Date().toISOString()
              });
              
              totalProcessed++;
            }
          } catch (e) {
            console.log(`   ⚠️  Error obteniendo item ${itemId}: ${e.message}`);
          }
        }
      }
      
      // Siguiente página
      if (data.paging && data.paging.next) {
        url = data.paging.next;
      } else {
        url = null;
      }
      
      console.log(`   ✅ Procesados: ${totalProcessed} items`);
    }
    
    console.log(`\n✅ Total items obtenidos de MELI: ${allItems.length}`);
    return allItems;
    
  } catch (error) {
    console.error(`❌ Error obteniendo items: ${error.message}`);
    throw error;
  }
}

/**
 * Obtener catálogo actual de Cloudflare KV
 */
async function getCatalogFromKV() {
  console.log('\n📋 PASO 2: Obteniendo catálogo anterior de Cloudflare KV...');
  
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/catalog`,
      {
        headers: { 'X-Auth-Key': CLOUDFLARE_API_TOKEN, 'X-Auth-Email': 'undiaes@gmail.com' }
      }
    );
    
    if (response.ok) {
      const text = await response.text();
      const catalog = JSON.parse(text);
      console.log(`✅ Catálogo anterior: ${Object.keys(catalog).length} items`);
      return catalog;
    } else {
      console.log('⚠️  Catálogo anterior no existe (primera sincronización)');
      return {};
    }
  } catch (error) {
    console.error(`❌ Error obteniendo catálogo: ${error.message}`);
    return {};
  }
}

/**
 * Detectar cambios entre catálogo nuevo y anterior
 * SYNC INCREMENTAL: solo lo que cambió
 */
function detectChanges(newItems, oldCatalog) {
  console.log('\n📋 PASO 3: Detectando cambios (SYNC INCREMENTAL)...');
  
  const changes = {
    updated: [],
    new: [],
    removed: []
  };
  
  const newCatalog = {};
  
  // Procesar items nuevos y actualizados
  for (const item of newItems) {
    newCatalog[item.id] = item;
    
    const oldItem = oldCatalog[item.id];
    
    if (!oldItem) {
      // Item nuevo
      changes.new.push(item);
      console.log(`   ✨ NUEVO: ${item.title} - $${item.price}`);
      
    } else if (
      oldItem.price !== item.price ||
      oldItem.available_quantity !== item.available_quantity ||
      oldItem.sold_quantity !== item.sold_quantity ||
      oldItem.status !== item.status
    ) {
      // Item actualizado
      changes.updated.push({
        id: item.id,
        title: item.title,
        changes: {
          price: { old: oldItem.price, new: item.price },
          available: { old: oldItem.available_quantity, new: item.available_quantity },
          sold: { old: oldItem.sold_quantity, new: item.sold_quantity },
          status: { old: oldItem.status, new: item.status }
        }
      });
      console.log(`   🔄 ACTUALIZADO: ${item.title}`);
      if (oldItem.price !== item.price) {
        console.log(`      Precio: $${oldItem.price} → $${item.price}`);
      }
    }
  }
  
  // Items eliminados
  for (const oldId of Object.keys(oldCatalog)) {
    if (!newCatalog[oldId]) {
      changes.removed.push(oldId);
      console.log(`   ❌ REMOVIDO: ${oldId}`);
    }
  }
  
  console.log(`\n📊 Resumen de cambios:`);
  console.log(`   ✨ Nuevos: ${changes.new.length}`);
  console.log(`   🔄 Actualizados: ${changes.updated.length}`);
  console.log(`   ❌ Removidos: ${changes.removed.length}`);
  
  return { changes, newCatalog };
}

/**
 * Guardar catálogo actualizado en Cloudflare KV
 */
async function saveCatalogToKV(catalog) {
  console.log('\n📋 PASO 4: Guardando catálogo en Cloudflare KV...');
  
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/catalog`,
      {
        method: 'PUT',
        headers: {
          'X-Auth-Key': CLOUDFLARE_API_TOKEN,
          'X-Auth-Email': 'undiaes@gmail.com',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(catalog)
      }
    );
    
    if (response.ok) {
      console.log(`✅ Catálogo guardado: ${Object.keys(catalog).length} items`);
      return true;
    } else {
      throw new Error(`KV write error: ${response.status}`);
    }
  } catch (error) {
    console.error(`❌ Error guardando: ${error.message}`);
    return false;
  }
}

/**
 * Guardar meta.json con timestamp y estadísticas
 */
async function saveMeta(catalog, changes) {
  console.log('\n📋 PASO 5: Guardando meta.json...');
  
  try {
    const meta = {
      timestamp: timestamp,
      total_items: Object.keys(catalog).length,
      changes: {
        new: changes.new.length,
        updated: changes.updated.length,
        removed: changes.removed.length
      },
      last_sync: timestamp,
      status: 'success'
    };
    
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/meta.json`,
      {
        method: 'PUT',
        headers: {
          'X-Auth-Key': CLOUDFLARE_API_TOKEN,
          'X-Auth-Email': 'undiaes@gmail.com',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(meta)
      }
    );
    
    if (response.ok) {
      console.log(`✅ Meta.json guardado`);
      console.log(`   Total items: ${meta.total_items}`);
      console.log(`   Cambios: ${meta.changes.new + meta.changes.updated}`);
      return true;
    } else {
      throw new Error(`Meta write error: ${response.status}`);
    }
  } catch (error) {
    console.error(`❌ Error guardando meta: ${error.message}`);
    return false;
  }
}

/**
 * Main
 */
async function main() {
  try {
    // 1. Obtener items de MELI
    const meliItems = await getItemsFromMELI();
    
    // 2. Obtener catálogo anterior de KV
    const oldCatalog = await getCatalogFromKV();
    
    // 3. Detectar cambios
    const { changes, newCatalog } = detectChanges(meliItems, oldCatalog);
    
    // 4. Guardar catálogo
    await saveCatalogToKV(newCatalog);
    
    // 5. Guardar meta
    await saveMeta(newCatalog, changes);
    
    console.log(`\n${'='.repeat(100)}`);
    console.log('✅ SYNC INCREMENTAL COMPLETADO');
    console.log(`${'='.repeat(100)}`);
    console.log(`\n📊 RESULTADO FINAL:`);
    console.log(`   ✅ Items sincronizados: ${Object.keys(newCatalog).length}`);
    console.log(`   ✨ Nuevos: ${changes.new.length}`);
    console.log(`   🔄 Actualizados: ${changes.updated.length}`);
    console.log(`   ❌ Removidos: ${changes.removed.length}`);
    console.log(`   ⏰ Timestamp: ${timestamp}`);
    console.log(`\n🌐 amadolibros.com se actualizará automáticamente\n`);
    
    process.exit(0);
    
  } catch (error) {
    console.error(`\n❌ ERROR CRÍTICO: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }
}

// Ejecutar
main();
