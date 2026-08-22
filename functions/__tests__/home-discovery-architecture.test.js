import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function read(relativePath) {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

test('hero queda enfocado en búsqueda y no repite el panel comercial grande', () => {
  const hero = read('astro-front/src/components/Hero.astro');
  assert.match(hero, /Encontrá el libro que estás buscando/);
  assert.match(hero, /action="\/catalogo"/);
  assert.match(hero, /Contanos qué libro buscás/);
  assert.doesNotMatch(hero, /Claro, rápido y con atención personal/);
  assert.doesNotMatch(hero, /Entrega en 2 horas/);
  assert.doesNotMatch(hero, /Hasta 12 cuotas/);
  assert.doesNotMatch(hero, /12% menos/);
});

test('home ofrece categorías visuales con destinos reales y sin inventar más vendidos', () => {
  const categories = read('astro-front/src/components/CategoryAccess.astro');
  for (const label of [
    'Tarot y oráculos',
    'Psicología',
    'Nuevos',
    'Infantil',
    'Educación',
    'Literatura y ficción',
    'Desarrollo personal',
    'Espiritualidad',
  ]) {
    assert.match(categories, new RegExp(label));
  }
  assert.match(categories, /categoria=esoterismo-tarot&subcategoria=tarot-oraculos/);
  assert.match(categories, /\/libros\/psicologia/);
  assert.match(categories, /#incorporaciones-recientes/);
  assert.match(categories, /categoria=educacion/);
  assert.doesNotMatch(categories, /Más vendidos/);
});

test('jerarquía de la home prioriza búsqueda, categorías y novedades antes de beneficios', () => {
  const home = read('astro-front/src/pages/index.astro');
  const hero = home.indexOf('<Hero />');
  const categories = home.indexOf('<CategoryAccess />');
  const recent = home.indexOf('<BestsellerSection />');
  const orderHub = home.indexOf('<OrderHubAccess />');
  const delivery = home.indexOf('<DeliveryCoordination />');
  const payments = home.indexOf('<ShippingPayments />');

  assert.ok(hero >= 0);
  assert.ok(hero < categories);
  assert.ok(categories < recent);
  assert.ok(recent < orderHub);
  assert.ok(orderHub < delivery);
  assert.ok(delivery < payments);
});

test('Nuevos apunta a un ancla estable de incorporaciones recientes', () => {
  const recent = read('astro-front/src/components/BestsellerSection.astro');
  assert.match(recent, /id="incorporaciones-recientes"/);
  assert.match(recent, /Incorporaciones recientes/);
});
