// functions/api/webhooks/mercadolibre.js
// Endpoint para recibir webhooks de MercadoLibre en tiempo real

const APP_ID = '4741021817925208';
const USER_ID = '440298103';

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const payload = await request.json();
    
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
    console.error('❌ Error en webhook:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 400 }
    );
  }
}

async function handleWebhookAsync(payload, env) {
  try {
    const { topic, user_id, resource, _id } = payload;

    if (user_id !== parseInt(USER_ID)) {
      console.log(`⚠️ Webhook de otro seller ignorado: ${user_id}`);
      return;
    }

    const webhookKey = `webhook:${topic}:${_id}`;
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

    switch (topic) {
      case 'items':
        await handleItemsChange(resource, env);
        break;
      case 'orders_v2':
        await handleOrdersChange(resource, env);
        break;
      case 'stock_locations':
        await handleStockChange(resource, env);
        break;
      default:
        console.log(`ℹ️ Topic no procesado: ${topic}`);
    }

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

  } catch (error) {
    console.error('❌ Error procesando webhook:', error);
  }
}

async function handleItemsChange(itemId, env) {
  console.log(`📦 Item cambió: ${itemId}`);

  try {
    const accessToken = await getAccessToken(env);
    
    const response = await fetch(
      `https://api.mercadolibre.com/items/${itemId}?attributes=id,title,price,status,available_quantity`,
      { headers: { 'Authorization': `Bearer ${accessToken}` } }
    );

    if (!response.ok) {
      throw new Error(`Error HTTP ${response.status}`);
    }

    const item = await response.json();

    await env.AMADO_KV.put(
      `item:${itemId}`,
      JSON.stringify({
        id: item.id,
        title: item.title,
        price: item.price,
        status: item.status,
        available_quantity: item.available_quantity,
        updated_at: new Date().toISOString()
      }),
      { expirationTtl: 604800 }
    );

    console.log(`✅ Item actualizado: ${item.id}`);

  } catch (error) {
    console.error(`❌ Error actualizando item ${itemId}:`, error);
  }
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
    console.error(`❌ Error procesando orden ${orderId}:`, error);
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
    console.error('❌ Error procesando cambio de stock:', error);
  }
}

async function getAccessToken(env) {
  const REFRESH_TOKEN = env.REFRESH_TOKEN;
  const CLIENT_SECRET = env.CLIENT_SECRET;
  
  const response = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: APP_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
    }),
  });

  if (!response.ok) {
    throw new Error(`Error obteniendo token: ${response.status}`);
  }

  const data = await response.json();
  return data.access_token;
}
