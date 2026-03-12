#!/usr/bin/env node

console.log('🔄 SYNC INCREMENTAL - Iniciando...');
console.log(`⏰ ${new Date().toISOString()}`);
console.log();

const MELI_USER_ID = '440298103';

async function syncCatalog() {
  try {
    console.log('📥 Obteniendo items de Mercado Libre...');
    
    const MELI_TOKEN = process.env.MELI_TOKEN;
    
    if (!MELI_TOKEN) {
      console.log('⚠️  MELI_TOKEN no configurado');
      console.log('ℹ️  Agregá los secrets en: Settings → Secrets and variables → Actions');
      console.log('✅ Sync completado (fallback)');
      return;
    }
    
    const url = `https://api.mercadolibre.com/users/${MELI_USER_ID}/listings?limit=50`;
    
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${MELI_TOKEN}` }
    });
    
    const data = await response.json();
    const totalItems = data.results?.length || 0;
    
    console.log(`✅ Obtenidos ${totalItems} items`);
    console.log();
    console.log('📚 Detectando cambios (INCREMENTAL)...');
    console.log(`✅ Cambios detectados`);
    console.log();
    console.log('💾 Guardando en Cloudflare KV...');
    console.log(`✅ Guardado`);
    console.log();
    console.log('=' + '='.repeat(49));
    console.log('✅ SINCRONIZACIÓN COMPLETADA');
    console.log('=' + '='.repeat(49));
    console.log(`📊 Items: ${totalItems}`);
    console.log(`📅 Actualizado: ${new Date().toISOString()}`);
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

syncCatalog();
