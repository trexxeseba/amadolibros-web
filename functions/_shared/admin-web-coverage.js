const ACCOUNT = '8ff2dfcb-7cf5-4962-9eab-c6dde8763c0d';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const source = 'Checkly · última ejecución de cada control';
const absent = reason => ({ status: 'unavailable', source, reason });
export function normalizeMonitorRegistry(value) {
  const rows = Object.entries(typeof value === 'string' ? JSON.parse(value) : value || {});
  if (rows.length !== 3 || rows.some(([id, c]) => !UUID.test(id) || c?.environment !== 'production' ||
      !['sync','catalogo','portadas'].includes(c.component) || ![10,120].includes(c.frequency) ||
      !['/api/status','/catalogo','/'].includes(c.path))) throw new Error('MONITOR_REGISTRY_INVALID');
  const expected = { sync: ['/api/status',10], catalogo: ['/catalogo',10], portadas: ['/',120] };
  if (new Set(rows.map(([,c]) => c.component)).size !== 3 || rows.some(([,c]) => c.path !== expected[c.component][0] || c.frequency !== expected[c.component][1]))
    throw new Error('MONITOR_REGISTRY_INVALID');
  return rows;
}
export async function readMonitorCoverage(env, now = new Date(), fetchFn = fetch) {
  if (!env.ADMIN_WEB_MONITOR_CHECKS_JSON || !env.CHECKLY_API_KEY) return absent('Monitores pendientes de conexión.');
  try {
    const registry = normalizeMonitorRegistry(env.ADMIN_WEB_MONITOR_CHECKS_JSON);
    const request = async path => {
      const r = await fetchFn(`https://api.checklyhq.com${path}`, { redirect: 'manual', signal: AbortSignal.timeout(8000),
        headers: { Authorization: `Bearer ${env.CHECKLY_API_KEY}`, 'X-Checkly-Account': ACCOUNT, Accept: 'application/json' } });
      if (!r.ok) throw new Error('CHECKLY_UNAVAILABLE'); return r.json();
    };
    const definitions = await request('/v1/checks');
    if (!Array.isArray(definitions)) throw new Error('CHECKLY_INVALID');
    const rows = await Promise.all(registry.map(async ([id, check]) => {
      const base = { component: check.component, path: check.path, frequency: check.frequency, checkedAt: null, state: 'unknown' };
      try {
        const current = definitions.find(c => c.id === id);
        if (!current || current.activated !== true) return { ...base, state: 'paused' };
        if (current.frequency !== check.frequency) return base;
        const results = await request(`/v2/check-results/${id}?limit=1&resultType=FINAL&fields=checkId,hasFailures,hasErrors,isDegraded,isCancelled,startedAt`);
        const result = results.entries?.[0]; const stamp = Date.parse(result?.startedAt);
        if (!result || result.checkId !== id || !Number.isFinite(stamp) || stamp > now.getTime() + 60000 ||
            ![result.hasFailures,result.hasErrors].every(v => typeof v === 'boolean')) return base;
        const stale = now.getTime() - stamp > (check.frequency * 2 + 5) * 60000;
        return { ...base, checkedAt: new Date(stamp).toISOString(), state: stale ? 'stale' : result.isCancelled ? 'unknown' :
          result.hasErrors ? 'monitor_error' : result.hasFailures ? 'confirmed' : result.isDegraded ? 'degraded' : 'passed' };
      } catch { return base; }
    }));
    return { status: 'ok', source, rows, observedAt: now.toISOString(),
      note: 'API cada 10 minutos. Navegador cada 2 horas: inicio, catálogo y una ficha; imágenes visibles y errores detectados en ese recorrido. No comprueba todas las fotos, dispositivos ni el pago. Los avisos se guardan automáticamente; recargar consulta la última ejecución.' };
  } catch { return absent('No se pudo comprobar la actividad de los monitores.'); }
}
