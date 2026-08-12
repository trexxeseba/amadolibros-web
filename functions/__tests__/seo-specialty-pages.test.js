import test from 'node:test';
import assert from 'node:assert/strict';

import { CATALOG_URL } from '../_shared/catalog.js';
import {
  dedupeSpecialtyItems,
  isSpecialtyMatch,
  SEO_SPECIALTIES,
  specialtyPath,
} from '../_shared/seo-specialties.js';
import { onRequest } from '../especialidades/[[path]].js';
import { STATIC_SITEMAP_PAGES } from '../sitemap-pages.xml.js';

const ITEMS = [
  { id: 'MLU1', title: 'Manual de medicina clínica', author: 'Autora Médica', price: 2100, available_quantity: 1, status: 'active', thumbnail: 'https://img.example/1.jpg' },
  { id: 'MLU2', title: 'Tratado de retina y glaucoma', author: 'Autor Ocular', price: 3200, available_quantity: 1, status: 'active', thumbnail: 'https://img.example/2.jpg' },
  { id: 'MLU3', title: 'Técnicas de cirugía laparoscópica', author: 'Autor Quirúrgico', price: 4100, available_quantity: 1, status: 'active', thumbnail: 'https://img.example/3.jpg' },
  { id: 'MLU4', title: 'Agricultura: cultivos, suelos y riego', author: 'Autora Agrícola', price: 1800, available_quantity: 1, status: 'active', thumbnail: 'https://img.example/4.jpg' },
  { id: 'MLU5', title: 'Electrotecnia y máquinas eléctricas', author: 'Autor Técnico', isbn: '9780000000002', price: 2700, available_quantity: 1, status: 'active', thumbnail: 'https://img.example/5.jpg' },
  { id: 'MLU7', title: 'Máquinas eléctricas: Electrotecnia', author: 'Autor Técnico', isbn: '9780000000002', price: 2800, available_quantity: 1, status: 'active', thumbnail: 'https://img.example/7.jpg' },
  { id: 'MLU6', title: 'Cirugía agotada', price: 999, available_quantity: 0, status: 'paused' },
];

function context(id, { appEnv = 'production', query = '' } = {}) {
  return {
    request: new Request(`https://www.amadolibros.com${specialtyPath(id)}${query}`),
    params: { path: [id] },
    env: { APP_ENV: appEnv },
    data: {},
    waitUntil() {},
  };
}

test.beforeEach(() => {
  globalThis.caches = {
    default: {
      async match(request) {
        if (request.url === CATALOG_URL) return Response.json({ items: ITEMS });
        return null;
      },
      async put() {},
    },
  };
});

test('publica cinco especialidades fuertes, diferenciadas y sin páginas por país', () => {
  assert.equal(SEO_SPECIALTIES.length, 5);
  assert.equal(new Set(SEO_SPECIALTIES.map(item => item.id)).size, 5);
  assert.equal(new Set(SEO_SPECIALTIES.map(item => item.title)).size, 5);
  assert.equal(new Set(SEO_SPECIALTIES.map(item => item.h1)).size, 5);
  assert.equal(new Set(SEO_SPECIALTIES.map(item => item.description)).size, 5);
  assert.equal(new Set(SEO_SPECIALTIES.map(item => item.intro)).size, 5);
  for (const item of SEO_SPECIALTIES) {
    assert.ok(item.title.length <= 60, item.id);
    assert.ok(item.description.length >= 135, item.id);
    assert.ok(item.intro.length >= 220, item.id);
    assert.ok(item.topics.length >= 6, item.id);
    assert.ok(item.keywords.length >= 7, item.id);
  }
});

test('cada landing muestra catálogo real filtrado y SEO regional verificable', async () => {
  for (const specialty of SEO_SPECIALTIES) {
    const response = await onRequest(context(specialty.id));
    const html = await response.text();
    const expectedItem = ITEMS.find(item => isSpecialtyMatch(item, specialty) && item.status === 'active');

    assert.equal(response.status, 200, specialty.id);
    assert.ok(html.includes(`<title>${specialty.title}</title>`), specialty.id);
    assert.ok(html.includes(`<h1>${specialty.h1}</h1>`), specialty.id);
    assert.ok(html.includes(`href="https://www.amadolibros.com${specialtyPath(specialty.id)}"`), specialty.id);
    assert.match(html, /<meta name="robots" content="index, follow">/);
    assert.match(html, /"@type":"CollectionPage"/);
    assert.match(html, /"@type":"ItemList"/);
    assert.match(html, /"@type":"Service"/);
    assert.match(html, /<script src="\/analytics-events\.js"><\/script>/);
    assert.match(html, /"areaServed":\{"@type":"Country","name":"Uruguay"\}/);
    assert.match(html, /¿Consultás desde España o Latinoamérica\?/);
    assert.match(html, /eventual envío internacional se confirman caso a caso/);
    assert.doesNotMatch(html, /hreflang/);
    assert.ok(html.includes(expectedItem.title), specialty.id);
    assert.doesNotMatch(html, /Cirugía agotada/);
  }
});

test('las especialidades no repiten dos publicaciones de la misma edición', () => {
  const electrotechnics = SEO_SPECIALTIES.find(item => item.id === 'electrotecnia');
  const matches = ITEMS.filter(item => isSpecialtyMatch(item, electrotechnics));
  assert.equal(matches.length, 2);
  assert.equal(dedupeSpecialtyItems(matches).length, 1);
});

test('el filtro exige palabras completas y evita coincidencias por fragmentos', () => {
  const agriculture = SEO_SPECIALTIES.find(item => item.id === 'agricultura');
  assert.equal(isSpecialtyMatch({ title: 'Las experiencias de Tiresias y el hombre griego' }, agriculture), false);
  const medicine = SEO_SPECIALTIES.find(item => item.id === 'medicina');
  assert.equal(isSpecialtyMatch({ title: 'Dosificación de medicamentos en el caballo' }, medicine), false);
});

test('preview, parámetros y slugs no autorizados no crean URLs indexables', async () => {
  const preview = await onRequest(context('medicina', { appEnv: 'preview' }));
  assert.match(await preview.text(), /<meta name="robots" content="noindex, follow">/);

  const filtered = await onRequest(context('medicina', { query: '?utm_source=regional' }));
  assert.match(await filtered.text(), /<meta name="robots" content="noindex, follow">/);

  const unknown = await onRequest(context('tema-inventado'));
  assert.equal(unknown.status, 404);
  assert.match(await unknown.text(), /noindex, nofollow/);
});

test('sitemap y landing de encargos enlazan las cinco especialidades', async () => {
  const { onRequest: renderPillar } = await import('../libros-agotados-importados-uruguay.js');
  const pillar = await (await renderPillar()).text();
  for (const specialty of SEO_SPECIALTIES) {
    const path = specialtyPath(specialty.id);
    assert.ok(STATIC_SITEMAP_PAGES.includes(`https://www.amadolibros.com${path}`), specialty.id);
    assert.ok(pillar.includes(`href="${path}"`), specialty.id);
  }
});
