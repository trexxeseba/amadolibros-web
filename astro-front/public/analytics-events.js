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

  var ECOMMERCE_EVENTS = new Set([
    'view_item',
    'add_to_cart',
    'view_cart',
    'begin_checkout',
    'purchase',
  ]);

  function positiveNumber(value) {
    var number = Number(value);
    return isFinite(number) && number > 0
      ? Math.round(number * 100) / 100
      : null;
  }

  function commerceItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var itemId = String(raw.item_id || raw.product_id || raw.id || '').trim().slice(0, 100);
    if (!itemId) return null;
    var item = {
      item_id: itemId,
      item_name: String(raw.item_name || raw.title || 'Libro').trim().slice(0, 200) || 'Libro',
      item_brand: 'Amado Libros',
      item_category: 'Libros',
      quantity: Math.max(1, Math.floor(Number(raw.quantity) || 1)),
    };
    var price = positiveNumber(raw.price || raw.unit_price_uyu);
    if (price !== null) item.price = price;
    return item;
  }

  function storageHas(storage, key) {
    try { return storage.getItem(key) === '1'; } catch (_error) { return false; }
  }

  function storageSet(storage, key) {
    try { storage.setItem(key, '1'); } catch (_error) {}
  }

  function trackCommerce(eventName, options) {
    options = options || {};
    if (!ECOMMERCE_EVENTS.has(eventName)) return false;

    var items = (Array.isArray(options.items) ? options.items : [])
      .map(commerceItem)
      .filter(Boolean);
    if (!items.length) return false;

    var params = { currency: 'UYU', items: items };
    var value = positiveNumber(options.value);
    if (value === null) {
      value = items.reduce(function (sum, item) {
        return sum + (item.price || 0) * item.quantity;
      }, 0);
      if (value <= 0) value = null;
    }
    if (value !== null) params.value = Math.round(value * 100) / 100;

    var shipping = positiveNumber(options.shipping);
    if (shipping !== null) params.shipping = shipping;

    var paymentType = safeToken(options.paymentType, '');
    if (paymentType) params.payment_type = paymentType;

    var availabilityType = safeToken(
      options.availabilityType || (eventName === 'view_item' ? productAvailabilityType() : ''),
      '',
    );
    if (availabilityType) params.availability_type = availabilityType;

    var dedupeKey = safeToken(options.dedupeKey, '');
    if (eventName === 'purchase') {
      var transactionId = String(options.transactionId || '').trim().slice(0, 100);
      if (!transactionId) return false;
      params.transaction_id = transactionId;
      dedupeKey = 'purchase_' + safeToken(transactionId, 'order');
      if (storageHas(window.localStorage, 'amado_ga4_' + dedupeKey)) return false;
    } else if (dedupeKey && storageHas(window.sessionStorage, 'amado_ga4_' + dedupeKey)) {
      return false;
    }

    window.gtag('event', eventName, params);
    if (dedupeKey) {
      var storage = eventName === 'purchase' ? window.localStorage : window.sessionStorage;
      storageSet(storage, 'amado_ga4_' + dedupeKey);
    }
    return true;
  }

  function getMeasurementContext(timeoutMs) {
    timeoutMs = Math.max(100, Math.min(2000, Number(timeoutMs) || 1200));
    return new Promise(function (resolve) {
      if (typeof window.gtag !== 'function') {
        resolve(null);
        return;
      }
      var settled = false;
      var values = {};
      var remaining = 2;
      var timer = window.setTimeout(function () { finish(); }, timeoutMs);

      function finish() {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        var clientId = String(values.client_id || '').trim();
        var sessionId = Number(values.session_id);
        if (!/^\d{1,20}\.\d{1,20}$/.test(clientId)) {
          resolve(null);
          return;
        }
        var context = { client_id: clientId };
        if (Number.isSafeInteger(sessionId) && sessionId > 0) context.session_id = sessionId;
        resolve(context);
      }

      function receive(name, value) {
        values[name] = value;
        remaining -= 1;
        if (remaining === 0) finish();
      }

      window.gtag('get', MEASUREMENT_ID, 'client_id', function (value) {
        receive('client_id', value);
      });
      window.gtag('get', MEASUREMENT_ID, 'session_id', function (value) {
        receive('session_id', value);
      });
    });
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

  function productAvailabilityType() {
    var context = pageContext();
    if (context.pageType !== 'product') return '';
    return document.querySelector('.badge.in-stock') ? 'active' : 'by_request';
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
    var availabilityType = productAvailabilityType();
    if (availabilityType) params.availability_type = availabilityType;

    window.gtag('event', 'whatsapp_click', params);
  }

  // BLOQUEANTE PR #310 — punto 1: mide en qué etapa se traba un comprador
  // del checkout online, sin ningún dato personal. Sólo 4 parámetros
  // permitidos, cada uno validado contra una lista cerrada. error_code no
  // se "sanea" con safeToken() (que preserva dígitos literales — un
  // teléfono pegado en un texto libre sobreviviría igual) — se exige que
  // YA tenga forma de code interno (letras/números/guión bajo, empieza con
  // letra); cualquier otra cosa (texto libre del error, un email, etc.) se
  // descarta entera en vez de reenviar una versión "limpiada".
  var CHECKOUT_ERROR_STAGES = new Set(['order_create', 'preference_create', 'transfer_options']);
  var CHECKOUT_ERROR_PAYMENT_METHODS = new Set(['transfer', 'mercadopago']);
  var CHECKOUT_ERROR_DELIVERY_TYPES = new Set(['pickup', 'shipping']);
  var ERROR_CODE_SHAPE = /^[A-Za-z][A-Za-z0-9_]{0,59}$/;

  function errorCodeToken(value) {
    var str = String(value == null ? '' : value).trim();
    return ERROR_CODE_SHAPE.test(str) ? str.toUpperCase() : '';
  }

  function trackCheckoutError(options) {
    options = options || {};
    if (!CHECKOUT_ERROR_STAGES.has(options.stage)) return false;
    var params = { stage: options.stage };
    var errorCode = errorCodeToken(options.errorCode);
    if (errorCode) params.error_code = errorCode;
    if (CHECKOUT_ERROR_PAYMENT_METHODS.has(options.paymentMethod)) params.payment_method = options.paymentMethod;
    if (CHECKOUT_ERROR_DELIVERY_TYPES.has(options.deliveryType)) params.delivery_type = options.deliveryType;
    window.gtag('event', 'checkout_error', params);
    return true;
  }

  function trackStockWaitlistCreated() {
    var context = pageContext();
    if (context.pageType !== 'product' || !context.productId) return false;
    window.gtag('event', 'stock_waitlist_created', {
      page_type: 'product',
      product_id: context.productId,
      availability_type: 'by_request',
    });
    return true;
  }

  function attachWaitlistSuccessTracking() {
    if (typeof document.getElementById !== 'function' || typeof window.MutationObserver !== 'function') return;
    var form = document.getElementById('aviso-stock');
    var status = document.getElementById('waitlist-status');
    if (!form || !status) return;

    var emitted = false;
    var observer = new window.MutationObserver(function () {
      if (emitted || !status.classList || !status.classList.contains('is-ok')) return;
      var message = String(status.textContent || '').trim();
      if (!message || /^Ya teníamos registrado/i.test(message)) return;
      emitted = trackStockWaitlistCreated();
    });
    observer.observe(status, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
    });
  }

  ensureGoogleTag();

  window.AmadoAnalytics = Object.assign({}, window.AmadoAnalytics, {
    trackWhatsApp: trackWhatsApp,
    trackCommerce: trackCommerce,
    trackCheckoutError: trackCheckoutError,
    trackStockWaitlistCreated: trackStockWaitlistCreated,
    getMeasurementContext: getMeasurementContext,
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attachWaitlistSuccessTracking, { once: true });
  } else {
    attachWaitlistSuccessTracking();
  }

  document.addEventListener('click', function (event) {
    var anchor = event.target && event.target.closest
      ? event.target.closest('a[href]')
      : null;
    if (!anchor || !isWhatsAppUrl(anchor.href)) return;
    trackWhatsApp({ ctaLocation: ctaLocation(anchor) });
  }, true);
})();
