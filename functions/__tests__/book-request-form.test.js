import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const page = readFileSync('astro-front/src/pages/pedir-libro.astro', 'utf8');
const script = page.match(/<script>([\s\S]*?)<\/script>/)[1];

function setup(response, networkError = false) {
  const elements = new Map();
  function element(selector) {
    if (!elements.has(selector)) elements.set(selector, {
      hidden: selector === '#request-result' || selector === '#request-another',
      value: '', options: [{ value: 'exacto' }], listeners: {}, disabled: false,
      addEventListener(event, fn) { this.listeners[event] = fn; },
      reportValidity() { return true; },
      focus() { this.focused = true; },
    });
    return elements.get(selector);
  }
  const data = { query: 'Libro solicitado', reply_contact: 'lector@example.com', format: 'Impreso', language: 'Español' };
  const calls = [];
  const events = [];
  const location = { search: '?tipo=exacto', href: 'https://www.amadolibros.com/pedir-libro/?tipo=exacto' };
  runInNewContext(script, {
    document: { querySelector: element, getElementById: id => element('#' + id) },
    window: { location, gtag(...args) { events.push(args); args[2]?.event_callback?.(); } },
    URLSearchParams, AbortController, setTimeout, clearTimeout, encodeURIComponent,
    FormData: class { get(key) { return data[key] ?? ''; } },
    fetch: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      if (networkError) throw new Error('offline');
      return { status: response.status, json: async () => response.body };
    },
  });
  return {
    element, calls, events, location,
    submit: () => element('#manual-book-request').listeners.submit({ preventDefault() {} }),
  };
}

test('la solicitud confirmada se queda en la web y mide una sola conversión sin contacto', async () => {
  const flow = setup({ status: 201, body: { received: true, notification_sent: true, request_code: 'AL-TEST1' } });
  await flow.submit();
  assert.equal(flow.calls[0].url, '/api/book-request');
  assert.equal(flow.calls[0].body.reply_contact, 'lector@example.com');
  assert.equal(flow.element('#manual-book-request').hidden, true);
  assert.equal(flow.element('#request-result').hidden, false);
  assert.equal(flow.element('#request-result').focused, true);
  assert.match(flow.element('#request-result-message').textContent, /Recibimos tu solicitud.*AL-TEST1/);
  assert.equal(flow.element('#request-another').hidden, false);
  assert.match(flow.element('#request-wa').href, /^https:\/\/wa\.me\//);
  assert.equal(flow.location.href, 'https://www.amadolibros.com/pedir-libro/?tipo=exacto');
  const conversions = flow.events.filter(e => e[1] === 'book_request_submitted');
  assert.equal(conversions.length, 1);
  assert.equal(JSON.stringify(conversions).includes('lector@example.com'), false);
  await flow.submit();
  assert.equal(flow.calls.length, 1, 'un doble envío no crea otra solicitud');
});

test('el aviso pendiente conserva el formulario, explica el estado y no cuenta conversión', async () => {
  const flow = setup({ status: 202, body: { received: true, notification_sent: false, request_code: 'AL-TEST2', error: 'Guardamos tu solicitud, pero no pudimos avisar al equipo.' } });
  await flow.submit();
  assert.equal(flow.element('#manual-book-request').hidden, false);
  assert.equal(flow.element('#request-submit').disabled, false);
  assert.match(flow.element('#request-result-message').textContent, /no pudimos avisar.*AL-TEST2/);
  assert.equal(flow.events.filter(e => e[1] === 'book_request_submitted').length, 0);
});

test('una falla de red no confirma ni cambia de página y deja reintentar', async () => {
  const flow = setup({}, true);
  await flow.submit();
  assert.equal(flow.element('#manual-book-request').hidden, false);
  assert.equal(flow.element('#request-submit').disabled, false);
  assert.match(flow.element('#request-result-message').textContent, /No pudimos confirmar/);
  assert.equal(flow.events.filter(e => e[1] === 'book_request_submitted').length, 0);
  await flow.submit();
  assert.equal(flow.calls.length, 2);
});
