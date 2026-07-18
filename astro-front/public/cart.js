(function () {
  'use strict';
  if (window.AmadoCart) return;

  var STORAGE_KEY = 'amado-cart';
  var VERSION = 1;

  function uuid() {
    try { return crypto.randomUUID(); } catch (_) {
      return Date.now().toString(36) + Math.random().toString(36).slice(2);
    }
  }

  function emptyCart() {
    return { version: VERSION, items: [], idempotency_key: uuid() };
  }

  function normalizeItem(it) {
    if (!it || typeof it !== 'object') return null;
    var id = typeof it.id === 'string' ? it.id.trim() : '';
    if (!id) return null;
    var price = Number(it.price);
    if (!isFinite(price) || price <= 0) return null;
    var qty = Math.floor(Number(it.quantity));
    if (!isFinite(qty) || qty < 1) return null;
    var maxQty = Math.floor(Number(it.max_qty));
    if (!isFinite(maxQty) || maxQty < 0) maxQty = 0;
    return {
      id: id,
      title: String(it.title || '').slice(0, 200),
      price: price,
      quantity: qty,
      thumbnail: String(it.thumbnail || '').slice(0, 500),
      max_qty: maxQty,
    };
  }

  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return emptyCart();
      var c = JSON.parse(raw);
      if (!c || typeof c !== 'object' || c.version !== VERSION || !Array.isArray(c.items)) {
        return emptyCart();
      }
      var valid   = [];
      var changed = false;
      for (var i = 0; i < c.items.length; i++) {
        var n = normalizeItem(c.items[i]);
        if (n) {
          if (n.max_qty > 0 && n.quantity > n.max_qty) {
            n.quantity = n.max_qty;
            changed = true;
          }
          valid.push(n);
        }
      }
      c.items = valid;
      if (changed) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(c)); } catch (_) {}
      }
      return c;
    } catch (_) { return emptyCart(); }
  }

  function save(cart) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cart)); } catch (_) {}
    document.dispatchEvent(new CustomEvent('amado:cart-updated', { detail: cart }));
  }

  var AmadoCart = {
    get: function () { return load(); },

    add: function (item) {
      if (!item || typeof item.id !== 'string' || !item.id.trim()) return false;
      var price = Number(item.price);
      if (!isFinite(price) || price <= 0) return false;
      var incomingMax = Math.floor(Number(item.max_qty));
      if (!isFinite(incomingMax) || incomingMax < 0) incomingMax = 0;
      var cart = load();
      var found = null;
      for (var i = 0; i < cart.items.length; i++) {
        if (cart.items[i].id === item.id) { found = cart.items[i]; break; }
      }
      if (found) {
        // Refresh max_qty from catalog if provided
        if (incomingMax > 0) found.max_qty = incomingMax;
        var effectiveMax = found.max_qty || 0;
        var newQty = (found.quantity || 1) + 1;
        if (effectiveMax > 0 && newQty > effectiveMax) return false;
        found.quantity = newQty;
      } else {
        cart.items.push({
          id: String(item.id),
          title: String(item.title || '').slice(0, 200),
          price: price,
          quantity: 1,
          thumbnail: String(item.thumbnail || '').slice(0, 500),
          max_qty: incomingMax,
        });
      }
      cart.idempotency_key = uuid();
      save(cart);
      return true;
    },

    remove: function (id) {
      var cart = load();
      cart.items = cart.items.filter(function (i) { return i.id !== id; });
      cart.idempotency_key = uuid();
      save(cart);
    },

    setQty: function (id, qty) {
      qty = Math.floor(Number(qty));
      if (!isFinite(qty) || qty < 1) return;
      var cart = load();
      for (var i = 0; i < cart.items.length; i++) {
        if (cart.items[i].id === id) {
          var maxQty = cart.items[i].max_qty || 0;
          if (maxQty > 0 && qty > maxQty) qty = maxQty;
          cart.items[i].quantity = qty;
          cart.idempotency_key = uuid();
          save(cart);
          return;
        }
      }
    },

    clear: function () { save(emptyCart()); },

    count: function () {
      return load().items.reduce(function (s, i) { return s + (i.quantity || 0); }, 0);
    },

    subtotal: function () {
      return load().items.reduce(function (s, i) { return s + i.price * (i.quantity || 0); }, 0);
    },
  };

  window.AmadoCart = AmadoCart;

  // Sincronización entre pestañas
  window.addEventListener('storage', function (e) {
    if (e.key === STORAGE_KEY) {
      document.dispatchEvent(new CustomEvent('amado:cart-updated', { detail: load() }));
    }
  });

  // Delegación de clics para botones data-action="add-to-cart"
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action="add-to-cart"]');
    if (!btn) return;

    // En estado post-agregar: segundo clic navega al carrito
    if (btn.dataset.goCart) {
      window.location.href = '/carrito';
      return;
    }

    var rawPrice  = parseFloat(btn.dataset.price);
    var rawMaxQty = parseInt(btn.dataset.maxQty || '0', 10);
    var item = {
      id: btn.dataset.id || '',
      title: btn.dataset.title || '',
      price: isFinite(rawPrice) ? rawPrice : -1,
      thumbnail: btn.dataset.thumbnail || '',
      max_qty: (isFinite(rawMaxQty) && rawMaxQty >= 0) ? rawMaxQty : 0,
    };
    var added = AmadoCart.add(item);
    if (!added) return;
    var label = btn.querySelector('[data-cart-label]');
    if (!label) return;
    var orig = label.dataset.origText || label.textContent;
    label.dataset.origText = orig;
    label.textContent = 'Agregado — Ver carrito';
    btn.dataset.goCart = '1';
    var prevAriaLabel = btn.getAttribute('aria-label');
    if (prevAriaLabel !== null) {
      btn.dataset.origAriaLabel = prevAriaLabel;
      btn.setAttribute('aria-label', 'Ir al carrito');
    }
    setTimeout(function () {
      label.textContent = orig;
      delete btn.dataset.goCart;
      delete label.dataset.origText;
      if (btn.dataset.origAriaLabel !== undefined) {
        btn.setAttribute('aria-label', btn.dataset.origAriaLabel);
        delete btn.dataset.origAriaLabel;
      }
    }, 1500);
  });
}());
