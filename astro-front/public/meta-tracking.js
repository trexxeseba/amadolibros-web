/*
 * meta-tracking.js — Pixel de Meta + espejo server-side (API de conversiones).
 *
 * - No hace nada si /api/tracking/config dice que está apagado
 *   (META_TRACKING_ENABLED, apagado por defecto en producción).
 * - Nada se carga ni se envía sin el «Aceptar» del banner de cookies. El
 *   consentimiento se vuelve a mirar en CADA envío. La elección se puede
 *   cambiar desde «Cookies» en el pie: al retirarla, el Pixel recibe
 *   consent revoke y el servidor marca como revocados los pedidos de este
 *   navegador, para que su compra no salga hacia Meta.
 * - Las URL que se mandan a la API de conversiones llevan sólo parámetros de
 *   campaña (utm_*, fbclid, gclid). El Pixel, por su cuenta, toma la URL de la
 *   página: por eso las páginas no ponen datos personales en la URL.
 * - Clic en WhatsApp → Contact.
 * - Cada evento sale dos veces con el MISMO event_id: fbq() en el navegador y
 *   POST /api/tracking/meta hacia la API de conversiones. Meta deduplica.
 * - Purchase sólo sale del navegador como Pixel; la versión server-side la
 *   manda el servidor desde el pago confirmado, con event_id purchase_<código>.
 *
 * Las páginas encolan eventos sin esperar a este script:
 *   (window.AmadoMetaQueue = window.AmadoMetaQueue || []).push(['AddToCart', {...}]);
 */
