import { normalizePhone } from './meta-capi.js';

/**
 * Seguimiento de un pedido sin pagar. Un cliente que ya dejó nombre, teléfono
 * y libros está a un paso de comprar: lo que más recupera ventas es escribirle
 * enseguida, por WhatsApp, preguntando si tuvo algún problema (no apurándolo).
 * El correo queda como segunda vía. El panel no manda nada solo: arma el
 * mensaje y el enlace; quien atiende lo revisa y toca enviar.
 */
export function followUpLinks(order, items) {
  if (!order || order.payment_status === 'approved' || order.status !== 'open') return null;
  const nombre = String(order.buyer_name || '').trim().split(/\s+/)[0] || '';
  const libros = (items || []).map(i => String(i.title || '').trim()).filter(Boolean).slice(0, 3);
  const saludo = nombre ? `¡Hola, ${nombre}!` : '¡Hola!';
  const texto = [
    `${saludo} 👋 Te escribo de Amado Libros.`,
    libros.length
      ? `Vimos que elegiste estos libros en nuestra tienda:\n\n${libros.map(t => `📚 ${t}`).join('\n')}`
      : 'Vimos que elegiste unos libros en nuestra tienda.',
    '¿Todavía querés comprarlos? Estamos a las órdenes para ayudarte con lo que necesites. Si preferís pagar de otra forma, avisame y lo coordinamos.',
    'Además, si lo deseás, te hacemos un 10 % de descuento en tu pedido 🎁',
    '¡Quedamos atentos! 😊',
  ].join('\n\n');
  const phone = normalizePhone(order.buyer_phone);
  const email = String(order.buyer_email || '').trim();
  return {
    texto,
    whatsapp: phone ? `https://wa.me/${phone}?text=${encodeURIComponent(texto)}` : '',
    mailto: email ? `mailto:${email}?subject=${encodeURIComponent(`Tu pedido ${order.public_code} en Amado Libros`)}&body=${encodeURIComponent(texto)}` : '',
  };
}
