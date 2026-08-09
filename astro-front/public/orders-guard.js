(function () {
  'use strict';

  var CART_KEY = 'amado-cart';

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
      ['delivery-departamento', 'Por favor seleccioná el departamento.'],
    ];
    for (var i = 0; i < required.length; i++) {
      if (!valueOf(required[i][0])) return { message: required[i][1], field: required[i][0] };
    }
    return null;
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
    var requiredIds = [
      'buyer-name', 'buyer-phone', 'delivery-address', 'delivery-departamento',
    ];
    for (var i = 0; i < requiredIds.length; i++) {
      var field = document.getElementById(requiredIds[i]);
      if (field) {
        field.required = true;
        field.setAttribute('aria-required', 'true');
      }
    }
  });

  document.addEventListener('click', function (event) {
    var button = event.target.closest('#btn-wa-order, #btn-prepare-order');
    if (!button) return;
    var validation = checkoutError();
    if (!validation) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    // carrito.astro expone este hook para mostrar el error debajo del campo
    // (accesible, sin bloquear la pantalla) — si por algún motivo no está
    // disponible (script no cargado todavía, u otra página), alert() sigue
    // funcionando como respaldo.
    if (typeof window.__amadoCheckoutShowFieldError === 'function') {
      window.__amadoCheckoutShowFieldError(validation.field, validation.message);
    } else {
      window.alert(validation.message);
      focusField(validation.field);
    }
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
        timeZone: 'America/Montevideo',
        hour: '2-digit',
        minute: '2-digit',
      }).format(parsed) + '.';
  });
}());
