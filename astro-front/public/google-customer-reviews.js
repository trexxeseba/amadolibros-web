(function (global) {
  'use strict';

  var CONFIG_SELECTOR = 'meta[name="amado-gcr-config"]';
  var DRAFT_KEY = 'amado-checkout-draft-v2';
  var SCRIPT_ID = 'amado-gcr-platform';
  var SEEN_PREFIX = 'amado-gcr-optin-v1:';
  var GOOGLE_PLATFORM_SRC = 'https://apis.google.com/js/platform.js?onload=renderOptIn';
  var pendingPayload = null;

  function readConfig() {
    var node = document.querySelector(CONFIG_SELECTOR);
    return {
      enabled: !!node && node.getAttribute('data-enabled') === 'true',
      merchantId: node ? String(node.getAttribute('data-merchant-id') || '').trim() : '',
    };
  }

  function readDraft() {
    try {
      var draft = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || 'null');
      return draft && typeof draft === 'object' ? draft : null;
    } catch (_) {
      return null;
    }
  }

  function emailFromDraft(draft) {
    var value = draft && draft.values && draft.values['buyer-email'];
    return typeof value === 'string' ? value.trim() : '';
  }

  function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ''));
  }

  function formatIsoDate(date) {
    var yyyy = date.getFullYear();
    var mm = String(date.getMonth() + 1).padStart(2, '0');
    var dd = String(date.getDate()).padStart(2, '0');
    return yyyy + '-' + mm + '-' + dd;
  }

  function addBusinessDays(baseDate, businessDays) {
    var date = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate());
    var remaining = Math.max(0, Number(businessDays) || 0);
    while (remaining > 0) {
      date.setDate(date.getDate() + 1);
      var day = date.getDay();
      if (day !== 0 && day !== 6) remaining -= 1;
    }
    return date;
  }

  function estimatedDeliveryDate(draft) {
    var deliveryType = draft && draft.delivery_type;
    var department = draft && draft.values && draft.values['delivery-departamento'];
    department = String(department || '').trim().toLowerCase();

    // Conservador: la encuesta no debe llegar antes que el pedido.
    // Pickup: próximo hábil; Montevideo: +2 hábiles; resto UY: +5.
    var days = deliveryType === 'pickup' ? 1 : (department === 'montevideo' ? 2 : 5);
    return formatIsoDate(addBusinessDays(new Date(), days));
  }

  function alreadyShown(orderId) {
    try { return sessionStorage.getItem(SEEN_PREFIX + orderId) === '1'; }
    catch (_) { return false; }
  }

  function markShown(orderId) {
    try { sessionStorage.setItem(SEEN_PREFIX + orderId, '1'); }
    catch (_) {}
  }

  function renderPending() {
    if (!pendingPayload || !global.gapi || typeof global.gapi.load !== 'function') return false;
    var payload = pendingPayload;
    pendingPayload = null;

    global.gapi.load('surveyoptin', function () {
      try {
        if (!global.gapi.surveyoptin || typeof global.gapi.surveyoptin.render !== 'function') return;
        global.gapi.surveyoptin.render({
          merchant_id: Number(payload.merchantId),
          order_id: payload.orderId,
          email: payload.email,
          delivery_country: 'UY',
          estimated_delivery_date: payload.estimatedDeliveryDate,
          opt_in_style: 'CENTER_DIALOG',
        });
        markShown(payload.orderId);
      } catch (_) {}
    });
    return true;
  }

  global.renderOptIn = function () {
    renderPending();
  };

  function requestForOrder(orderId) {
    var cfg = readConfig();
    if (!cfg.enabled) return { started: false, reason: 'disabled' };
    if (!/^\d+$/.test(cfg.merchantId)) return { started: false, reason: 'merchant_id' };

    var normalizedOrderId = String(orderId || '').trim();
    if (!normalizedOrderId || normalizedOrderId === '—') return { started: false, reason: 'order_id' };
    if (alreadyShown(normalizedOrderId)) return { started: false, reason: 'already_shown' };

    var draft = readDraft();
    var email = emailFromDraft(draft);
    if (!isValidEmail(email)) return { started: false, reason: 'email' };

    pendingPayload = {
      merchantId: cfg.merchantId,
      orderId: normalizedOrderId,
      email: email,
      estimatedDeliveryDate: estimatedDeliveryDate(draft),
    };

    global.___gcfg = global.___gcfg || {};
    global.___gcfg.lang = 'es-419';

    if (global.gapi && typeof global.gapi.load === 'function') {
      renderPending();
      return { started: true, via: 'existing_gapi' };
    }

    if (document.getElementById(SCRIPT_ID)) {
      return { started: true, via: 'pending_script' };
    }

    var script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.src = GOOGLE_PLATFORM_SRC;
    script.async = true;
    script.defer = true;
    script.onerror = function () { pendingPayload = null; };
    document.head.appendChild(script);
    return { started: true, via: 'lazy_script' };
  }

  function wirePedido() {
    var heading = document.getElementById('pedido-h1');
    if (!heading) return;

    var checkApproved = function () {
      // pedido.astro sólo muestra este texto después de que /api/orders/status
      // confirma payment_status=approved. El parámetro ?result= por sí solo
      // nunca es suficiente para disparar Customer Reviews.
      if (String(heading.textContent || '').trim() !== 'Pago confirmado') return;
      var code = new URLSearchParams(global.location.search).get('code');
      requestForOrder(code);
    };

    checkApproved();
    if (typeof MutationObserver === 'function') {
      new MutationObserver(checkApproved).observe(heading, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }
  }

  function init() {
    var cfg = readConfig();
    if (!cfg.enabled) return;
    if (global.location.pathname !== '/pedido') return;
    wirePedido();
  }

  global.AmadoGoogleCustomerReviews = {
    requestForOrder: requestForOrder,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})(window);
