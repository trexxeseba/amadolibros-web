import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  absoluteSitePage,
  buildBookWhatsAppMessage,
  buildWhatsAppMessage,
  whatsappHref,
} from '../../shared/whatsapp-messages.js';

test('la consulta por encargo usa el copy aprobado y contexto operativo', () => {
  const message = buildBookWhatsAppMessage({
    title: 'My Hero Academia 42 Edición Especial Cofre',
    author: 'Kohei Horikoshi',
    page: '/libro/MLU63131903/my-hero-academia-42-edicion-especial-cofre',
    available: false,
  });

  assert.equal(message, [
    'Hola, me interesa este libro que encontré en Amado Libros 😊',
    '',
    'Motivo: Consultar disponibilidad y precio',
    'Libro: My Hero Academia 42 Edición Especial Cofre',
    'Autor: Kohei Horikoshi',
    'Situación: Por encargo',
    'Página: https://www.amadolibros.com/libro/MLU63131903/my-hero-academia-42-edicion-especial-cofre',
    '',
    'Quisiera saber si pueden conseguirlo y cuánto demoraría. Gracias.',
  ].join('\n'));
  assert.doesNotMatch(message, /vengo desde la web|Referencia:|Código web:/i);
});

test('la consulta disponible cambia situación y cierre sin códigos internos', () => {
  const message = buildBookWhatsAppMessage({
    title: 'Libro disponible',
    author: 'Autora',
    page: '/libro/MLU1/libro-disponible',
    available: true,
  });
  assert.match(message, /Situación: Disponible en Amado Libros/);
  assert.match(message, /confirmar si está disponible y cómo sería la entrega/);
  assert.doesNotMatch(message, /Código web|Referencia:/);
});

test('la página elimina campañas pero conserva filtros útiles', () => {
  assert.equal(
    absoluteSitePage('/catalogo?q=murdoku&utm_source=google&gclid=privado'),
    'https://www.amadolibros.com/catalogo?q=murdoku',
  );
});

test('el href codifica saltos, tildes y emoji de forma segura', () => {
  const message = buildWhatsAppMessage({
    motive: 'Consulta general',
    page: '/contacto',
    closing: '¿Podrían ayudarme? Gracias.',
  });
  const href = whatsappHref(message);
  assert.match(href, /^https:\/\/wa\.me\/59899841325\?text=/);
  assert.equal(decodeURIComponent(href.split('?text=')[1]), message);
});

test('el helper del navegador mantiene el mismo formato visible', () => {
  const source = readFileSync(new URL('../../astro-front/public/whatsapp-messages.js', import.meta.url), 'utf8');
  const window = { location: { href: 'https://www.amadolibros.com/catalogo?q=murdoku&utm_source=test' } };
  vm.runInNewContext(source, { window, URL });
  const message = window.AmadoWhatsApp.build({
    motive: 'Búsqueda sin resultados',
    book: 'Murdoku',
    situation: 'No apareció en el catálogo',
    page: window.location.href,
    closing: 'Quisiera saber si pueden conseguirlo. Gracias.',
  });
  assert.match(message, /Motivo: Búsqueda sin resultados/);
  assert.match(message, /Libro: Murdoku/);
  assert.match(message, /Página: https:\/\/www\.amadolibros\.com\/catalogo\?q=murdoku/);
  assert.doesNotMatch(message, /utm_source/);
});
