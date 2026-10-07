/**
 * Arma el informe semanal a partir de lo que dejaron fetch-d1 y fetch-google.
 * Un archivo faltante o roto no frena el informe: esa fuente sale «sin dato».
 * Escribe WEEKLY_OUTPUT_DIR/informe-semanal.md.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { buildWeeklyReport } from './build-report.mjs';
import { weeklyPeriods } from './periods.mjs';

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const outputDir = process.env.WEEKLY_OUTPUT_DIR || 'artifacts/weekly';
const now = process.env.WEEKLY_NOW ? new Date(process.env.WEEKLY_NOW) : new Date();
const missing = { error: 'el paso que junta los datos no terminó' };

const markdown = buildWeeklyReport({
  periods: weeklyPeriods(now),
  d1: await readJson(path.join(outputDir, 'd1.json'), {
    orders: missing, events: missing, items: missing, waitlist: missing,
    search_misses: missing, sync_log: missing, sync_latest: missing, sync_first: missing,
  }),
  ga4: await readJson(path.join(outputDir, 'ga4.json'), missing),
  gsc: await readJson(path.join(outputDir, 'gsc.json'), missing),
  now,
});

await writeFile(path.join(outputDir, 'informe-semanal.md'), markdown);
console.log(markdown);
