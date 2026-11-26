// Alarmas del cobro en Checkly: estado, alta de controles y simulacro de aviso.
//
//   node scripts/monitoring/checkly-cobro.mjs estado     solo lee: plan, controles, canales
//   node scripts/monitoring/checkly-cobro.mjs aplicar    crea o actualiza canales de correo y controles del cobro
//   node scripts/monitoring/checkly-cobro.mjs simulacro  control temporal que falla y se recupera, y lo borra
//
// El repositorio y los registros de Actions son públicos: acá nunca se imprime
// una casilla completa, una clave ni el cuerpo de una respuesta del proveedor.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const CHECKLY_ACCOUNT = '8ff2dfcb-7cf5-4962-9eab-c6dde8763c0d';
export const TAG_COBRO = 'amado-cobro-v1';
export const TAG_SIMULACRO = 'amado-cobro-simulacro';
export const TAG_WEB = 'amado-admin-web-v1'; // controles de septiembre (catálogo, sync, portadas)
export const SITE = 'https://www.amadolibros.com';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = (paso, extra = {}) => console.log(JSON.stringify({ paso, ...extra }));

export function maskEmail(address) {
  const [user = '', domain = ''] = String(address).split('@');
  return `${user.slice(0, 1)}***@${domain}`;
}

export function parseRecipients(wranglerToml) {
  const production = String(wranglerToml).split('[env.production.vars]')[1] || '';
  const match = production.match(/^SALES_NOTIFICATION_TO\s*=\s*"([^"]+)"/m);
  const list = (match ? match[1] : '').split(',').map(v => v.trim().toLowerCase()).filter(v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v));
  if (list.length === 0) throw new Error('DESTINATARIOS_AUSENTES');
  return list;
}

