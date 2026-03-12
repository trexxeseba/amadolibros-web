/**
 * functions/index.js
 * 
 * WORKER RAÍZ - Sirve el catálogo dinámico desde Cloudflare KV
 * Ruta: amadolibros.com/
 */

export async function onRequest(context) {
  const KV = context.env.AMADO_KV;

  try {
    // Obtener todos los item IDs
    let allItemIds = [];
    try {
      const idsData = await KV.get('all_item_ids');
      if (idsData) {
        allItemIds = JSON.parse(idsData);
      }
    } catch (e) {
      console.log('Error obteniendo IDs');
    }

    // Obtener detalles de items (máximo 50)
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
        // Ignorar errores
      }
    }

    // Generar HTML
    const html = generateHTML(items);

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

function generateHTML(items) {
  const itemsHTML = items.map(item => {
    const precio = item.price ? item.price.toLocaleString('es-UY') : 'N/A';
    return `
    <div class="product" data-id="${item.id}">
      <div class="product-image">
        <img src="${item.thumbnail || 'https://via.placeholder.com/200'}" alt="${item.title}" loading="lazy">
      </div>
      <div class="product-info">
        <h3 class="product-title">${item.title || 'Sin titulo'}</h3>
        <div class="price-container">
          <span class="currency">${item.currency_id || 'UYU'}</span>
          <span class="price">${precio}</span>
        </div>
        <div class="stock-info">
          Stock: <span class="stock-value">${item.available_quantity || 0}</span>
        </div>
        <a href="${item.permalink}" target="_blank" class="btn-comprar">
          Ver en MELI
        </a>
      </div>
    </div>
    `;
  }).join('\n');

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Amado Libros - Libreria Online</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: sans-serif; background: #f5f5f5; }
    .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
    header { background: white; padding: 30px; text-align: center; border-radius: 8px; margin-bottom: 30px; }
    h1 { font-size: 28px; margin-bottom: 10px; }
    .subtitle { color: #666; font-size: 16px; }
    .meta-info { color: #999; font-size: 13px; margin-top: 15px; padding-top: 15px; border-top: 1px solid #eee; }
    .products { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 20px; }
    .product { background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .product:hover { transform: translateY(-3px); box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
    .product-image { width: 100%; height: 200px; background: #eee; overflow: hidden; }
    .product-image img { width: 100%; height: 100%; object-fit: cover; }
    .product-info { padding: 15px; }
    .product-title { font-size: 14px; margin-bottom: 12px; line-height: 1.4; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    .price-container { display: flex; gap: 5px; align-items: baseline; margin-bottom: 10px; }
    .currency { font-size: 12px; color: #999; }
    .price { font-size: 20px; font-weight: bold; color: #27ae60; }
    .stock-info { font-size: 12px; color: #999; margin-bottom: 12px; }
    .stock-value { color: #333; font-weight: bold; }
    .btn-comprar { display: block; width: 100%; background: #3498db; color: white; text-align: center; padding: 10px; border-radius: 4px; text-decoration: none; font-weight: bold; }
    .btn-comprar:hover { background: #2980b9; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>📚 Amado Libros</h1>
      <p class="subtitle">Tu proxima historia comienza aqui</p>
      <p class="subtitle">Libreria online con miles de titulos y atencion personalizada</p>
      <div class="meta-info">
        ${items.length} libros disponibles | Actualizado cada hora
      </div>
    </header>
    <div class="products">
      ${items.length > 0 ? itemsHTML : '<p style="text-align:center; padding:40px;">Cargando catalogo...</p>'}
    </div>
  </div>
</body>
</html>`;

  return html;
}
