#!/usr/bin/env node
// Genera functions/_shared/acertijos-data.js desde data/acertijos.json.
//   node scripts/acertijos/generar.mjs          escribe el módulo
//   node scripts/acertijos/generar.mjs --check  falla si el módulo no está al día
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const JSON_PATH = join(ROOT, 'data', 'acertijos.json');
export const MODULE_PATH = join(ROOT, 'functions', '_shared', 'acertijos-data.js');

export function render() {
    const data = JSON.parse(readFileSync(JSON_PATH, 'utf8'));
    return `// ARCHIVO GENERADO por scripts/acertijos/generar.mjs desde data/acertijos.json.\n// No editar a mano: editar el JSON y correr \`node scripts/acertijos/generar.mjs\`.\nexport default ${JSON.stringify(data)};\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const out = render();
    if (process.argv.includes('--check')) {
        const actual = readFileSync(MODULE_PATH, 'utf8');
        if (actual !== out) { console.error('acertijos-data.js no está al día con data/acertijos.json'); process.exit(1); }
        console.log('ok');
    } else {
        writeFileSync(MODULE_PATH, out);
        console.log('escrito', MODULE_PATH);
    }
}
