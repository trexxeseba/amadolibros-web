/**
 * Cloudflare Worker: Amado Libros - Versión Reparada y Estable
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
        // CORRECCIÓN CRÍTICA DE PRECIOS: Asegurar valores numéricos
        const priceList = Number(book.price || book.priceOriginal || 0);
        const priceTransfer = Math.round(priceList * 0.88);
        
        // OPTIMIZACIÓN DE IMÁGENES: Forzar alta resolución de MeLi
        let imageUrl = (book.image || "").replace("http://", "https://");
        if (imageUrl.includes("mlstatic.com")) {
          imageUrl = imageUrl.replace(/-[A-Z]\.jpg$/, "-F.jpg");
        }
        
        return {
          ...book,
          price: priceList,
          priceOriginal: priceList,
          priceTransfer: priceTransfer,
          image: imageUrl,
          shippingInfo: shippingBanner
        };
      });

      return new Response(JSON.stringify({
        books: processedCatalog,
        geo: {
          city: city,
          shipping_banner: shippingBanner
        }
      }), {
        headers: { 
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*" 
        }
      });
    }

    // 3. Servir el sitio
    return fetch(request);
  }
};
