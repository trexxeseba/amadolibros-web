(function () {
  'use strict';

  var MEASUREMENT_ID = 'G-SDX45VEPP3';
  var PRODUCTION_HOSTS = new Set(['amadolibros.com', 'www.amadolibros.com']);

  if (!PRODUCTION_HOSTS.has(window.location.hostname)) return;

  function measuredPageLocation() {
    var allowedParameters = new Set([
      'utm_id',
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'gclid',
      'dclid',
      'gbraid',
      'wbraid',
    ]);
    var url = new URL(window.location.href);
    Array.from(url.searchParams.keys()).forEach(function (key) {
      if (!allowedParameters.has(key)) url.searchParams.delete(key);
    });
    url.hash = '';
    return url.toString();
  }

  function ensureGoogleTag() {
    window.dataLayer = window.dataLayer || [];
    window.gtag = window.gtag || function () {
      window.dataLayer.push(arguments);
    };

    var selector = 'script[src*="googletagmanager.com/gtag/js?id=' + MEASUREMENT_ID + '"]';
    if (document.querySelector(selector)) return;

    window.gtag('js', new Date());
    window.gtag('config', MEASUREMENT_ID, {
      page_location: measuredPageLocation(),
    });

    var tag = document.createElement('script');
    tag.async = true;
    tag.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(MEASUREMENT_ID);
    document.head.appendChild(tag);
  }

  function safeToken(value, fallback) {
    var normalized = String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 60);
    return normalized || fallback;
  }

  function pageContext() {
    var path = window.location.pathname;
    var productMatch = path.match(/^\/libro\/(MLU\d+)(?:\/|$)/i);
    var specialtyMatch = path.match(/^\/especialidades\/([^/]+)(?:\/|$)/i);
    var pageType = 'content';

    if (path === '/') pageType = 'home';
    else if (productMatch) pageType = 'product';
    else if (/^\/libros\//.test(path)) pageType = 'category';
    else if (specialtyMatch) pageType = 'specialty';
    else if (path === '/catalogo') pageType = 'catalog';
    else if (path === '/carrito') pageType = 'cart';
    else if (path === '/pedir-libro') pageType = 'book_request';
    else if (path === '/contacto') pageType = 'contact';

    return {
      pageType: pageType,
      productId: productMatch ? productMatch[1].toUpperCase() : '',
      topic: specialtyMatch ? safeToken(specialtyMatch[1], '') : '',
    };
  }

  function ctaLocation(element) {
    var explicit = element && element.closest('[data-cta-location]');
    if (explicit) return safeToken(explicit.getAttribute('data-cta-location'), 'content');
    if (element && element.closest('.wa-float')) return 'floating';
    if (element && element.closest('header')) return 'header';
    if (element && element.closest('footer')) return 'footer';
    if (element && element.closest('.closing')) return 'closing';
    if (element && element.closest('.btn-wa,.cta-primary,.wa-link')) return 'primary';
    return 'content';
  }

  function isWhatsAppUrl(href) {
    try {
      var url = new URL(href, window.location.href);
      return url.protocol === 'whatsapp:' || [
        'wa.me',
        'api.whatsapp.com',
        'web.whatsapp.com',
      ].includes(url.hostname.toLowerCase());
    } catch (_error) {
      return false;
    }
  }

  function trackWhatsApp(options) {
    options = options || {};
    var context = pageContext();
    var params = {
      page_type: context.pageType,
      cta_location: safeToken(options.ctaLocation, 'content'),
    };

    var topic = safeToken(options.topic || context.topic, '');
    if (topic) params.topic = topic;
    if (context.productId) params.product_id = context.productId;

    window.gtag('event', 'whatsapp_click', params);
  }

  ensureGoogleTag();

  window.AmadoAnalytics = Object.assign({}, window.AmadoAnalytics, {
    trackWhatsApp: trackWhatsApp,
  });

  document.addEventListener('click', function (event) {
    var anchor = event.target && event.target.closest
      ? event.target.closest('a[href]')
      : null;
    if (!anchor || !isWhatsAppUrl(anchor.href)) return;
    trackWhatsApp({ ctaLocation: ctaLocation(anchor) });
  }, true);
})();
