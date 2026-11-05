import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

import { onRequest } from '../libros-agotados-importados-uruguay.js';
import { WHATSAPP_NUMBER } from '../../shared/whatsapp-messages.js';

const root = rel => fileURLToPath(new URL('../../' + rel, import.meta.url));
const read = rel => readFileSync(root(rel), 'utf8');
const landingUrl = 'https://www.amadolibros.com/libros-agotados-importados-uruguay';

test('landing de agotados e importados es indexable, canónica y accionable', async () => {
  const response = await onRequest();
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /text\/html/);
  assert.match(html, /<title>Libros agotados e importados en Uruguay \| Amado Libros<\/title>/);
  assert.match(html, /<meta name="robots" content="index, follow">/);
  assert.match(html, /<link rel="canonical" href="https:\/\/www\.amadolibros\.com\/libros-agotados-importados-uruguay">/);
  assert.match(html, /<h1 id="titulo">Buscamos libros<br><em>agotados<\/em> e<br>importados\.<\/h1>/);
  assert.match(html, /título, autor, ISBN o foto/i);
  assert.match(html, /Europa y otros mercados/);
  assert.match(html, /Continuar en WhatsApp/);
  assert.match(html, /"@type":"Service"/);
  assert.match(html, /Si encontramos una opción, te pasamos edición, estado, precio y plazo estimado/);
  assert.match(html, /<meta property="og:image" content="https:\/\/www\.amadolibros\.com\/images\/logo-amado\.webp">/);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
});

test('la landing de anuncios ofrece confianza, consulta rápida y respuestas sin prometer stock', async () => {
  const response = await onRequest();
  const html = await response.text();

  assert.match(html, /href="\/quienes-somos\/"[^>]*>.*Librería familiar de Montevideo/);
  assert.match(html, /href="\/envios\/"[^>]*>.*Envíos a todo Uruguay/);
  assert.match(html, /Retiro coordinado en Ciudad Vieja/);
  assert.doesNotMatch(html, /74 reseñas|aggregateRating/);
  assert.match(html, /href="\/pedir-libro\/\?tipo=agotado"/);
  assert.match(html, /href="\/catalogo"/);
  assert.match(html, /Preguntas frecuentes/);
  assert.match(html, /plazo estimado de 12 a 17 días/);
  assert.match(html, /Se abre WhatsApp con el mensaje listo/);
  const form = html.match(/<form id="encargo-quick-form"[^>]*>[\s\S]*?<\/form>/)?.[0];
  assert.ok(form);
  assert.match(form, /aria-labelledby="consulta-titulo" hidden/);
  assert.match(form, /<input id="encargo-titulo"[^>]* required/);
  assert.doesNotMatch(form, /\b(?:action|name)="/);
  assert.doesNotMatch(html, /href="https:\/\/wa\.me/);
});

test('el acceso directo a WhatsApp solo redirige al chat fijo y funciona sin JavaScript', async () => {
  const response = await onRequest({ request: new Request(`${landingUrl}?chat=whatsapp&text=privado`) });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('Location'), `https://wa.me/${WHATSAPP_NUMBER}`);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('X-Robots-Tag'), 'noindex, nofollow');
});

test('la consulta rápida entrega los campos a WhatsApp y envía solo contexto fijo a GA4', async () => {
  const html = await (await onRequest()).text();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const analytics = read('astro-front/public/analytics-events.js');
  const location = new URL(`${landingUrl}?utm_source=google&q=titulo-en-url`);
  const navigations = [];
  location.assign = url => navigations.push(new URL(url));
  const window = { location, dataLayer: [] };
  const listeners = {};
  let validity = '';
  const form = { hidden: true, addEventListener: (name, handler) => { listeners[name] = handler; } };
  const title = {
    value: '   ',
    addEventListener: (name, handler) => { listeners[name] = handler; },
    setCustomValidity: message => { validity = message; },
    reportValidity: () => !validity,
  };
  const author = { value: ' Editorial Águila + 099123456 ' };
  const elements = { 'encargo-quick-form': form, 'encargo-titulo': title, 'encargo-autor': author };
  const document = {
    referrer: 'https://www.amadolibros.com/catalogo?q=consulta-anterior',
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: id => elements[id],
    createElement: () => ({}),
    head: { appendChild: () => {} },
    addEventListener: () => {},
  };
  const context = { document, window, URL };
  runInNewContext(analytics, context);
  runInNewContext(script, context);

  assert.equal(form.hidden, false);
  const data = () => window.dataLayer.map(entry => Array.from(entry));
  const event = { preventDefault() {} };
  listeners.submit(event);
  assert.ok(validity);
  assert.equal(navigations.length, 0);
  assert.ok(!data().some(entry => entry[0] === 'event'));

  title.value = ' Edición Ñ & apéndice ';
  listeners.input();
  listeners.submit(event);
  assert.equal(validity, '');
  assert.equal(navigations[0].origin, 'https://wa.me');
  assert.equal(navigations[0].pathname, `/${WHATSAPP_NUMBER}`);
  const message = navigations[0].searchParams.get('text');
  assert.match(message, /\nLibro o tema: Edición Ñ & apéndice\nAutor o editorial: Editorial Águila \+ 099123456\n/);

  const [, , config] = data().find(entry => entry[0] === 'config');
  assert.equal(config.page_location, `${landingUrl}?utm_source=google`);
  assert.equal(config.page_referrer, 'https://www.amadolibros.com/');
  const events = data().filter(entry => entry[0] === 'event');
  assert.equal(events.length, 1);
  assert.equal(events[0][1], 'whatsapp_click');
  assert.deepEqual({ ...events[0][2] }, {
    page_type: 'content',
    cta_location: 'encargo_rapido',
    topic: 'agotado',
    origen: 'otro',
    ruta: new URL(landingUrl).pathname,
    libro_id: '',
    transport_type: 'beacon',
  });
  assert.doesNotMatch(JSON.stringify(data()), /Edición Ñ|Águila|099123456|titulo-en-url|consulta-anterior|wa\.me/);
});

test('la home V2 posiciona el diferencial comercial y enlaza la landing', () => {
  const home = read('astro-front/src/pages/index.astro');
  const hero = read('astro-front/src/components/HomeV2Hero.astro');
  const ideas = read('astro-front/src/components/HomeV2Ideas.astro');
  const footer = read('astro-front/src/components/Footer.astro');

  assert.match(home, /title="Libros difíciles de encontrar en Uruguay \| Amado Libros"/);
  assert.match(home, /libros importados en Uruguay/);
  assert.match(home, /búsqueda enfocada por encargo/);
  assert.match(home, /agotadas, descatalogadas o difíciles de conseguir/);
  assert.match(hero, /Libros difíciles de encontrar\./);
  assert.match(hero, /una persona revisa opciones y lo busca por encargo/);
  assert.match(ideas, /href="\/libros-agotados-importados-uruguay"/);
  assert.match(footer, /href="\/libros-agotados-importados-uruguay"/);
});
