/**
 * Cloudflare Worker: Amado Libros - Versión Premium
 * Optimizado para Performance, SEO y Geo-Personalización.
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 1. Lógica de Geo-Personalización
    const city = request.cf?.city || "Uruguay";
    const isMontevideo = city.toLowerCase().includes("montevideo");
    const shippingBanner = isMontevideo 
      ? "🚀 Envío Flash en 2 horas en Montevideo" 
      : "🚚 Despacho en el día por agencia al Interior";

    // 2. API de Libros
    if (path === "/api/books") {
      const catalogRaw = await env.AMADO_KV.get("full_catalog");
      let catalog = catalogRaw ? JSON.parse(catalogRaw) : [];
      
      const processedCatalog = catalog.map(book => {
        // Calcular precios
        const price = book.price || book.priceOriginal || 0;
        const priceTransfer = book.priceTransfer || Math.round(price * 0.88);
        const priceOriginal = book.priceOriginal || price;
        
        // Determinar badge según reglas de negocio
        let badge = book.badge || null;
        const status = book.status || "active";
        const availableQty = book.available_quantity || book.availableQuantity || 0;
        
        if (!badge && status === "paused" && availableQty === 0) {
          badge = "Encargo disponible";
        }

        // OPTIMIZACIÓN DE IMÁGENES:
        // Usamos Cloudflare Image Resizing si está disponible en el dominio.
        // Si no, forzamos HTTPS y usamos el thumbnail de alta calidad de MeLi.
        let imageUrl = (book.image || "").replace("http://", "https://");
        
        // Si la imagen es de MeLi, podemos intentar obtener una versión de mayor resolución
        // reemplazando el sufijo (ej: -I.jpg por -O.jpg o -F.jpg)
        if (imageUrl.includes("mlstatic.com")) {
          imageUrl = imageUrl.replace(/-[A-Z]\.jpg$/, "-F.jpg"); // -F suele ser la resolución más alta
        }
        
        return {
          ...book,
          priceTransfer,
          priceOriginal,
          image: imageUrl,
          shippingInfo: shippingBanner,
          badge,
          status
        };
      });

      return new Response(JSON.stringify(processedCatalog), {
        headers: { 
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*" 
        }
      });
    }

    // 3. Inyección de datos en el HTML
    const response = await fetch(request);
    if (response.headers.get("Content-Type")?.includes("text/html")) {
      let html = await response.text();
      
      // Corregir el error del banner que el usuario ve como {{SHIPPING_BANNER}}
      html = html.replace(/\{\{SHIPPING_BANNER\}\}/g, shippingBanner);
      html = html.replace(/\{\(SHIPPING_BANNER\)\}/g, shippingBanner);

      return new Response(html, {
        headers: response.headers
      });
    }

    return response;
  }
};
