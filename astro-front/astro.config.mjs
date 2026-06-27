import { defineConfig } from 'astro/config';

// Lote 0: output estático puro, sin adapter.
// @astrojs/cloudflare se agrega en Lote 2, después de verificar
// coexistencia de functions/ con wrangler pages deploy.
export default defineConfig({});
