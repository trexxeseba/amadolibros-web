/**
 * functions/[[path]].js
 * 
 * WORKER PRINCIPAL - Sirve el catálogo desde Cloudflare KV
 * 
 * Cómo funciona:
 * 1. Lee datos de AMADO_KV (donde guarda amadolibros-sync.js)
 * 2. Genera HTML con los libros
 * 3. Muestra PRECIOS REALES desde MELI
 */

export async function onRequest(context) {
  const KV = context.env.AMADO_KV;
  const url = new URL(context.request.url);
  const path = url.pathname;

  try {
    // Si es una ruta estática (CSS, JS, etc), dejar pasar
    if (path.includes('.css') || path.includes('.js') || path.includes('.png') || path.includes('.jpg')) {
      return context.next();
    }

    // Obtener índice del catálogo
    let catalogIndex = null;
    try {
      const indexData = await KV.get('catalog_index');
      if (indexData) {
        catalogIndex = JSON.parse(indexData);
      }
    } catch (e) {
      console.log('⚠️ No se encontró catalog_index en KV');
    }

    // Si no hay datos, intentar obtener de "all_item_ids"
    if (!catalogIndex) {
      try {
        const allIds = await KV.get('all_item_ids');
        if (allIds) {
          const ids = JSON.parse(allIds);
          catalogIndex = {
            total: ids.length,
            chunks: 1
          };
        }
      } catch (e) {
        console.log('⚠️ No se encontraron items en KV');
      }
    }

    // Obtener todos los item IDs
    let allItemIds = [];
    try {
      const idsData = await KV.get('all_item_ids');
      if (idsData) {
        allItemIds = JSON.parse(idsData);
      }
    } catch (e) {
      console.log('⚠️ Error obteniendo IDs');
    }

    // Obtener detalles de items
    const items = [];
    for (const itemId of allItemIds.slice(0, 50)) {
      try {
        const itemKey = `item:${itemId}`;
        const itemData = await KV.get(itemKey);
        
        if (itemData) {
          const item = JSON.parse(itemData);
          items.push(item);
        }
      } catch (e) {
        // Ignorar errores individuales
      }
    }

    // Generar HTML
    const html = generateHTML(items, catalogIndex);

    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=3600'
      }
    });

  } catch (error) {
    console.error('Error:', error);
    return new Response('Error', { status: 500 });
  }
}

function generateHTML(items, catalogIndex) {
  const itemsHTML = items.map(item => `
    <div class="product">
      <div class="product-image">
        <img src="${item.thumbnail || 'https://via.placeholder.com/200'}" alt="${item.title}">
      </div>
      <div class="product-info">
        <h3>${item.title}</h3>
        <div class="price">
          <span class="currency">${item.currency_id || 'UYU'}</span>
          <span class="amount">${item.price || 'N/A'}</span>
        </div>
        <div class="stock">Stock: ${item.available_quantity || 0}</div>
        <a href="${item.permalink}" target="_blank" class="btn">Ver en Mercado Libre</a>
      </div>
    </div>
  `).join('\n');

  const totalItems = catalogIndex?.total || items.length;
  const lastSync = new Date().toISOString();

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Amado Libros - Catálogo Online</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: Arial, sans-serif;
      background: #f5f5f5;
      padding: 20px;
    }
    
    .container {
      max-width: 1200px;
      margin: 0 auto;
    }
    
    header {
      background: white;
      padding: 20px;
      border-radius: 8px;
      margin-bottom: 20px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    
    h1 {
      color: #333;
      margin-bottom: 10px;
    }
    
    .meta {
      color: #666;
      font-size: 14px;
    }
    
    .products {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
      gap: 20px;
      margin-bottom: 40px;
    }
    
    .product {
      background: white;
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      transition: transform 0.2s;
    }
    
    .product:hover {
      transform: translateY(-5px);
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    }
    
    .product-image {
      width: 100%;
      height: 200px;
      overflow: hidden;
      background: #f0f0f0;
    }
    
    .product-image img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    
    .product-info {
      padding: 15px;
    }
    
    .product-info h3 {
      font-size: 14px;
      margin-bottom: 10px;
      color: #333;
      min-height: 40px;
      overflow: hidden;
      text-overflow: ellipsis;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }
    
    .price {
      display: flex;
      gap: 5px;
      margin-bottom: 10px;
      font-size: 20px;
      font-weight: bold;
      color: #2ecc71;
    }
    
    .currency {
      font-size: 14px;
      color: #666;
    }
    
    .stock {
      color: #999;
      font-size: 12px;
      margin-bottom: 10px;
    }
    
    .btn {
      display: block;
      background: #3498db;
      color: white;
      text-align: center;
      padding: 10px;
      border-radius: 4px;
      text-decoration: none;
      font-weight: bold;
      transition: background 0.2s;
    }
    
    .btn:hover {
      background: #2980b9;
    }
    
    .empty {
      text-align: center;
      padding: 40px 20px;
      color: #666;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>📚 Amado Libros</h1>
      <div class="meta">
        <p>Tu próxima historia comienza aquí. Librería online con miles de títulos y atención personalizada.</p>
        <p style="margin-top: 10px; color: #999; font-size: 12px;">
          Total de libros: ${totalItems} | 
          Última actualización: ${lastSync}
        </p>
      </div>
    </header>
    
    <div class="products">
      ${items.length > 0 ? itemsHTML : '<div class="empty"><p>Cargando catálogo...</p></div>'}
    </div>
  </div>
</body>
</html>`;
}
