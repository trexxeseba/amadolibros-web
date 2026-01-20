// functions/api/[[route]].js
// VERSIÓN MEJORADA: Con webhooks + sync cada 6 horas

const APP_ID = '4741021817925208';
const USER_ID = '440298103';

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, '');

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // RUTAS
  if (path === '/health') {
    return handleHealth(corsHeaders);
  }

  if (path === '/sync-catalog') {
    return handleSyncCatalog(env, corsHeaders);
  }

  if (path === '/webhooks/mercadolibre' && request.method === 'POST') {
    return handleWebhook(request, env, corsHeaders, context);
  }

  if (path === '/webhook-status') {
    return handleWebhookStatus(env, corsHeaders);
  }

  if (path === '/items-cache') {
    return handleGetItemsCache(env, corsHeaders);
  }

  return new Response('Not Found', { status: 404, headers: corsHeaders });
}

// =============================================================================
// HANDLERS
// =============================================================================

function handleHealth(corsHeaders) {
  return new Response(
    JSON.stringify({
      status: 'OK',
      timestamp: new Date().toISOString(),
      service: 'amadolibros-api'
    }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
}

async function handleSyncCatalog(env, corsHeaders) {
  const startTime = Date.now();
  const logs = [];

  try {
    logs.push('🔐 Obteniendo access token...');
    const accessToken = await getAccessToken(env);
    logs.push('✅ Token obtenido');

    const { itemIds, logs: fetchLogs, total } = await getAllItemIds(accessToken);
    logs.push(...fetchLogs);

    const { items: enrichedItems, logs: enrichLogs } = await enrichItemsWithDetails(itemIds, accessToken);
    logs.push(...enrichLogs);

    await env.AMADO_KV.put(
      'catalog:full',
      JSON.stringify(enrichedItems),
      { expirationTtl: 21600 }
    );

    await env.AMADO_KV.put(
      'catalog:metadata',
      JSON.stringify({
        total_items: enrichedItems.length,
        total_reported: total,
        last_sync: new Date().toISOString(),
        synced_at_timestamp: Date.now()
      }),
      { expirationTtl: 21600 }
    );

    const durationSeconds = Math.round((Date.now() - startTime) / 1000);
    const stats = {
      total: enrichedItems.length,
      total_reported: total,
      active: enrichedItems.filter(i => i.status === 'active').length,
      paused: enrichedItems.filter(i => i.status === 'paused').length,
      closed: enrichedItems.filter(i => i.status === 'closed').length,
      last_sync: new Date().toISOString(),
      duration_seconds: durationSeconds,
    };

    logs.push(`✅ COMPLETADO: ${enrichedItems.length} items en ${durationSeconds}s`);

    return new Response(
      JSON.stringify({ status: 'SUCCESS', stats, logs, items: enrichedItems }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    logs.push(`❌ Error: ${error.message}`);
    return new Response(
      JSON.stringify({ status: 'ERROR', error: error.message, logs }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
}

async function handleWebhook(request, env, corsHeaders, context) {
  try {
    const payload = await request.json();
    
    console.log('📨 Webhook recibido:', {
      topic: payload.topic,
      user_id: payload.user_id,
      resource: payload.resource,
    });

    if (context && context.waitUntil) {
      context.waitUntil(processWebhookAsync(payload, env));
    }

    return new Response(
      JSON.stringify({ status: 'received', id: payload._id }),
      { 
        status: 200,
