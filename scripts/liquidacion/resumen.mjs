#!/usr/bin/env node
/**
 * Cuenta cuántos libros de la lista sobreviven a cada exclusión automática y
 * lo agrega a data/liquidacion-resumen.json. Solo conteos: el repo es público.
 *
 *   node scripts/liquidacion/resumen.mjs --catalogo catalog.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { liquidationList, selectFromList } from '../../functions/_shared/liquidacion.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA_PATH = join(ROOT, 'data', 'liquidacion.json');
const SUMMARY_PATH = join(ROOT, 'data', 'liquidacion-resumen.json');

export function resumenFinal(items, data) {
    const list = liquidationList(data);
    if (!list) return { lista: 0, elegibles: 0, excluidos: null };
    const { selected, excluded } = selectFromList(items, list);
    return { lista: list.ids.size, elegibles: selected.length, excluidos: excluded };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const idx = process.argv.indexOf('--catalogo');
    if (idx < 0) throw new Error('falta --catalogo archivo.json');
    const catalog = JSON.parse(readFileSync(process.argv[idx + 1], 'utf8'));
    const data = JSON.parse(readFileSync(DATA_PATH, 'utf8'));
    const resumen = JSON.parse(readFileSync(SUMMARY_PATH, 'utf8'));
    resumen.tras_exclusiones = resumenFinal(catalog.items ?? [], data);
    writeFileSync(SUMMARY_PATH, `${JSON.stringify(resumen, null, 2)}\n`);
    console.log(JSON.stringify(resumen));
}
