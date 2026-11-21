// Genera functions/_shared/regalos-data.js desde data/regalos.json (las
// Pages Functions no importan JSON). Correr tras editar la lista:
//   node scripts/regalos/armar-modulo.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const data = JSON.parse(readFileSync(resolve(root, 'data/regalos.json'), 'utf8'));
const out = `// ARCHIVO GENERADO por scripts/regalos/armar-modulo.mjs desde data/regalos.json.\n// No editar a mano: editar el JSON y correr \`node scripts/regalos/armar-modulo.mjs\`.\nexport default ${JSON.stringify(data)};\n`;
writeFileSync(resolve(root, 'functions/_shared/regalos-data.js'), out);
console.log(`regalos-data.js: ${data.lista.ids.length} ids`);
