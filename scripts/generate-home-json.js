#!/usr/bin/env node
/**
 * scripts/generate-home-json.js
 *
 * Genera public/home.json desde el catálogo completo en R2.
 * Produce un snapshot liviano (~20KB) para render inicial del home
 * sin depender del catalog.json completo (3.7MB) en la primera pantalla.
 *
 * Contenido de home.json:
 *   - Top ACTIVE_COUNT items activos (con stock), ordenados por start_time desc
 *   - Top PAUSED_COUNT items pausados (por encargo)
 *   - total: cantidad total del catálogo completo
 *   - generated_at: timestamp ISO
 *
 * Uso:
 *   node scripts/generate-home-json.js
 *
 * Se ejecuta automáticamente desde .github/workflows/deploy.yml
 * antes de cada deploy a Cloudflare Pages.
 * No requiere credenciales: lee de la URL pública de R2.
 */

const https   = require('https');
const fs      = require('fs');
const path    = require('path');

const CATALOG_URL  = 'https://pub-b2b408811ae24e3da04cda79c6ff084d.r2.dev/catalog.json';
const OUTPUT_PATH  = path.join(__dirname, '..', 'public', 'home.json');
const ACTIVE_COUNT = 40;   // la portada sigue liviana: los encargos aparecen al buscar

console.log('📚 generate-home-json: fetching catalog.json from R2...');

function fetchJSON(url) {
    return new Promise((resolve, reject) => {
        let raw = '';
        const req = https.get(url, { timeout: 30000 }, res => {
            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode} from ${url}`));
                return;
            }
            res.setEncoding('utf8');
            res.on('data', chunk => { raw += chunk; });
            res.on('end', () => {
                try   { resolve(JSON.parse(raw)); }
                catch (e) { reject(new Error('JSON parse error: ' + e.message)); }
            });
        });
        req.on('error',   reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout after 30s')); });
    });
}

async function main() {
    const catalog = await fetchJSON(CATALOG_URL);
    const items   = catalog.items || [];
    const total   = catalog.total || items.length;

    if (items.length === 0) {
        console.error('❌ catalog.json returned 0 items — aborting');
        process.exit(1);
    }

    // Top ACTIVE_COUNT items activos, ordenados por fecha de alta (más recientes primero)
    const active = items
        .filter(b => b.status === 'active' && b.available_quantity > 0)
        .sort((a, b) => new Date(b.start_time || 0) - new Date(a.start_time || 0))
        .slice(0, ACTIVE_COUNT);

    const homeData = {
        items:        active,
        total,
        generated_at: new Date().toISOString(),
    };

    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(homeData));

    const sizeKB = Math.round(Buffer.byteLength(JSON.stringify(homeData), 'utf8') / 1024);
    console.log(`✅ home.json generado:`);
    console.log(`   Items: ${homeData.items.length} activos (más recientes)`);
    console.log(`   Total catálogo: ${total.toLocaleString()} libros`);
    console.log(`   Tamaño: ~${sizeKB}KB (vs ~3700KB de catalog.json — ${Math.round(3700/sizeKB)}x más liviano)`);
    console.log(`   Archivo: ${OUTPUT_PATH}`);
}

main().catch(err => {
    console.error('❌ Error generando home.json:', err.message);
    process.exit(1);
});
