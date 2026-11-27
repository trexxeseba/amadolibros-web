/*
 * Código de consulta en los mensajes de WhatsApp (plan diciembre, 26/11/2026).
 *
 * Al tocar cualquier botón de WhatsApp del sitio, agrega al final del mensaje
 * precargado una línea "Código: AL-XXXX" y avisa a /api/wa-ref qué página y qué
 * clic de anuncio (gclid/gbraid/wbraid) trajeron a esa persona. Gaby copia el
 * código en Airtable (campo "Código web") y así una venta por WhatsApp se puede
 * atribuir a la campaña que la trajo. No guarda nombre, teléfono ni email.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'amado_click_id';
  var MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
  var ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var CLICK_KEYS = ['gclid', 'gbraid', 'wbraid'];

  function storage() {
    try { return window.localStorage; } catch (_e) { return null; }
  }

  function rememberClickId() {
    try {
      var params = new URLSearchParams(window.location.search);
      for (var i = 0; i < CLICK_KEYS.length; i += 1) {
        var value = params.get(CLICK_KEYS[i]);
        if (value && /^[A-Za-z0-9_\-]{8,200}$/.test(value)) {
          var s = storage();
          if (s) s.setItem(STORAGE_KEY, JSON.stringify({
            type: CLICK_KEYS[i],
            value: value,
            ts: Date.now(),
            source: (params.get('utm_source') || '').slice(0, 40),
            campaign: (params.get('utm_campaign') || '').slice(0, 80),
          }));
          return;
        }
      }
    } catch (_e) { /* sin almacenamiento: el código igual se agrega */ }
  }

  function storedClickId() {
    var s = storage();
    if (!s) return null;
    try {
      var data = JSON.parse(s.getItem(STORAGE_KEY) || 'null');
      if (!data || Date.now() - Number(data.ts) > MAX_AGE_MS) return null;
      return data;
    } catch (_e) { return null; }
  }

  function newCode() {
    var out = 'AL-';
    var bytes = new Uint8Array(4);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
    else for (var j = 0; j < 4; j += 1) bytes[j] = Math.floor(Math.random() * 256);
    for (var i = 0; i < 4; i += 1) out += ALPHABET.charAt(bytes[i] % ALPHABET.length);
    return out;
  }

  function isWhatsApp(url) {
    var host = url.hostname.toLowerCase();
    return host === 'wa.me' || host === 'api.whatsapp.com' || host === 'web.whatsapp.com';
  }

  function withCode(href, code) {
    var url = new URL(href, window.location.href);
    if (!isWhatsApp(url)) return null;
    var text = (url.searchParams.get('text') || '').replace(/\n*C[oó]digo: AL-[A-Z0-9]{4}\s*$/, '');
    url.searchParams.set('text', (text ? text + '\n\n' : '') + 'Código: ' + code);
    return url.toString();
  }

  function productId(anchor) {
    var raw = (anchor.getAttribute('data-mlu') || '').toUpperCase();
    if (/^MLU\d{1,20}$/.test(raw)) return raw;
    var m = window.location.pathname.match(/\/libro\/(MLU\d{1,20})\b/i);
    return m ? m[1].toUpperCase() : '';
  }

  function report(code, anchor) {
    var click = storedClickId();
    var payload = JSON.stringify({
      ref: code,
      page: window.location.pathname.slice(0, 300),
      product_id: productId(anchor),
      click_id: click ? click.value : '',
      click_id_type: click ? click.type : '',
      utm_source: click ? click.source : '',
      utm_campaign: click ? click.campaign : '',
    });
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/wa-ref', new Blob([payload], { type: 'application/json' }));
        return;
      }
    } catch (_e) { /* cae al fetch */ }
    try {
      fetch('/api/wa-ref', { method: 'POST', body: payload, headers: { 'content-type': 'application/json' }, keepalive: true, credentials: 'omit' });
    } catch (_e) { /* el código ya quedó en el mensaje */ }
  }

  function onClick(event) {
    var anchor = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (!anchor) return;
    var code = newCode();
    var next;
    try { next = withCode(anchor.href, code); } catch (_e) { next = null; }
    if (!next) return;
    anchor.href = next;
    report(code, anchor);
  }

  rememberClickId();
  document.addEventListener('click', onClick, true);
  window.AmadoWaRef = { withCode: withCode, newCode: newCode };
})();
