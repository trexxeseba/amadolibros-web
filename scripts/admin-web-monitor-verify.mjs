// Verificación remota de sólo lectura. Sólo imprime evidencia técnica acotada.
import { adminCloudflare } from './admin-web-cloudflare.mjs';
import { normalizeMonitorRegistry, readMonitorCoverage } from '../functions/_shared/admin-web-coverage.js';
import { readWebIncidents } from '../functions/_shared/admin-web-incidents.js';
import { coveragePanel, incidentPanel } from '../functions/_shared/admin-web-view.js';
const cf = adminCloudflare();
try {
  const settings = await cf.request('/workers/scripts/amadolibros-admin-preview/settings');
  const bindings = settings.bindings || [];
  const binding = name => bindings.find(b => b.name === name);
  const db = binding('ADMIN_WEB_MONITOR_DB');
  if (db?.type !== 'd1' || !/^[a-f0-9-]{36}$/.test(db.id || '') || db.id === binding('ORDERS_DB')?.id)
    throw new Error('MONITOR_BINDING_UNVERIFIED');
  const registry = binding('ADMIN_WEB_MONITOR_CHECKS_JSON')?.text;
  normalizeMonitorRegistry(registry);
  if (binding('ADMIN_WEB_MONITOR_ENV')?.text !== 'production' || binding('CHECKLY_API_KEY')?.type !== 'secret_text')
    throw new Error('MONITOR_PRIVATE_CONFIG_UNVERIFIED');
  const env = { CHECKLY_API_KEY: process.env.CHECKLY_API_KEY, ADMIN_WEB_MONITOR_CHECKS_JSON: registry,
    ADMIN_WEB_MONITOR_ENV: 'production', ADMIN_WEB_MONITOR_DB: { prepare(sql) {
      if (!/^WITH events AS/.test(sql)) throw new Error('MONITOR_SQL_FORBIDDEN');
      return { bind(...params) { return { async all() {
        const result = await cf.request(`/d1/database/${db.id}/query`, { method: 'POST', body: { sql, params } });
        return result[0];
      } }; } };
    } } };
  const now = new Date();
  const [coverage, incidents] = await Promise.all([readMonitorCoverage(env, now), readWebIncidents(env, now)]);
  if (coverage.status !== 'ok' || coverage.rows.some(r => !['passed','confirmed','degraded'].includes(r.state)) || incidents.status !== 'ok')
    throw new Error('MONITOR_READERS_UNVERIFIED');
  const html = coveragePanel(coverage) + incidentPanel(incidents);
  if (!html.includes('Controles automáticos') || !html.includes('Avisos de los monitores') || html.includes(process.env.CHECKLY_API_KEY))
    throw new Error('MONITOR_VIEW_UNVERIFIED');
  console.log(JSON.stringify({ status: 'private_monitor_connection_verified', privateBindingsVerified: true,
    readersVerified: true, panelSectionsRendered: true, observedAt: now.toISOString(),
    checks: coverage.rows.map(r => ({ component: r.component, state: r.state, checkedAt: r.checkedAt, frequencyMinutes: r.frequency })),
    storedIncidentStates: incidents.rows.map(r => ({ component: r.component, state: r.state })), businessWrites: 0 }));
} catch (error) {
  console.error(/^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'MONITOR_VERIFICATION_FAILED');
  process.exitCode = 1;
}
