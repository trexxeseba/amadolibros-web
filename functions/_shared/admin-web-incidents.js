const source = 'Avisos externos · registro de incidentes';
const missing = reason => ({ status: 'unavailable', source, reason });
export async function readWebIncidents(env, now = new Date()) {
  if (!env.ADMIN_WEB_MONITOR_DB || !['preview', 'production'].includes(env.ADMIN_WEB_MONITOR_ENV))
    return missing('Receptor externo pendiente de conexión.');
  try {
    // Orden por momento de la observación, no por llegada. Un aviso viejo no reabre una recuperación nueva.
    // Ante hora idéntica y estados contradictorios, prevalece la falla.
    const result = await env.ADMIN_WEB_MONITOR_DB.prepare(`WITH events AS (
      SELECT check_id,component,page_path,state,occurred_at,received_at,
        ROW_NUMBER() OVER(PARTITION BY check_id ORDER BY occurred_at DESC,
          CASE state WHEN 'confirmed' THEN 2 WHEN 'degraded' THEN 1 ELSE 0 END DESC, delivery_id DESC) AS position,
        MIN(occurred_at) OVER(PARTITION BY check_id) AS first_observed,
        COUNT(*) OVER(PARTITION BY check_id) AS event_count
      FROM monitor_events WHERE environment = ? AND occurred_at <= ?
    ) SELECT * FROM events WHERE position = 1 AND (state != 'recovered' OR occurred_at >= ?)
      ORDER BY CASE state WHEN 'recovered' THEN 1 ELSE 0 END, occurred_at DESC LIMIT 50`)
      .bind(env.ADMIN_WEB_MONITOR_ENV, new Date(now.getTime() + 60000).toISOString(), new Date(now.getTime() - 30 * 86400000).toISOString()).all();
    if (result.success === false || !Array.isArray(result.results)) return missing('No se pudo consultar el registro de incidentes.');
    const rows = result.results.map(r => {
      if (!['confirmed', 'degraded', 'recovered'].includes(r.state) || !['portadas', 'banners', 'navegacion', 'catalogo', 'sync', 'google_imagen'].includes(r.component) ||
          ![r.occurred_at, r.received_at, r.first_observed].every(x => Number.isFinite(Date.parse(x))) ||
          typeof r.page_path !== 'string' || r.page_path.length > 300 || !/^\/[a-zA-Z0-9_/-]*$/.test(r.page_path) || r.page_path.startsWith('//') ||
          !Number.isSafeInteger(r.event_count) || r.event_count < 1) throw new Error('INCIDENT_SHAPE');
      return { component: r.component, path: r.page_path, state: r.state, occurredAt: new Date(r.occurred_at).toISOString(),
        receivedAt: new Date(r.received_at).toISOString(), firstObserved: new Date(r.first_observed).toISOString(), events: r.event_count };
    });
    return { status: 'ok', source, environment: env.ADMIN_WEB_MONITOR_ENV, rows,
      note: 'Hasta 50 comprobaciones, priorizando fallas abiertas aunque sean antiguas. Recuperados: 30 días. Registros: historial conservado, sin duplicados. Sin avisos no prueba que la web esté sana; cada recuperación corresponde al recurso o recorrido comprobado.' };
  } catch { return missing('No se pudo consultar el registro de incidentes.'); }
}
