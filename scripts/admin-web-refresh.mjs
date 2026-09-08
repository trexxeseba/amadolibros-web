import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exportAdminGa4 } from './admin-web-ga4-export.mjs';
import { WEB_HOSTS, webPeriod, validateWebAnalytics } from '../functions/_shared/admin-web-data.js';
import { adminCloudflare, adminAnalyticsNamespace } from './admin-web-cloudflare.mjs';

export const ADMIN_ANALYTICS_KEY = 'preview:ga4:web:v2';

export function adminAnalyticsBundle(snapshots, now = new Date()) {
  if (!Array.isArray(snapshots) || snapshots.length !== 2) throw new Error('ADMIN_SNAPSHOTS_INCOMPLETE');
  const clean = {};
  for (const [index, days] of [7, 30].entries()) {
    const raw = snapshots[index];
    const period = webPeriod(days, now);
    const value = validateWebAnalytics(raw, period, now);
    if (!value || raw.extractedAt !== now.toISOString()) throw new Error('ADMIN_SNAPSHOT_INVALID');
    // Lista positiva: no persistir campos adicionales, credenciales ni PII.
    clean[days] = { version: 1, scope: 'web-only', property: '543434807', hosts: WEB_HOSTS,
      period: { startDate: period.startDate, endDate: period.endDate, timeZone: period.timeZone },
      extractedAt: raw.extractedAt, summary: value.summary, events: value.events,
      channels: value.channels, devices: value.devices, pages: value.pages };
  }
  return { version: 2, environment: 'preview', updatedAt: now.toISOString(), snapshots: clean };
}

export async function refreshAdminAnalytics({ env = process.env, now = new Date(), fetchFn = fetch,
  create = false, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  // Si falla cualquier informe no se modifica la última actualización válida.
  const snapshots = await Promise.all([7, 30].map(days => exportAdminGa4({ token: env.GA4_ACCESS_TOKEN, days, now, fetchFn })));
  const bundle = adminAnalyticsBundle(snapshots, now);
  const value = JSON.stringify(bundle);
  if (new TextEncoder().encode(value).length > 128000) throw new Error('ADMIN_BUNDLE_TOO_LARGE');
  const cf = adminCloudflare({ env, fetchFn });
  const namespaceId = await adminAnalyticsNamespace(cf, { create });
  const path = `/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(ADMIN_ANALYTICS_KEY)}`;
  // Un solo valor completo; conservarlo permite identificar una actualización atrasada.
  await cf.request(path, { method: 'PUT', body: value, raw: true });
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) await pause(15000);
    const stored = await cf.request(path, { raw: true });
    if (JSON.stringify(stored) === value) return { status: 'ok', updatedAt: bundle.updatedAt, periods: [7, 30] };
  }
  throw new Error('ADMIN_REFRESH_NOT_VERIFIED');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await refreshAdminAnalytics({ create: process.argv.includes('--create-preview-storage') });
    console.log(JSON.stringify(result));
  } catch (error) {
    const code = /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'ADMIN_REFRESH_FAILED';
    console.error(code); process.exitCode = 1;
  }
}
