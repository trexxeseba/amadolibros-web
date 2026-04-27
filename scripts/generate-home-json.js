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

const CATALOG_URL    = 'https://pub-b2b408811ae24e3da04cda79c6ff084d.r2.dev/catalog.json';
const OUTPUT_PATH    = path.join(__dirname, '..', 'public', 'home.json');
const INDEX_PATH     = path.join(__dirname, '..', 'public', 'index.html');
const ACTIVE_COUNT   = 40;   // items activos más recientes para la grilla y novedades
const NOSCRIPT_COUNT = 50;   // links estáticos inyectados en el bloque <noscript> de index.html
// Nota: PAUSED_COUNT eliminado. El catálogo actual tiene 0 items pausados/sin stock.
// Si en el futuro vuelven items pausados, volver a agregar esta lógica.

// CRÍTICO: idéntico al slugify de functions/libro/[[path]].js, catalogo.js, sitemap.xml.js
function slugify(text) {
    return (text || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 60);
}

function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

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

    // ── Patch index.html: inyectar links estáticos en el bloque <noscript> ────
    // Usa los primeros NOSCRIPT_COUNT items activos (misma fuente que home.json).
    // Divide en dos secciones: Novedades (mitad) + Libros más vendidos (resto).
    // El bloque reemplaza el contenido entre <!-- NOSCRIPT:BEGIN --> y <!-- NOSCRIPT:END -->.
    const noscriptItems = items
        .filter(b => b.status === 'active' && b.available_quantity > 0)
        .sort((a, b) => new Date(b.start_time || 0) - new Date(a.start_time || 0))
        .slice(0, NOSCRIPT_COUNT);

    const half   = Math.ceil(noscriptItems.length / 2);
    const newest = noscriptItems.slice(0, half);
    const rest   = noscriptItems.slice(half);

    const toLinks = arr => arr.map(b =>
        `        <li><a href="/libro/${b.id}/${slugify(b.title)}">${escapeHtml(b.title)}</a></li>`
    ).join('\n');

    const noscriptBlock = [
        '<!-- NOSCRIPT:BEGIN — regenerado por scripts/generate-home-json.js en cada deploy -->',
        '    <noscript>',
        '        <div style="max-width:900px;margin:2rem auto;padding:1rem;font-family:sans-serif">',
        '            <h1>Amado Libros — Librería Online en Uruguay</h1>',
        '            <p>16.000+ títulos disponibles. Envíos a todo Uruguay en 24 a 48hs hábiles. Descuento del 12% pagando con transferencia.</p>',
        '            <h2 style="margin-top:1.5rem;font-size:1.1rem">Novedades</h2>',
        '            <ul style="columns:2;gap:2rem;list-style:disc;padding-left:1.5rem;line-height:1.9;font-size:.9rem">',
        toLinks(newest),
        '            </ul>',
        '            <h2 style="margin-top:1.5rem;font-size:1.1rem">Libros más vendidos</h2>',
        '            <ul style="columns:2;gap:2rem;list-style:disc;padding-left:1.5rem;line-height:1.9;font-size:.9rem">',
        toLinks(rest),
        '            </ul>',
        '            <p style="margin-top:1.5rem">Ver el <a href="/catalogo">catálogo completo de libros</a> · <a href="/politicas">políticas de envío</a> · <a href="https://wa.me/59899841325">WhatsApp 099 841 325</a></p>',
        '        </div>',
        '    </noscript>',
        '    <!-- NOSCRIPT:END -->',
    ].join('\n');

    const indexHtml = fs.readFileSync(INDEX_PATH, 'utf8');
    const patched   = indexHtml.replace(
        /<!-- NOSCRIPT:BEGIN[\s\S]*?<!-- NOSCRIPT:END -->/,
        noscriptBlock
    );

    if (patched === indexHtml) {
        console.warn('⚠️  No se encontró el marcador NOSCRIPT:BEGIN/END en index.html — bloque no actualizado');
    } else {
        fs.writeFileSync(INDEX_PATH, patched);
        console.log(`✅ index.html noscript actualizado: ${noscriptItems.length} enlaces (${newest.length} novedades + ${rest.length} más vendidos)`);
    }
}

main().catch(err => {
    console.error('❌ Error generando home.json:', err.message);
    process.exit(1);
});
