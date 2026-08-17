export const WHATSAPP_NUMBER = '59899841325';
export const SITE_BASE = 'https://www.amadolibros.com';

export function absoluteSitePage(pathOrUrl = '/') {
  try {
    const url = new URL(String(pathOrUrl || '/'), SITE_BASE);
    url.hash = '';
    Array.from(url.searchParams.keys()).forEach((key) => {
      if (/^(utm_|gclid$|dclid$|gbraid$|wbraid$)/i.test(key)) {
        url.searchParams.delete(key);
      }
    });
    return url.toString();
  } catch {
    return `${SITE_BASE}/`;
  }
}

/**
 * Copy canónico para las consultas que salen del sitio hacia WhatsApp.
 *
 * Los rótulos son deliberadamente visibles y humanos: ayudan al equipo a
 * entender el contexto sin exponer códigos internos ni obligar al cliente a
 * explicar de nuevo qué estaba viendo.
 */
export function buildWhatsAppMessage({
  greeting = 'Hola, encontré Amado Libros y quería hacerles una consulta 😊',
  motive,
  book,
  author,
  situation,
  price,
  order,
  page,
  closing,
} = {}) {
  const lines = [String(greeting).trim(), ''];

  if (motive) lines.push(`Motivo: ${String(motive).trim()}`);
  if (book) lines.push(`Libro: ${String(book).trim()}`);
  if (author) lines.push(`Autor: ${String(author).trim()}`);
  if (situation) lines.push(`Situación: ${String(situation).trim()}`);
  if (price) lines.push(`Precio publicado: ${String(price).trim()}`);
  if (order) lines.push(`Pedido: ${String(order).trim()}`);
  if (page) lines.push(`Página: ${absoluteSitePage(page)}`);

  if (closing) lines.push('', String(closing).trim());
  return lines.join('\n');
}

export function whatsappHref(message) {
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;
}

export function buildBookWhatsAppMessage({
  title,
  author,
  page,
  available = false,
  price,
  unsupportedCurrency = false,
} = {}) {
  const situation = unsupportedCurrency
    ? 'Precio publicado en otra moneda'
    : available
      ? 'Disponible en Amado Libros'
      : 'Por encargo';
  const motive = unsupportedCurrency
    ? 'Consultar precio y forma de pago'
    : available
      ? 'Consultar disponibilidad y precio'
      : 'Consultar disponibilidad y precio';
  const closing = unsupportedCurrency
    ? 'Quisiera confirmar el precio en pesos uruguayos y la forma de pago. Gracias.'
    : available
      ? 'Quisiera confirmar si está disponible y cómo sería la entrega. Gracias.'
      : 'Quisiera saber si pueden conseguirlo y cuánto demoraría. Gracias.';

  return buildWhatsAppMessage({
    greeting: 'Hola, me interesa este libro que encontré en Amado Libros 😊',
    motive,
    book: title,
    author,
    situation,
    price,
    page,
    closing,
  });
}
