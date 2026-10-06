/**
 * Arma «Qué pasó ayer» a partir de activity.json. Si el paso que junta los
 * datos no terminó, el informe sale igual diciendo «sin dato».
 * Escribe DAILY_OUTPUT_DIR/actividad.md.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { buildActivityReport } from './build-activity.mjs';
import { dailyPeriods } from './fetch-activity.mjs';

const outputDir = process.env.DAILY_OUTPUT_DIR || 'artifacts/commerce';
const missing = { error: 'el paso que junta los datos no terminó' };
let data;
try {
  data = JSON.parse(await readFile(path.join(outputDir, 'activity.json'), 'utf8'));
} catch {
  data = { periods: dailyPeriods(new Date()), ga4: missing, d1: { orders: missing, items: missing, events: missing, waitlist: missing, search_misses: missing } };
}
const markdown = buildActivityReport(data);
await mkdir(outputDir, { recursive: true });
await writeFile(path.join(outputDir, 'actividad.md'), markdown);
console.log(markdown);
