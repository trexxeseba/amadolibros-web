import { defineConfig } from 'astro/config';

// Lote 0: output estático puro, sin adapter.
// @astrojs/cloudflare se agrega en Lote 2, después de verificar
// coexistencia de functions/ con wrangler pages deploy.
export default defineConfig({
  // El build estático emite dist/<ruta>/index.html y Cloudflare Pages sirve
  // esa forma directamente en /ruta/. Mantener el router de desarrollo en la
  // misma convención evita generar enlaces/canonicals distintos entre entornos.
  trailingSlash: 'always',
});
