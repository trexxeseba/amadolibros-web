import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Todo lo que se sirve al navegador: páginas Astro, componentes y scripts públicos.
// Los comentarios del código viajan en la página (ver código fuente), así que cuentan.
function files(dir, out = []) {
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
            if (!['node_modules', 'dist', '.astro', '__tests__'].includes(name)) files(path, out);
        } else if (/\.(astro|js|mjs|html|css)$/.test(name)) out.push(path);
    }
    return out;
}

const SERVIDO = [...files('astro-front/src'), ...files('astro-front/public')];
const SSR_VISIBLE = [
    'functions/liquidacion.js', 'functions/libros-agotados-importados-uruguay.js', 'functions/catalogo.js',
    'functions/libro/[[path]].js', 'functions/libros/[[path]].js', 'functions/_shared/brand.js', 'functions/_shared/site-header.js',
];

test('ninguna página ni script servido al navegador menciona el uso de inteligencia artificial', () => {
    const MENCION = /chatgpt|anthropic|openai|inteligencia artificial/i;
    const hallazgos = [...SERVIDO, ...SSR_VISIBLE].filter(path => MENCION.test(readFileSync(path, 'utf8')));
    assert.deepEqual(hallazgos, []);
});

test('el copy de marketing no usa "únicamente" ni "sólo"', () => {
    const copy = [
        ['astro-front/src/components/BookDiscovery.astro', /[Ss]ólo/],
        ['functions/_shared/seo-categories.js', /únicamente/],
        ['functions/liquidacion.js', /únicamente|[Ss]ólo/],
        ['functions/libros-agotados-importados-uruguay.js', /únicamente|[Ss]ólo/],
        ['astro-front/src/pages/pedir-libro.astro', /únicamente|[Ss]ólo/],
    ];
    for (const [path, re] of copy) assert.doesNotMatch(readFileSync(path, 'utf8'), re, path);
});

test('el documento de medición cubre los dos eventos, la acción de Ads y lo que falta', () => {
    const doc = readFileSync('docs/medicion-google-ads.md', 'utf8');
    for (const text of ['whatsapp_click', 'book_request_submitted', 'liquidacion_card', 'agotados_hero', 'principal', 'evento clave']) {
        assert.ok(doc.includes(text), text);
    }
    assert.doesNotMatch(doc, /\p{Extended_Pictographic}/u);
});
