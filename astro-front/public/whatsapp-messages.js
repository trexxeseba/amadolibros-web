(function () {
  'use strict';

  var NUMBER = '59899841325';
  var SITE_BASE = 'https://www.amadolibros.com';

  function absolutePage(pathOrUrl) {
    try {
      var url = new URL(pathOrUrl || window.location.href, SITE_BASE);
      url.hash = '';
      Array.from(url.searchParams.keys()).forEach(function (key) {
        if (/^(utm_|gclid$|dclid$|gbraid$|wbraid$)/i.test(key)) {
          url.searchParams.delete(key);
        }
      });
      return url.toString();
    } catch (_error) {
      return SITE_BASE + '/';
    }
  }

  function build(options) {
    options = options || {};
    var lines = [
      String(options.greeting || 'Hola, encontré Amado Libros y quería hacerles una consulta 😊').trim(),
      '',
    ];
    if (options.motive) lines.push('Motivo: ' + String(options.motive).trim());
    if (options.book) lines.push('Libro: ' + String(options.book).trim());
    if (options.author) lines.push('Autor: ' + String(options.author).trim());
    if (options.situation) lines.push('Situación: ' + String(options.situation).trim());
    if (options.price) lines.push('Precio publicado: ' + String(options.price).trim());
    if (options.order) lines.push('Pedido: ' + String(options.order).trim());
    if (options.page !== false) lines.push('Página: ' + absolutePage(options.page));
    if (options.closing) lines.push('', String(options.closing).trim());
    return lines.join('\n');
  }

  function href(message) {
    return 'https://wa.me/' + NUMBER + '?text=' + encodeURIComponent(message);
  }

  window.AmadoWhatsApp = Object.assign({}, window.AmadoWhatsApp, {
    absolutePage: absolutePage,
    build: build,
    href: href,
    number: NUMBER,
  });
})();
