(function () {
  'use strict';

  var CART_KEY = 'amado-cart';
  var TIME_ZONE = 'America/Montevideo';

  function valueOf(id) {
    var element = document.getElementById(id);
    return element && typeof element.value === 'string' ? element.value.trim() : '';
  }

  function focusField(id) {
    var element = document.getElementById(id);
    if (element && typeof element.focus === 'function') element.focus();
  }

  function checkoutError() {
    if (!valueOf('buyer-name')) return { message: 'Por favor ingresá tu nombre.', field: 'buyer-name' };
    if (!valueOf('buyer-phone')) return { message: 'Por favor ingresá tu teléfono o WhatsApp.', field: 'buyer-phone' };

    var delivery = document.querySelector('input[name="delivery"]:checked');
    if (!delivery || delivery.value !== 'shipping') return null;

    var required = [
      ['delivery-address', 'Por favor ingresá la dirección de entrega.'],
      ['delivery-barrio', 'Por favor ingresá la localidad.'],
      ['delivery-departamento', 'Por favor seleccioná el departamento.'],
    ];
    for (var i = 0; i < required.length; i++) {
      if (!valueOf(required[i][0])) return { message: required[i][1], field: required[i][0] };
    }

    // Fecha y horario solo se exigen para Montevideo (cadete propio) — el
    // interior se coordina con la agencia de envíos, sin franja fija.
    if (valueOf('delivery-departamento') !== 'Montevideo') return null;

    var montevideoRequired = [
      ['delivery-date', 'Por favor ingresá la fecha preferida de entrega.'],
      ['delivery-from', 'Por favor ingresá la hora de inicio del horario.'],
      ['delivery-to', 'Por favor ingresá la hora de fin del horario.'],
    ];
    for (var j = 0; j < montevideoRequired.length; j++) {
      if (!valueOf(montevideoRequired[j][0])) return { message: montevideoRequired[j][1], field: montevideoRequired[j][0] };
    }
    if (valueOf('delivery-to') <= valueOf('delivery-from')) {
      return { message: 'La hora de fin debe ser posterior a la hora de inicio.', field: 'delivery-to' };
    }
    return null;
  }

  function localDateString() {
    var parts = new Intl.DateTimeFormat('en-US', {
      timeZone: TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    var values = {};
    for (var i = 0; i < parts.length; i++) values[parts[i].type] = parts[i].value;
    return values.year + '-' + values.month + '-' + values.day;
  }

  function rotateIdempotencyKey() {
    try {
      var cart = JSON.parse(localStorage.getItem(CART_KEY) || 'null');
      if (!cart || typeof cart !== 'object' || !Array.isArray(cart.items)) return;
      try {
        cart.idempotency_key = crypto.randomUUID();
      } catch (_) {
        cart.idempotency_key = Date.now().toString(36) + Math.random().toString(36).slice(2);
      }
      localStorage.setItem(CART_KEY, JSON.stringify(cart));
      document.dispatchEvent(new CustomEvent('amado:cart-updated', { detail: cart }));
    } catch (_) {}
  }

  document.addEventListener('DOMContentLoaded', function () {
    // delivery-date/from/to quedan fuera de esta lista a propósito: solo
    // aplican a Montevideo, y su required/aria-required lo controla
    // exclusivamente carrito.astro (syncMontevideoFields) según el
    // departamento elegido — forzarlos acá los pisaría siempre a true.
    var requiredIds = [
      'buyer-name', 'buyer-phone', 'delivery-address', 'delivery-barrio',
      'delivery-departamento',
    ];
    for (var i = 0; i < requiredIds.length; i++) {
      var field = document.getElementById(requiredIds[i]);
      if (field) {
        field.required = true;
        field.setAttribute('aria-required', 'true');
      }
    }
    var dateField = document.getElementById('delivery-date');
    if (dateField) dateField.min = localDateString();
  });

  document.addEventListener('click', function (event) {
    var button = event.target.closest('#btn-wa-order, #btn-prepare-order');
    if (!button) return;
    var validation = checkoutError();
    if (!validation) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    window.alert(validation.message);
    focusField(validation.field);
  }, true);

  var nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    return nativeFetch(input, init).then(function (response) {
      var url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
      if (!/\/api\/orders(?:\?|$)/.test(url)) return response;

      response.clone().json().then(function (data) {
        if (response.status === 410 && data && data.code === 'ORDER_EXPIRED') rotateIdempotencyKey();
        if (response.ok && data && data.order) {
          document.dispatchEvent(new CustomEvent('amado:order-response', { detail: data.order }));
        }
      }).catch(function () {});
      return response;
    });
  };

  document.addEventListener('amado:order-response', function (event) {
    var order = event.detail || {};
    if (!order.expires_at) return;
    var result = document.getElementById('order-result');
    if (!result) return;

    var expiry = document.getElementById('order-expiry-confirmed');
    if (!expiry) {
      expiry = document.createElement('p');
      expiry.id = 'order-expiry-confirmed';
      expiry.className = 'order-result-note';
      result.appendChild(expiry);
    }

    var parsed = new Date(order.expires_at);
    if (isNaN(parsed.getTime())) return;
    expiry.textContent = 'Orden válida durante 60 minutos, hasta ' +
      new Intl.DateTimeFormat('es-UY', {
        timeZone: TIME_ZONE,
        hour: '2-digit',
        minute: '2-digit',
      }).format(parsed) + '.';
  });
}());
