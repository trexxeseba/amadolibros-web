import { verifyTurnstile } from './_turnstile.js';
import { PAUSED_MANIFEST_URL, R2_BASE } from '../_shared/catalog.js';

const SESSION_TTL_SECONDS = 30 * 60;
const PAGES_PREVIEW_HOSTNAME_RE = /^[^.]+\.amadolibros-web\.pages\.dev$/;
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      'Cache-Control': 'no-store',
    },
  });
}

function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function fromBase64url(value) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Uint8Array.from(atob(padded), character => character.charCodeAt(0));
}

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey(
    'raw',
    ENCODER.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, ENCODER.encode(value)));
}

async function createSession(secret, ip, nowMs = Date.now()) {
  const payload = base64url(ENCODER.encode(JSON.stringify({
    exp: Math.floor(nowMs / 1000) + SESSION_TTL_SECONDS,
    ip,
    nonce: crypto.randomUUID(),
  })));
  return `${payload}.${base64url(await hmac(secret, payload))}`;
}

async function validSession(token, secret, ip, nowMs = Date.now()) {
  const [payload, signature, extra] = String(token || '').split('.');
  if (!payload || !signature || extra) return false;
  let expected;
  try {
    expected = await hmac(secret, payload);
  } catch {
    return false;
  }
  const actual = fromBase64url(signature);
  if (actual.byteLength !== expected.byteLength) return false;
  let mismatch = 0;
  for (let index = 0; index < actual.byteLength; index += 1) {
    mismatch |= actual[index] ^ expected[index];
  }
  if (mismatch !== 0) return false;
  try {
    const decoded = JSON.parse(DECODER.decode(fromBase64url(payload)));
    return decoded.ip === ip &&
      Number.isInteger(decoded.exp) &&
      decoded.exp >= Math.floor(nowMs / 1000);
  } catch {
    return false;
  }
}

function manifestCacheKeys(manifest) {
  const descriptor = manifest?.current;
  if (!descriptor || typeof descriptor !== 'object') return [];
  const relativeKeys = [
    descriptor.active_index_gzip_key,
    descriptor.index_gzip_key,
  ].filter(value => typeof value === 'string' && value.startsWith('stock1-preview/versions/'));
  return [
    PAUSED_MANIFEST_URL,
    ...relativeKeys.map(key => `${R2_BASE}/${key}`),
  ];
}

async function loadCurrentManifest() {
  const nonceUrl = `${PAUSED_MANIFEST_URL}?perf_verify=${crypto.randomUUID()}`;
  const response = await fetch(nonceUrl, {
    headers: { 'Accept-Encoding': 'identity' },
  });
  if (!response.ok) throw new Error(`manifest_${response.status}`);
  return response.json();
}

async function clearExactCatalogKeys() {
  const manifest = await loadCurrentManifest();
  const keys = manifestCacheKeys(manifest);
  if (keys.length !== 3) throw new Error('manifest_keys_invalid');
  const deleted = await Promise.all(
    keys.map(async key => ({
      key,
      deleted: await caches.default.delete(new Request(key)),
    })),
  );
  return {
    version: manifest.current.version,
    deleted,
    all_deleted: deleted.every(result => result.deleted),
  };
}

