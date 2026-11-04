import { webPromoState } from '../_shared/web-promo.js';

// Estado público de la promo web. La home estática lo consulta para mostrar el
// mismo precio que cobra el servidor. TTL corto: al terminar la ventana la home
// vuelve al precio habitual en menos de un minuto.
export async function onRequestGet(context) {
  return new Response(JSON.stringify(webPromoState(new Date(), context?.env)), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=30, s-maxage=30',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}
