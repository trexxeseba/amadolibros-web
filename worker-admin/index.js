import { onRequest } from '../functions/admin.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.protocol !== 'https:' || url.hostname !== env.ADMIN_WEB_HOST) {
      return new Response('No encontrado', { status: 404, headers: { 'Cache-Control': 'no-store' } });
    }
    if (url.pathname === '/' && ['GET', 'HEAD'].includes(request.method)) {
      return new Response(null, { status: 302, headers: { Location: '/admin', 'Cache-Control': 'no-store' } });
    }
    if (url.pathname !== '/admin') return new Response('No encontrado', { status: 404,
      headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' } });
    return onRequest({ request, env });
  },
};
