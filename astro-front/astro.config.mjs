import { defineConfig } from 'astro/config';

// Lote 0: output estático puro, sin adapter.
// @astrojs/cloudflare se agrega en Lote 2, después de verificar
// coexistencia de functions/ con wrangler pages deploy.
export default defineConfig({
  build: {
    // PERF-H1: el CSS total de estas páginas es pequeño. Embebido en el HTML
    // evita dos viajes de red que Lighthouse marcó como bloqueantes del LCP.
    inlineStylesheets: 'always',
  },
});
