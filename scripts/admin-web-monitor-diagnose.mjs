// Diagnóstico de sólo lectura, sin imprimir payloads, nombres, direcciones ni credenciales.
import { adminCloudflare } from './admin-web-cloudflare.mjs';
import { checklyApi, dedicatedMonitorDb } from './admin-web-monitor-connect.mjs';
const cf = adminCloudflare(); const api = checklyApi();
const stamp = x => Number.isFinite(Date.parse(x)) ? new Date(x).toISOString() : null;
try {
  const checks = (await api('/v1/checks')).filter(c => c.tags?.includes('amado-admin-web-v1'));
  const settings = await cf.request('/workers/scripts/amadolibros-web-monitor/settings');
  const get = name => settings.bindings?.find(b => b.name === name);
  console.log(JSON.stringify({ status: 'receiver_metadata', enabled: get('MONITOR_ENABLED')?.text === 'true',
    environment: ['preview','production'].includes(get('MONITOR_ENV')?.text) ? get('MONITOR_ENV').text : null,
    fixtureMode: ['failure','recovery'].includes(get('MONITOR_ACCEPTANCE_MODE')?.text) ? get('MONITOR_ACCEPTANCE_MODE').text : null,
    secretPresent: get('CHECKLY_WEBHOOK_SECRET')?.type === 'secret_text', limiterPresent: !!get('MONITOR_RATE_LIMITER') }));
  const db = await dedicatedMonitorDb(cf);
  if (!db) throw new Error('MONITOR_DATABASE_MISSING');
  for (const [probe,sql,params] of [
    ['plain_read','SELECT state FROM monitor_events LIMIT 1',[]],
    ['bound_read','SELECT state FROM monitor_events WHERE delivery_id IN (?,?,?)',['diagnostic-a','diagnostic-b','diagnostic-c']],
    ['fixture_states',"SELECT state,COUNT(*) AS total FROM monitor_events WHERE environment = 'preview' GROUP BY state",[]],
  ]) {
    try {
      const result = await cf.request(`/d1/database/${db.id}/query`, { method:'POST', body:{sql,params} });
      console.log(JSON.stringify({ status:'monitor_database_probe',probe,ok:result[0]?.success !== false,
        ...(probe === 'fixture_states' ? { states: (result[0]?.results || []).map(r=>({state:['confirmed','degraded','recovered'].includes(r.state)?r.state:null,total:Number(r.total)})) } : {}) }));
    } catch(error) { console.log(JSON.stringify({status:'monitor_database_probe',probe,error:/^[A-Z0-9_]+$/.test(error.message)?error.message:'PROBE_FAILED'})); }
  }
  for (const c of checks) {
    const result = await api(`/v2/check-results/${c.id}?limit=3&resultType=FINAL&fields=checkId,hasFailures,hasErrors,isCancelled,startedAt,apiCheckResult,browserCheckResult`);
    const browserCodes = r => {
      const text = JSON.stringify([r.browserCheckResult?.errors,r.browserCheckResult?.jobLog]);
      return ['PAGINA_SIN_FOTOS_DE_CONTENIDO','IMAGEN_VISIBLE_NO_CARGA','FOTO_FALLIDA_O_LENTA_AUN_CON_LOGO_DE_REEMPLAZO',
        'FONDO_O_BANNER_VISIBLE_NO_CARGA','PAGINA_NO_DISPONIBLE','REDIRECCION_INESPERADA','CONTENIDO_PRINCIPAL_AUSENTE',
        'CATALOGO_SIN_FICHAS','ERROR_JAVASCRIPT_EN_RECORRIDO','__name is not defined','Timeout'].filter(code => text.includes(code));
    };
    console.log(JSON.stringify({ status:'monitor_check_diagnostic',fixture:c.request?.url?.endsWith('/_monitor-test') === true,
      activated:c.activated === true,frequency:c.frequency,subscriptions:c.alertChannelSubscriptions?.length,
      runs:(result.entries || []).map(r=>({matchedCheck:r.checkId===c.id,startedAt:stamp(r.startedAt),failed:r.hasFailures,monitorError:r.hasErrors,
        cancelled:r.isCancelled,httpStatus:Number.isInteger(r.apiCheckResult?.response?.status)?r.apiCheckResult.response.status:null,
        requestError:!!r.apiCheckResult?.requestError,browserCodes:browserCodes(r)})) }));
  }
} catch(error) { console.error(/^[A-Z0-9_]+$/.test(error.message)?error.message:'MONITOR_DIAGNOSE_FAILED');process.exitCode=1; }
