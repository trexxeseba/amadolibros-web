// functions/api/webhooks/mercadolibre.js
// Endpoint para recibir webhooks de MercadoLibre en tiempo real
//
// OAuth: usa el mismo módulo que el Worker de sync (D1 `ml_oauth`, lock fuerte,
// refresh token rotativo de un solo uso). Ya no existe un REFRESH_TOKEN estático
// en variables de entorno: ese camino paralelo rompía la rotación compartida.

import { getAccessToken as getSharedAccessToken } from '../../../worker-sync/meli-auth.js';

const APP_ID = '4741021817925208';
const USER_ID = '440298103';

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    console.log('🔍 Iniciando webhook...');
    console.log('🔍 Env disponible:', Object.keys(env).join(', '));
    
    const payload = await request.json();
    console.log('📨 Payload recibido:', JSON.stringify(payload).substring(0, 500));
    
    console.log('📨 Webhook recibido:', {
      topic: payload.topic,
      user_id: payload.user_id,
      resource: payload.resource,
      timestamp: new Date().toISOString()
    });

    context.waitUntil(
      handleWebhookAsync(payload, env)
    );

    return new Response(
      JSON.stringify({ status: 'received', id: payload._id }),
      { 
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }
    );

  } catch (error) {
    console.error('❌ Error CRÍTICO en onRequest:', error.message);
    console.error('❌ Stack:', error.stack);
    return new Response(
      JSON.stringify({ error: error.message, stack: error.stack }),
      { status: 400 }
    );
  }
}

async function handleWebhookAsync(payload, env) {
  try {
    console.log('⏳ Procesando webhook async...');
    const { topic, user_id, resource, _id } = payload;

    console.log('🔍 USER_ID comparación:', {
      recibido: user_id,
      esperado: USER_ID,
      tiposRecibido: typeof user_id,
      tiposEsperado: typeof USER_ID,
      sonIguales: user_id.toString() === USER_ID.toString()
    });

    if (user_id.toString() !== USER_ID.toString()) {
      console.log(`⚠️ Webhook de otro seller ignorado: ${user_id}`);
      return;
    }

    console.log('✅ USER_ID validado correctamente');

    const webhookKey = `webhook:${topic}:${_id}`;
    console.log('🔑 Intentando guardar en KV con clave:', webhookKey);
    
    try {
      await env.AMADO_KV.put(
        webhookKey,
        JSON.stringify({
          topic,
          resource,
          received_at: new Date().toISOString(),
          processed: false
        }),
        { expirationTtl: 86400 }
      );
      console.log('✅ Webhook guardado en KV');
    } catch (kvError) {
      console.error('❌ Error guardando en KV:', kvError.message);
      throw kvError;
    }

    switch (topic) {
      case 'items':
        console.log('📦 Procesando items...');
        await handleItemsChange(resource, env);
        break;
      case 'orders_v2':
        console.log('🛒 Procesando órdenes...');
        await handleOrdersChange(resource, env);
        break;
      case 'stock_locations':
        console.log('📊 Procesando stock...');
        await handleStockChange(resource, env);
        break;
      default:
        console.log(`ℹ️ Topic no procesado: ${topic}`);
    }

    console.log('🔑 Intentando marcar como procesado...');
    await env.AMADO_KV.put(
      webhookKey,
      JSON.stringify({
        topic,
        resource,
        received_at: new Date().toISOString(),
        processed: true,
        processed_at: new Date().toISOString()
      }),
      { expirationTtl: 86400 }
    );
    console.log('✅ Webhook marcado como procesado');

  } catch (error) {
    console.error('❌ Error procesando webhook:', error.message);
    console.error('❌ Stack:', error.stack);
  }
}

async function handleItemsChange(itemId, env) {
  // La escritura de item:MLU* en KV fue eliminada: ese esquema (catalog_index + item:*)
  // pertenece a una versión anterior del Worker y ya no tiene consumidores.
  // El catálogo vive en R2 (catalog.json). Las actualizaciones individuales de items
  // serán responsabilidad del Worker de sync en la próxima arquitectura.
  // El audit log del webhook (webhook:topic:id) sigue registrando el evento.
  console.log(`📦 Item cambió: ${itemId} — catalog update deferred to sync Worker`);
}

async function handleOrdersChange(orderId, env) {
  console.log(`🛒 Orden cambió: ${orderId}`);

  try {
    const accessToken = await getAccessToken(env);
    
    const response = await fetch(
      `https://api.mercadolibre.com/orders/${orderId}`,
      { headers: { 'Authorization': `Bearer ${accessToken}` } }
    );

    if (!response.ok) {
      throw new Error(`Error HTTP ${response.status}`);
    }

    const order = await response.json();

    await env.AMADO_KV.put(
      `order:${orderId}`,
      JSON.stringify({
        id: order.id,
        status: order.status,
        total_amount: order.total_amount,
        buyer: order.buyer?.nickname,
        created_at: order.date_created,
        paid_at: order.paid_date
      }),
      { expirationTtl: 2592000 }
    );

    console.log(`✅ Orden registrada: ${orderId}`);

  } catch (error) {
    console.error(`❌ Error procesando orden ${orderId}:`, error.message);
  }
}

async function handleStockChange(resource, env) {
  console.log(`📊 Stock cambió: ${resource}`);

  try {
    await env.AMADO_KV.put(
      `stock:${resource}`,
      JSON.stringify({
        resource,
        changed_at: new Date().toISOString()
      }),
      { expirationTtl: 3600 }
    );

    console.log(`✅ Stock actualizado`);

  } catch (error) {
    console.error('❌ Error procesando cambio de stock:', error.message);
  }
}

async function getAccessToken(env) {
  // Misma fuente de verdad que el Worker: nunca un refresh token de entorno.
  const shared = Object.create(env);
  if (!env.APP_ID) shared.APP_ID = APP_ID;
  return getSharedAccessToken(shared);
}
