import { handleImageVariants } from './image-variants-api.js';

export default {
  async fetch(request, env) {
    if (!env.PREVIEW_SEED_TOKEN || request.headers.get('authorization') !== `Bearer ${env.PREVIEW_SEED_TOKEN}`) {
      return new Response('Unauthorized', { status: 401 });
    }
    if (!new URL(request.url).pathname.startsWith('/image-variants/')) return new Response('Not found', { status: 404 });
    return handleImageVariants(request, { ...env, IMAGE_VARIANTS_WRITE_ENABLED: 'true' });
  },
};