export function checklyApi({ env = process.env, fetchFn = fetch } = {}) {
  if (!env.CHECKLY_API_KEY) throw new Error('CHECKLY_KEY_REQUIRED');
  return async (path, { method = 'GET', body } = {}) => {
    if (!/^\/v[12]\/[a-z0-9/?=&,._-]+$/i.test(path)) throw new Error('CHECKLY_PATH_INVALID');
    const response = await fetchFn(`https://api.checklyhq.com${path}`, {
      method, redirect: 'manual', signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bearer ${env.CHECKLY_API_KEY}`, 'X-Checkly-Account': CHECKLY_ACCOUNT,
        Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      const message = String(error.message || error.error || '').toLowerCase();
      const reason = /limit|quota|maximum|plan|upgrade/.test(message) ? '_LIMITE_DEL_PLAN'
        : /permission|authorized|forbidden|access/.test(message) ? '_PERMISO' : '';
      throw new Error(`CHECKLY_${method}_HTTP_${response.status}${reason}`);
    }
    return response.status === 204 ? null : response.json();
  };
}

// ── Definiciones ────────────────────────────────────────────────────────────

export function emailChannel(address) {
  return { type: 'EMAIL', config: { address }, sendFailure: true, sendRecovery: true, sendDegraded: false,
    sslExpiry: false, autoSubscribe: false, subscriptions: [] };
}

function baseCheck({ name, frequency, channelIds, tag, failedRuns }) {
  return { name, activated: true, muted: false, doubleCheck: false, retryStrategy: null,
    locations: ['us-east-1'], runParallel: false, frequency, tags: [tag], useGlobalAlertSettings: false,
    alertSettings: { escalationType: 'RUN_BASED', runBasedEscalation: { failedRunThreshold: failedRuns },
      reminders: { amount: 0, interval: 5 }, sslCertificates: { enabled: false, alertThreshold: 30 } },
    alertChannelSubscriptions: channelIds.map(alertChannelId => ({ alertChannelId, activated: true })) };
}

/**
 * Controles del cobro. Ninguno crea pedidos, pide un pago ni manda datos de
 * una persona: uno lee el diagnóstico /api/checkout-health y el otro manda un
 * aviso sin firma, que el servidor tiene que rechazar con 401.
 * Dos corridas fallidas seguidas (20 min) antes de avisar: evita la falsa
 * alarma por un corte de segundos de Mercado Pago o de Cloudflare.
 */
export function cobroChecks(channelIds, { frequency = 10 } = {}) {
  const common = { frequency, channelIds, tag: TAG_COBRO, failedRuns: 2 };
  const headers = [{ key: 'User-Agent', value: 'Amado-Web-Monitor/1.0' }];
  return [
    { ...baseCheck({ name: 'Amado cobro - configuracion y servicios', ...common }), checkType: 'API',
      degradedResponseTime: 10000, maxResponseTime: 20000,
      request: { method: 'GET', url: `${SITE}/api/checkout-health`, followRedirects: false, skipSSL: false, headers,
        assertions: [
          { source: 'STATUS_CODE', comparison: 'EQUALS', target: '200' },
          { source: 'JSON_BODY', property: '$.ok', comparison: 'EQUALS', target: 'true' },
        ] } },
    { ...baseCheck({ name: 'Amado cobro - aviso de Mercado Pago exige firma', ...common }), checkType: 'API',
      degradedResponseTime: 10000, maxResponseTime: 20000,
      request: { method: 'POST', url: `${SITE}/api/webhooks/mercadopago?data.id=1&type=payment`, followRedirects: false,
        skipSSL: false, bodyType: 'JSON', body: '{"type":"payment","data":{"id":"1"}}',
        headers: [...headers, { key: 'Content-Type', value: 'application/json' }],
        assertions: [{ source: 'STATUS_CODE', comparison: 'EQUALS', target: '401' }] } },
  ];
}

export function simulacroCheck(channelIds, { failing }) {
  return { ...baseCheck({ name: 'Amado - SIMULACRO de alarma (ignorar)', frequency: 1440, channelIds, tag: TAG_SIMULACRO, failedRuns: 1 }),
    checkType: 'API', degradedResponseTime: 10000, maxResponseTime: 20000,
    request: { method: 'GET', url: `${SITE}/api/health`, followRedirects: false, skipSSL: false,
      headers: [{ key: 'User-Agent', value: 'Amado-Web-Monitor/1.0' }],
      // Falla a propósito: /api/health responde 200 y se le exige 599.
      assertions: [{ source: 'STATUS_CODE', comparison: 'EQUALS', target: failing ? '599' : '200' }] } };
}

// ── Operaciones ─────────────────────────────────────────────────────────────

async function ensureEmailChannels(api, addresses) {
  const channels = await api('/v1/alert-channels');
  const ids = [];
  for (const address of addresses) {
    const found = channels.find(c => c.type === 'EMAIL' && String(c.config?.address).toLowerCase() === address);
    const channel = found || await api('/v1/alert-channels', { method: 'POST', body: emailChannel(address) });
    if (!Number.isSafeInteger(channel.id)) throw new Error('CHECKLY_CANAL_INVALIDO');
    ids.push(channel.id);
    log(found ? 'canal_de_correo_existente' : 'canal_de_correo_creado', { casilla: maskEmail(address) });
  }
  return ids;
}

async function putCheck(api, definition, existingId) {
  const result = await api(`/v1/checks/api${existingId ? `/${existingId}` : ''}?autoAssignAlerts=false`,
    { method: existingId ? 'PUT' : 'POST', body: definition });
  if (!UUID.test(result?.id || '')) throw new Error('CHECKLY_CONTROL_INVALIDO');
  return result.id;
}

const trigger = (api, id) => api('/v2/check-sessions/trigger', { method: 'POST', body: { target: { checkId: [id] }, refreshCache: true } });

async function waitResult(api, id, since) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const page = await api(`/v2/check-results/${id}?limit=1&resultType=FINAL&fields=id,checkId,hasFailures,hasErrors,startedAt`);
    const entry = page.entries?.[0];
    if (entry?.checkId === id && Date.parse(entry.startedAt) >= Date.parse(since) - 5000) return entry;
    await sleep(10000);
  }
  throw new Error('CHECKLY_RESULTADO_DEMORADO');
}

export async function estado({ api = checklyApi() } = {}) {
  const [plan, checks, channels, statuses] = await Promise.all([
    api('/v1/accounts/me/entitlements'), api('/v1/checks'), api('/v1/alert-channels'),
    api('/v1/check-statuses').catch(() => []),
  ]);
  const statusById = new Map((Array.isArray(statuses) ? statuses : []).map(s => [s.checkId, s]));
  log('plan', { plan: plan.plan, limites: (plan.entitlements || [])
    .filter(e => e.enabled && e.quantity != null && /check|run|alert|monitor/i.test(String(e.key)))
    .map(e => `${e.key}=${e.quantity}`).join(' ') });
  for (const c of checks) {
    const s = statusById.get(c.id) || {};
    log('control', { nombre: c.name, tipo: c.checkType, activo: c.activated, silenciado: c.muted, cada_min: c.frequency,
      etiquetas: c.tags, canales: (c.alertChannelSubscriptions || []).filter(x => x.activated).length,
      falla_ahora: s.hasFailures ?? null, error_ahora: s.hasErrors ?? null, ultimo_cambio: s.updated_at || s.updatedAt || null });
  }
  // Para los controles que fallan ahora: qué respondió el último resultado
  // (solo código, tiempo y las aserciones que no se cumplieron; nunca el cuerpo).
  for (const c of checks.filter(x => statusById.get(x.id)?.hasFailures)) {
    try {
      const page = await api(`/v2/check-results/${c.id}?limit=1&resultType=FINAL`);
      const r = page.entries?.[0] || {};
      const api_ = r.apiCheckResult || {};
      log('resultado', { nombre: c.name, tiene_fallas: r.hasFailures ?? null, con_error: r.hasErrors ?? null, degradado: r.isDegraded ?? null, claves: Object.keys(api_).join(','), desde: r.startedAt ?? null, ubicacion: r.runLocation ?? null,
        http: api_.response?.status ?? api_.responseStatus ?? null, tiempo_ms: api_.timings?.total ?? r.responseTime ?? null,
        error_de_conexion: api_.requestError || null,
        aserciones: (api_.assertions || []).filter(x => x.error || x.pass === false || x.passed === false)
          .map(x => ({ fuente: x.source, comparacion: x.comparison, esperado: x.target, actual: x.actual ?? null })) });
    } catch (error) { log('resultado', { nombre: c.name, error: String(error?.message || error).slice(0, 120) }); }
  }
  for (const ch of channels) {
    log('canal', { tipo: ch.type, destino: ch.type === 'EMAIL' ? maskEmail(ch.config?.address) : (ch.config?.name || ''),
      avisa_falla: ch.sendFailure, avisa_recuperacion: ch.sendRecovery,
      suscripciones: (ch.subscriptions || []).filter(s => s.activated).length });
  }
  const personales = channels.filter(c => ['EMAIL', 'SMS', 'CALL'].includes(c.type));
  log('resumen', { controles: checks.length, activos: checks.filter(c => c.activated).length,
    controles_del_cobro: checks.filter(c => c.tags?.includes(TAG_COBRO)).length,
    canales_que_llegan_a_una_persona: personales.length });
  return { plan, checks, channels };
}

async function waitHealthy(fetchFn, url) {
  for (let attempt = 0; attempt < 45; attempt++) {
    try {
      const response = await fetchFn(url, { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'Amado-Web-Monitor/1.0' } });
      const body = await response.json().catch(() => null);
      if (response.status === 200 && body?.ok === true) return;
      log('esperando_diagnostico', { http: response.status, intento: attempt + 1 });
    } catch { log('esperando_diagnostico', { http: 0, intento: attempt + 1 }); }
    await sleep(20000);
  }
  throw new Error('DIAGNOSTICO_DEL_COBRO_NO_RESPONDE_OK');
}

export async function aplicar({ api = checklyApi(), fetchFn = fetch, recipients, wait = true } = {}) {
  // No se da de alta un control contra un diagnóstico que todavía no está
  // publicado o que hoy falla: avisaría en falso desde el primer minuto.
  if (wait) await waitHealthy(fetchFn, `${SITE}/api/checkout-health`);
  const channelIds = await ensureEmailChannels(api, recipients);
  const inventory = await api('/v1/checks');
  for (const definition of cobroChecks(channelIds)) {
    const matches = inventory.filter(c => c.tags?.includes(TAG_COBRO) && c.name === definition.name);
    if (matches.length > 1) throw new Error('CHECKLY_CONTROL_AMBIGUO');
    await putCheck(api, definition, matches[0]?.id);
    log(matches[0] ? 'control_actualizado' : 'control_creado', { nombre: definition.name, cada_min: definition.frequency });
  }
  // Los controles de septiembre avisaban sólo a un receptor que nadie mira:
  // se les suma el correo, sin tocar nada más de su definición.
  const fields = ['name', 'checkType', 'frequency', 'script', 'request', 'runtimeId', 'locations', 'tags', 'activated', 'muted',
    'doubleCheck', 'retryStrategy', 'runParallel', 'alertSettings', 'useGlobalAlertSettings', 'degradedResponseTime', 'maxResponseTime'];
  for (const check of inventory.filter(c => c.tags?.includes(TAG_WEB) && c.activated)) {
    const current = check.alertChannelSubscriptions || [];
    const missing = channelIds.filter(id => !current.some(s => s.alertChannelId === id && s.activated));
    if (missing.length === 0) { log('control_ya_avisa_por_correo', { nombre: check.name }); continue; }
    const body = { ...Object.fromEntries(Object.entries(check).filter(([key]) => fields.includes(key))),
      alertChannelSubscriptions: [...current.filter(s => !missing.includes(s.alertChannelId)),
        ...missing.map(alertChannelId => ({ alertChannelId, activated: true }))] };
    await api(`/v1/checks/${check.checkType === 'BROWSER' ? 'browser' : 'api'}/${check.id}?autoAssignAlerts=false`, { method: 'PUT', body });
    log('control_suscripto_al_correo', { nombre: check.name });
  }
}

export async function simulacro({ api = checklyApi(), recipient } = {}) {
  const [channelId] = await ensureEmailChannels(api, [recipient]);
  const leftovers = (await api('/v1/checks')).filter(c => c.tags?.includes(TAG_SIMULACRO));
  for (const old of leftovers) await api(`/v1/checks/${old.id}`, { method: 'DELETE' });
  let id;
  try {
    id = await putCheck(api, simulacroCheck([channelId], { failing: true }));
    let since = new Date().toISOString();
    await trigger(api, id);
    const failed = await waitResult(api, id, since);
    log('simulacro_falla', { falla: failed.hasFailures === true, inicio: failed.startedAt });
    if (failed.hasFailures !== true) throw new Error('SIMULACRO_NO_FALLO');
    await sleep(90000); // margen para que salga el aviso de falla antes de recuperarlo
    await putCheck(api, simulacroCheck([channelId], { failing: false }), id);
    since = new Date().toISOString();
    await trigger(api, id);
    const recovered = await waitResult(api, id, since);
    log('simulacro_recuperacion', { falla: recovered.hasFailures === true, inicio: recovered.startedAt });
    if (recovered.hasFailures !== false) throw new Error('SIMULACRO_NO_SE_RECUPERO');
    await sleep(90000); // margen para que salga el aviso de recuperación antes de borrar el control
  } finally {
    if (id) { await api(`/v1/checks/${id}`, { method: 'DELETE' }).catch(() => {}); log('simulacro_control_borrado'); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const action = process.argv[2];
  try {
    const recipients = parseRecipients(await readFile('wrangler.toml', 'utf8'));
    if (action === 'estado') await estado();
    else if (action === 'aplicar') { await aplicar({ recipients }); await estado(); }
    else if (action === 'simulacro') await simulacro({ recipient: recipients[0] });
    else throw new Error('ACCION_DESCONOCIDA');
  } catch (error) {
    console.error(/^[A-Z0-9_]+$/.test(error?.message || '') ? error.message : 'CHECKLY_COBRO_FALLO');
    process.exitCode = 1;
  }
}
