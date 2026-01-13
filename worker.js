/**
 * Cloudflare Worker: Amado Libros - Plan de Vanguardia Global
 * Pilares: Geo-Personalización, Estrategia de Precios y SEO Dinámico.
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 1. Lógica de Geo-Personalización (Montevideo vs Interior)
    const city = request.cf?.city || "Uruguay";
    const isMontevideo = city.toLowerCase().includes("montevideo");
    const shippingBanner = isMontevideo 
      ? "🚀 Envío Flash en 2 horas en Montevideo" 
      : "🚚 Despacho en el día por agencia al Interior";

    // 2. API de Libros con Estrategia de Precios (12% OFF)
    if (path === "/api/books") {
      const catalogRaw = await env.AMADO_KV.get("full_catalog");
      let catalog = catalogRaw ? JSON.parse(catalogRaw) : [];
      
      // Procesar precios, forzar HTTPS y añadir info de envío
      const processedCatalog = catalog.map(book => {
        const priceTransfer = Math.round(book.price * 0.88); // 12% OFF
        return {
          ...book,
          priceTransfer,
          priceOriginal: book.price,
          image: book.image.replace("http://", "https://"),
          shippingInfo: shippingBanner
        };
      });

      return new Response(JSON.stringify(processedCatalog), {
        headers: { 
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=60"
        }
      });
    }

    // 3. SEO Dinámico e Inyección de Metatags
    const response = await fetch(request);
    if (response.headers.get("Content-Type")?.includes("text/html")) {
      let html = await response.text();
      
      // Inyectar banner de envío dinámico en el HTML
      html = html.replace("{{SHIPPING_BANNER}}", shippingBanner);

      // Si es una ruta de libro (ej: /libro/MLU123)
      if (path.startsWith("/libro/")) {
        const bookId = path.split("/")[2];
        const catalogRaw = await env.AMADO_KV.get("full_catalog");
        const catalog = catalogRaw ? JSON.parse(catalogRaw) : [];
        const book = catalog.find(b => b.id === bookId);

        if (book) {
          const seoTags = `
            <title>${book.title} | Amado Libros</title>
            <meta name="description" content="Compra ${book.title} de ${book.author} en Amado Libros. 12% OFF por transferencia.">
            <meta property="og:title" content="${book.title}">
            <meta property="og:image" content="${book.image.replace("http://", "https://")}">
            <script type="application/ld+json">
            {
              "@context": "https://schema.org/",
              "@type": "Book",
              "name": "${book.title}",
              "author": {"@type": "Person", "name": "${book.author}"},
              "offers": {
                "@type": "Offer",
                "price": "${Math.round(book.price * 0.88)}",
                "priceCurrency": "UYU"
              }
            }
            </script>
          `;
          html = html.replace("<!-- SEO_TAGS -->", seoTags);
        }
      } else {
        const defaultSEO = `
          <title>Amado Libros | La mejor librería de Uruguay</title>
          <meta name="description" content="Libros con 12% de descuento por transferencia. Envíos rápidos a todo Uruguay.">
        `;
        html = html.replace("<!-- SEO_TAGS -->", defaultSEO);
      }

      return new Response(html, {
        headers: response.headers
      });
    }

    return response;
  }
};
