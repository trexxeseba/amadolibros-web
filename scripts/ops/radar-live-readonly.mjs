import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { buildRadarAlerts } from '../../worker-sync/radar.js';

const catalogUrl = String(process.env.RADAR_CATALOG_URL || '').trim();
const outputPath = String(process.env.RADAR_LIVE_OUTPUT || 'artifacts/radar-live-readonly.json').trim();

if (!catalogUrl) {
  throw new Error('RADAR_CATALOG_URL es obligatorio.');
}

const response = await fetch(catalogUrl, {
  headers: { accept: 'application/json' },
  signal: AbortSignal.timeout(60_000),
});

if (!response.ok) {
  throw new Error(`No se pudo leer el catálogo productivo: HTTP ${response.status}.`);
}

const catalog = await response.json();
if (!catalog || !Array.isArray(catalog.items)) {
  throw new Error('El catálogo productivo no tiene items[].');
}

const activeItems = catalog.items.filter(item => item?.status === 'active');
if (activeItems.length === 0) {
  throw new Error('El catálogo productivo no contiene publicaciones activas.');
}

// Corrida deliberadamente read-only y parcial: usa únicamente el catálogo
// productivo público. No consulta D1, KV, secretos, publicaciones pausadas ni
// Mercado Libre autenticado. Es una prueba con datos reales de las señales que
// pueden validarse sin credenciales: stock activo e ISBN faltante.
const alerts = buildRadarAlerts({
  activeItems,
  pausedItems: [],
  waitlistCounts: new Map(),
});

const supportedTypes = new Set(['REPOSICION_URGENTE', 'AGOTADO', 'CORREGIR_ISBN']);
const liveAlerts = alerts.filter(alert => supportedTypes.has(alert.alert_type));
const severityRank = { high: 3, medium: 2, low: 1 };

liveAlerts.sort((a, b) =>
  (Number(b.score) || 0) - (Number(a.score) || 0) ||
  (severityRank[b.severity] || 0) - (severityRank[a.severity] || 0) ||
  String(a.title || '').localeCompare(String(b.title || ''), 'es')
);

const counts = {};
const items = {};
for (const type of supportedTypes) {
  const matches = liveAlerts.filter(alert => alert.alert_type === type);
  counts[type] = matches.length;
  items[type] = matches.slice(0, 30);
}

const report = {
  generated_at: new Date().toISOString(),
  source: {
    catalog_url: catalogUrl,
    catalog_updated_at: catalog.updated_at || null,
    catalog_total: Number(catalog.total) || catalog.items.length,
    active_items_observed: activeItems.length,
  },
  mode: 'read_only_public_catalog',
  limitations: [
    'No incluye publicaciones pausadas: requieren lectura autenticada de Mercado Libre.',
    'No incluye stock_waitlist real: requiere D1 productiva.',
    'No escribe radar_alerts ni ejecuta migraciones.',
    'No modifica stock, precio ni estado de publicaciones.',
  ],
  counts,
  items,
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log('RADAR AMADO — corrida real read-only sobre catálogo productivo');
console.log(`Catálogo actualizado: ${report.source.catalog_updated_at || 'sin fecha'}`);
console.log(`Publicaciones activas observadas: ${activeItems.length}`);
for (const type of supportedTypes) {
  console.log(`${type}: ${counts[type]}`);
  for (const alert of items[type].slice(0, 10)) {
    const score = alert.score == null ? '-' : alert.score;
    console.log(`  - ${alert.item_id} | score ${score} | stock ${alert.metrics?.available_quantity ?? '?'} | ${alert.title}`);
  }
}
console.log(`Informe: ${outputPath}`);
