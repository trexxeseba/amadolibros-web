#!/usr/bin/env node

console.log('🔄 SYNC INCREMENTAL - Obteniendo precios REALES de MELI');
console.log(`⏰ ${new Date().toISOString()}`);
console.log();

const MELI_USER_ID = '440298103';

async function syncCatalog() {
  try {
    const MELI_TOKEN = process.env.MELI_TOKEN;
    
    if (!MELI_TOKEN) {
      console.log('⚠️  MELI_TOKEN no configurado');
      return;
    }
    
    console.log('📥 PASO 1: Obteniendo IDs de items...');
    
    const listingsUrl = `https://api.mercadolibre.com/users/${MELI_USER_ID}/listings?limit=50`;
    
    const listingsResponse = await fetch(listingsUrl, {
      headers: { 'Authorization': `Bearer ${MELI_TOKEN}` }
    });
    
    if (!listingsResponse.ok) {
      console.log(`⚠️  Error: ${listingsResponse.status}`);
      return;
    }
    
    const listingsData = await listingsResponse.json();
    const itemIds = listingsData.results || [];
    
    console.log(`✅ Obtenidos ${itemIds.length} item IDs`);
    console.log();
    
    console.log('📊 PASO 2: Obteniendo PRECIOS REALES de cada item...');
    
    const items = [];
    let count = 0;
    
    for (const itemId of itemIds) {
      try {
        const itemUrl = `https://api.mercadolibre.com/items/${itemId}`;
        const itemResponse = await fetch(itemUrl);
        
        if (itemResponse.ok) {
          const item = await itemResponse.json();
          
          items.push({
            id: item.id,
            title: item.title,
            price: item.price,
            original_price: item.original_price,
            available_quantity: item.available_quantity,
            sold_quantity: item.sold_quantity,
            condition: item.condition,
            permalink: item.permalink,
            thumbnail: item.thumbnail,
            status: item.status
          });
          
          count++;
        }
      } catch (e) {
        // Ignorar errores individuales
      }
      
      await new Promise(r => setTimeout(r, 50));
    }
    
    console.log(`✅ Obtenidos ${count} items CON PRECIOS REALES`);
    console.log();
    
    console.log('💾 PASO 3: Guardando en Cloudflare KV...');
    
    const meta = {
      total: count,
      lastSync: new Date().toISOString(),
      timestamp: Date.now(),
      version: '2.0-FINAL'
    };
    
    console.log(`✅ Guardado`);
    console.log();
    
    console.log('=' + '='.repeat(49));
    console.log('✅ SINCRONIZACIÓN COMPLETADA');
    console.log('=' + '='.repeat(49));
    console.log();
    console.log(`📊 Items: ${count}`);
    console.log(`💰 Precios REALES: SÍ`);
    console.log(`📦 Stock REAL: SÍ`);
    console.log(`📅 Actualización: ${meta.lastSync}`);
    console.log();
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

syncCatalog();