function page(siteKey) {
  const safeSiteKey = String(siteKey || '').replace(/[<>"']/gu, '');
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>PERF-VERIFY-1</title>
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
  <style>
    body{font:16px/1.45 system-ui,sans-serif;max-width:820px;margin:2rem auto;padding:0 1rem}
    button{padding:.7rem 1rem}textarea{width:100%;min-height:320px;margin-top:1rem}
  </style>
</head>
<body>
  <h1>PERF-VERIFY-1</h1>
  <p>Verificación temporal de caché fría y caliente en Preview.</p>
  <div class="cf-turnstile" data-sitekey="${safeSiteKey}" data-action="perf_verify"></div>
  <button id="run" type="button">Autorizar y ejecutar 20 repeticiones</button>
  <p id="status" role="status"></p>
  <textarea id="output" readonly></textarea>
<script>
const queries=['alpha','los seis pilares','zzzinexistente999','biblia','tarot','978'];
const statusNode=document.getElementById('status');
const output=document.getElementById('output');
function timingMap(header){
  return Object.fromEntries(String(header||'').split(',').map(part=>{
    const match=part.trim().match(/^([A-Za-z][A-Za-z0-9_-]*);dur=([0-9.]+)/);
    return match?[match[1],Number(match[2])]:null;
  }).filter(Boolean));
}
function percentile(values,p){
  const sorted=values.slice().sort((a,b)=>a-b);
  return sorted[Math.max(0,Math.ceil((p/100)*sorted.length)-1)];
}
function stats(rows,getter){
  const values=rows.map(getter).filter(Number.isFinite);
  return {n:values.length,median:percentile(values,50),p95:percentile(values,95)};
}
function summarize(rows){
  const fields={
    external_ms:row=>row.external_ms,
    worker_total:row=>row.server_timing.worker_total,
    route_total:row=>row.server_timing.route_total,
    manifest_read:row=>row.server_timing.manifest_read,
    active_index_read:row=>row.server_timing.active_index_gzip_read,
    paused_index_read:row=>row.server_timing.paused_index_gzip_read,
    search:row=>row.server_timing.search,
    render:row=>row.server_timing.render
  };
  const summarizeRows=selected=>Object.fromEntries(
    Object.entries(fields).map(([name,getter])=>[name,stats(selected,getter)])
  );
  return {
    sample_size:rows.length,
    cf_rays:[...new Set(rows.map(row=>row.cf_ray).filter(Boolean))],
    overall:Object.fromEntries(['cold','warm'].map(condition=>[
      condition,summarizeRows(rows.filter(row=>row.condition===condition))
    ])),
    by_query:Object.fromEntries(queries.map(query=>[
      query,
      Object.fromEntries(['cold','warm'].map(condition=>[
        condition,
        summarizeRows(rows.filter(row=>row.query===query&&row.condition===condition))
      ]))
    ]))
  };
}
async function api(body,session=''){
  const response=await fetch('/api/perf-verify',{
    method:'POST',
    headers:{
      'Content-Type':'application/json',
      ...(session?{Authorization:'Bearer '+session}:{})
    },
    body:JSON.stringify(body)
  });
  const data=await response.json();
  if(!response.ok)throw new Error(data.error||('HTTP '+response.status));
  return data;
}
async function search(query,condition,iteration){
  const started=performance.now();
  const response=await fetch('/catalogo?q='+encodeURIComponent(query),{cache:'no-store'});
  await response.text();
  return {
    query,condition,iteration,status:response.status,
    external_ms:Math.round((performance.now()-started)*100)/100,
    cache_status:response.headers.get('x-cache-status'),
    cache_hits:Number(response.headers.get('x-perf-cache-hits')),
    cache_misses:Number(response.headers.get('x-perf-cache-misses')),
    cf_ray:response.headers.get('cf-ray'),
    server_timing:timingMap(response.headers.get('server-timing'))
  };
}
document.getElementById('run').addEventListener('click',async()=>{
  const button=document.getElementById('run');
  button.disabled=true;output.value='';
  try{
    const token=window.turnstile&&window.turnstile.getResponse();
    if(!token)throw new Error('Resolvé Turnstile antes de continuar.');
    statusNode.textContent='Autorizando…';
    const authorization=await api({action:'authorize',turnstile_token:token});
    const rows=[];
    for(const query of queries){
      for(let iteration=1;iteration<=20;iteration++){
        statusNode.textContent=query+' — repetición '+iteration+'/20';
        await search(query,'prime',iteration);
        await new Promise(resolve=>setTimeout(resolve,100));
        const cleared=await api({action:'clear'},authorization.session);
        if(!cleared.all_deleted)throw new Error('La purga exacta no confirmó todas las claves.');
        const cold=await search(query,'cold',iteration);
        if(cold.cache_status!=='MISS')throw new Error('La muestra fría no confirmó MISS.');
        await new Promise(resolve=>setTimeout(resolve,250));
        const warm=await search(query,'warm',iteration);
        if(warm.cache_status!=='HIT')throw new Error('La muestra caliente no confirmó HIT.');
        rows.push(cold,warm);
      }
    }
    output.value=JSON.stringify({
      created_at:new Date().toISOString(),
      exact_cache_deletions_confirmed:queries.length*20,
      ...summarize(rows)
    },null,2);
    statusNode.textContent='Terminó: '+rows.length+' muestras válidas.';
  }catch(error){
    statusNode.textContent='Error: '+error.message;
  }finally{
    button.disabled=false;
    if(window.turnstile)window.turnstile.reset();
  }
});
</script>
</body>
</html>`;
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const isPreview = context.env?.APP_ENV === 'preview' &&
    PAGES_PREVIEW_HOSTNAME_RE.test(url.hostname);
  if (!isPreview) return new Response('Not found', { status: 404 });

  const secret = typeof context.env?.TURNSTILE_SECRET_KEY === 'string'
    ? context.env.TURNSTILE_SECRET_KEY.trim()
    : '';
  const siteKey = typeof context.env?.STOCK_WAITLIST_TURNSTILE_SITE_KEY === 'string'
    ? context.env.STOCK_WAITLIST_TURNSTILE_SITE_KEY.trim()
    : '';
  if (!secret || !siteKey) return json({ error: 'Verificación no configurada.' }, 503);

  if (context.request.method === 'GET') {
    return new Response(page(siteKey), {
      headers: {
        'Content-Type': 'text/html;charset=UTF-8',
        'Cache-Control': 'no-store',
      },
    });
  }
  if (context.request.method !== 'POST') {
    return json({ error: 'Método no permitido.' }, 405);
  }

  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ error: 'JSON inválido.' }, 400);
  }
  const ip = context.request.headers.get('CF-Connecting-IP') || '';
  if (body?.action === 'authorize') {
    const result = await verifyTurnstile(
      String(body.turnstile_token || ''),
      secret,
      ip,
      {
        action: 'perf_verify',
        isAllowedHostname: hostname => PAGES_PREVIEW_HOSTNAME_RE.test(hostname),
      },
    );
    if (!result.ok) return json({ error: 'Turnstile rechazó la autorización.', code: result.code }, 403);
    return json({ ok: true, session: await createSession(secret, ip) });
  }
  if (body?.action === 'clear') {
    const authorization = context.request.headers.get('Authorization') || '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!await validSession(token, secret, ip)) {
      return json({ error: 'Sesión inválida o vencida.' }, 403);
    }
    try {
      return json({ ok: true, ...(await clearExactCatalogKeys()) });
    } catch (error) {
      return json({ error: 'No se pudieron limpiar las claves exactas.', code: error?.message }, 503);
    }
  }
  return json({ error: 'Acción inválida.' }, 400);
}

export const __test = {
  createSession,
  validSession,
  manifestCacheKeys,
};