(function () {
  'use strict';

  var CONSENT_KEY = 'amado_marketing_consent';
  var CONFIG_KEY = 'amado_meta_config_v1';
  var PURCHASE_KEY_PREFIX = 'amado_meta_purchase_';
  var ORDERS_KEY = 'amado_meta_orders';
  var EVENTS = { PageView: 1, ViewContent: 1, AddToCart: 1, InitiateCheckout: 1, Purchase: 1, Contact: 1 };
  var NO_ITEMS = { PageView: 1, Contact: 1 };
  var ALLOWED_URL_PARAMS = {
    utm_source: 1, utm_medium: 1, utm_campaign: 1, utm_term: 1, utm_content: 1, utm_id: 1, fbclid: 1, gclid: 1,
  };

  var pending = [];
  var config = null;
  var pixelReady = false;

  function storageGet(storage, key) {
    try { return storage.getItem(key); } catch (_e) { return null; }
  }
  function storageSet(storage, key, value) {
    try { storage.setItem(key, value); } catch (_e) {}
  }

  function consent() {
    var value = storageGet(window.localStorage, CONSENT_KEY);
    return value === 'granted' || value === 'denied' ? value : '';
  }

  function cookie(name) {
    var match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return match ? decodeURIComponent(match[1]) : '';
  }

  // _fbc: si todavía no hay cookie pero se llegó desde un anuncio (fbclid),
  // se arma con el formato que documenta Meta.
  function fbc() {
    var value = cookie('_fbc');
    if (value) return value;
    try {
      var fbclid = new URL(window.location.href).searchParams.get('fbclid');
      if (fbclid && /^[A-Za-z0-9_-]{1,400}$/.test(fbclid)) return 'fb.1.' + Date.now() + '.' + fbclid;
    } catch (_e) {}
    return '';
  }

  function randomId(prefix) {
    var bytes = new Uint8Array(8);
    try {
      window.crypto.getRandomValues(bytes);
    } catch (_e) {
      for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    return prefix + '_' + Array.prototype.map.call(bytes, function (b) {
      return ('0' + b.toString(16)).slice(-2);
    }).join('');
  }

  function cleanUrl(raw) {
    try {
      var url = new URL(raw);
      Array.from(url.searchParams.keys()).forEach(function (key) {
        if (!ALLOWED_URL_PARAMS[key]) url.searchParams.delete(key);
      });
      url.hash = '';
      return url.toString();
    } catch (_e) {
      return '';
    }
  }

  function rememberOrder(code) {
    var list = [];
    try { list = JSON.parse(storageGet(window.localStorage, ORDERS_KEY) || '[]'); } catch (_e) {}
    if (!Array.isArray(list)) list = [];
    if (list.indexOf(code) === -1) list.push(code);
    storageSet(window.localStorage, ORDERS_KEY, JSON.stringify(list.slice(-10)));
  }

  function rememberedOrders() {
    try {
      var list = JSON.parse(storageGet(window.localStorage, ORDERS_KEY) || '[]');
      return Array.isArray(list) ? list : [];
    } catch (_e) {
      return [];
    }
  }

  function slug(name) {
    return name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
  }

  // Mismo criterio que el servidor (meta-capi.js#buildCustomData).
  function customData(data) {
    var contents = (Array.isArray(data.items) ? data.items : []).map(function (raw) {
      var id = String((raw && (raw.id || raw.item_id || raw.product_id)) || '').trim().toUpperCase();
      if (!/^MLU\d{6,15}$/.test(id)) return null;
      var item = { id: id, quantity: Math.max(1, Math.min(99, Math.floor(Number(raw.quantity) || 1))) };
      var price = Number(raw.price || raw.item_price || raw.unit_price_uyu);
      if (isFinite(price) && price > 0) item.item_price = Math.round(price * 100) / 100;
      return item;
    }).filter(Boolean);
    if (!contents.length) return null;
    var value = Number(data.value);
    if (!(isFinite(value) && value >= 0)) {
      value = contents.reduce(function (sum, item) { return sum + (item.item_price || 0) * item.quantity; }, 0);
    }
    return {
      currency: 'UYU',
      value: Math.round(value * 100) / 100,
      content_ids: contents.map(function (item) { return item.id; }),
      content_type: 'product',
      contents: contents,
      num_items: contents.reduce(function (sum, item) { return sum + item.quantity; }, 0),
    };
  }

  function loadPixel(pixelId) {
    if (pixelReady) return;
    /* eslint-disable */
    !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
    n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
    n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
    t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,
    document,'script','https://connect.facebook.net/en_US/fbevents.js');
    /* eslint-enable */
    // Sin «configuración automática»: el Pixel no rastrea botones ni formularios
    // por su cuenta; sólo manda los eventos que esta página le pide.
    window.fbq('set', 'autoConfig', false, pixelId);
    window.fbq('init', pixelId);
    pixelReady = true;
  }

  function post(body) {
    try {
      fetch('/api/tracking/meta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true,
        credentials: 'same-origin',
      }).catch(function () {});
    } catch (_e) {}
  }

  function sendServer(name, eventId, data, custom) {
    var body = {
      consent: 'granted',
      event_name: name,
      event_id: eventId,
      event_source_url: cleanUrl(window.location.href),
      fbp: cookie('_fbp'),
      fbc: fbc(),
    };
    if (custom) {
      body.items = custom.contents.map(function (c) { return { id: c.id, quantity: c.quantity, price: c.item_price }; });
      body.value = custom.value;
    }
    if (data.publicCode) {
      body.public_code = String(data.publicCode);
      rememberOrder(body.public_code);
    }
    post(body);
  }

  function emit(name, data) {
    data = data || {};
    if (!EVENTS[name]) return false;
    // El consentimiento se mira en cada envío, no sólo al cargar.
    if (!config || !config.enabled || !pixelReady || consent() !== 'granted') return false;
    var custom = name === 'PageView' ? null : customData(data);
    if (!custom && !NO_ITEMS[name]) return false;

    var eventId;
    if (name === 'Purchase') {
      var code = String(data.publicCode || '').trim();
      if (!code) return false;
      eventId = 'purchase_' + code;
      // Recargar /pedido no vuelve a contar la compra.
      if (storageGet(window.localStorage, PURCHASE_KEY_PREFIX + code) === '1') return false;
      if (custom) custom.order_id = code;
    } else {
      eventId = String(data.eventId || '') || randomId(slug(name));
    }

    window.fbq('track', name, custom || {}, { eventID: eventId });
    if (name === 'Purchase') {
      storageSet(window.localStorage, PURCHASE_KEY_PREFIX + data.publicCode, '1');
    } else {
      sendServer(name, eventId, data, custom);
    }
    return true;
  }

  function flush() {
    var queued = pending;
    pending = [];
    queued.forEach(function (entry) { emit(entry[0], entry[1]); });
  }

  function track(name, data) {
    if (config && config.enabled && pixelReady && consent() === 'granted') return emit(name, data);
    if (consent() !== 'denied' && !(config && !config.enabled)) pending.push([name, data]);
    return false;
  }

  var revoked = false;
  function start() {
    var firstLoad = !pixelReady;
    loadPixel(config.pixel_id);
    if (revoked) { window.fbq('consent', 'grant'); revoked = false; }
    if (firstLoad) emit('PageView', {});
    flush();
  }

  function hideBanner() {
    var el = document.getElementById('amado-consent');
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function choose(value) {
    var previous = consent();
    storageSet(window.localStorage, CONSENT_KEY, value);
    hideBanner();
    if (value === 'granted') {
      if (config && config.enabled) start();
      return;
    }
    pending = [];
    if (previous === 'granted') {
      if (pixelReady) { window.fbq('consent', 'revoke'); revoked = true; }
      var codes = rememberedOrders();
      if (codes.length) post({ consent: 'denied', revoke_codes: codes });
      storageSet(window.localStorage, ORDERS_KEY, '[]');
    }
  }

  function addPreferencesLink() {
    if (document.querySelector && document.querySelector('[data-cookie-preferences]')) return;
    var list = document.querySelector ? document.querySelector('.site-footer .footer-list') : null;
    if (!list) return;
    var li = document.createElement('li');
    var link = document.createElement('a');
    link.href = '#';
    link.setAttribute('data-cookie-preferences', '');
    link.textContent = 'Cookies';
    li.appendChild(link);
    list.appendChild(li);
  }

  function isWhatsAppUrl(href) {
    try {
      var url = new URL(href, window.location.href);
      return url.protocol === 'whatsapp:' ||
        ['wa.me', 'api.whatsapp.com', 'web.whatsapp.com'].indexOf(url.hostname.toLowerCase()) !== -1;
    } catch (_e) {
      return false;
    }
  }

  function onClick(event) {
    var target = event.target;
    var prefs = target && target.closest ? target.closest('[data-cookie-preferences]') : null;
    if (prefs) {
      if (event.preventDefault) event.preventDefault();
      showBanner();
      return;
    }
    var anchor = target && target.closest ? target.closest('a[href]') : null;
    if (!anchor || !isWhatsAppUrl(anchor.href)) return;
    var product = (window.location.pathname || '').match(/^\/libro\/(MLU\d+)(?:\/|$)/i);
    track('Contact', product ? { items: [{ id: product[1], quantity: 1 }] } : {});
  }

  function showBanner() {
    if (document.getElementById('amado-consent')) return;
    var box = document.createElement('div');
    box.id = 'amado-consent';
    box.setAttribute('role', 'region');
    box.setAttribute('aria-label', 'Cookies');
    box.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:2147483000;' +
      'max-width:560px;margin:0 auto;background:#fff;color:#222;border:1px solid #ddd;border-radius:12px;' +
      'box-shadow:0 6px 24px rgba(0,0,0,.15);padding:14px 16px;font:14px/1.45 Inter,system-ui,sans-serif;';
    box.innerHTML =
      '<p style="margin:0 0 10px">Usamos cookies de Meta para medir qué anuncios funcionan. ' +
      'No las activamos sin tu permiso. <a href="/privacidad/" style="color:inherit">Más información</a>.</p>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end">' +
      '<button type="button" data-consent="denied" style="padding:8px 14px;border:1px solid #bbb;border-radius:8px;background:#fff;cursor:pointer">Rechazar</button>' +
      '<button type="button" data-consent="granted" style="padding:8px 14px;border:0;border-radius:8px;background:#1f3d2b;color:#fff;cursor:pointer">Aceptar</button>' +
      '</div>';
    box.addEventListener('click', function (event) {
      var button = event.target && event.target.closest ? event.target.closest('[data-consent]') : null;
      if (button) choose(button.getAttribute('data-consent'));
    });
    document.body.appendChild(box);
  }

  function applyConfig(value) {
    config = value && value.enabled && /^\d{5,20}$/.test(String(value.pixel_id || '')) ? value : { enabled: false };
    if (!config.enabled) { pending = []; return; }
    document.addEventListener('click', onClick, true);
    if (document.body) addPreferencesLink();
    else document.addEventListener('DOMContentLoaded', addPreferencesLink, { once: true });
    var current = consent();
    if (current === 'granted') start();
    else if (current === 'denied') pending = [];
    else if (document.body) showBanner();
    else document.addEventListener('DOMContentLoaded', showBanner, { once: true });
  }

  function loadConfig() {
    var cached = storageGet(window.sessionStorage, CONFIG_KEY);
    if (cached) {
      try { applyConfig(JSON.parse(cached)); return; } catch (_e) {}
    }
    fetch('/api/tracking/config', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : { enabled: false }; })
      .then(function (value) {
        storageSet(window.sessionStorage, CONFIG_KEY, JSON.stringify(value));
        applyConfig(value);
      })
      .catch(function () { applyConfig({ enabled: false }); });
  }

  // Lo que las páginas encolaron antes de que cargara este script.
  var early = Array.isArray(window.AmadoMetaQueue) ? window.AmadoMetaQueue : [];
  window.AmadoMetaQueue = { push: function (entry) { if (entry) track(entry[0], entry[1]); } };
  window.AmadoMeta = { track: track, consent: consent, choose: choose };
  early.forEach(function (entry) { track(entry[0], entry[1]); });

  loadConfig();
})();
