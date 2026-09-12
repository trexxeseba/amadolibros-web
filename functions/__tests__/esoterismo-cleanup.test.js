import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { onRequest as categoryRequest } from '../libros/[[path]].js';
import { CATALOG_URL } from '../_shared/catalog.js';
import { normalizeCategoryPaths } from '../_shared/category-paths.js';
import { TAROT_MERCH_TAGS } from '../_shared/tarot-merch-tags.js';
import { buildTagLookup, buildTarotHubModules } from '../_shared/tarot-hub-modules.js';
import { classify } from '../../scripts/categorize/classify.js';
import { classifyItem } from '../../scripts/seo/generate-tarot-merch-tags.mjs';

const data = JSON.parse(readFileSync(new URL('../../astro-front/public/data/active-categories.json', import.meta.url)));
const corrections = JSON.parse(readFileSync(new URL('../../scripts/categorize/manual-corrections.json', import.meta.url)));
const audit = JSON.parse(readFileSync(new URL('../../docs/seo/esoterismo-curation-2026-09-12.json', import.meta.url))).records;
const ids = ['MLU661851377', 'MLU643087668', 'MLU643758459', 'MLU698362131', 'MLU646991953', 'MLU650471127', 'MLU706775946', 'MLU669972586', 'MLU477509991', 'MLU613405055'];
const items = ids.map((id, index) => ({ id, title: `Edición verificada ${index}`, status: 'active', available_quantity: 1, price: 1000, pictures: [] }));

test('las correcciones persisten al volver a clasificar los diez títulos y el duplicado del oráculo', () => {
  for (const id of [...ids, 'MLU669963610']) {
    const manual = corrections.find(row => row.mlu === id);
    assert.ok(manual, id);
    const result = classify({ id, title: 'Magia Yoga Libro Oráculo', status: 'active' }, manual);
    assert.equal(result.method, 'manual');
    const paths = [[result.primaryCategoryId, result.subcategoryId], ...result.secondaryCategoryPaths.map(p => [p.categoryId, p.subcategoryId])];
    assert.deepEqual(normalizeCategoryPaths(data.items[id]), paths, id);
  }
});

test('los contadores del menú coinciden con las rutas públicas, sin contar dos veces una categoría', () => {
  for (const category of data.categories) {
    const paths = Object.values(data.items).map(normalizeCategoryPaths);
    assert.equal(category.count, paths.filter(p => p.some(e => e[0] === category.id)).length, category.id);
    for (const sub of category.subcategories) {
      assert.equal(sub.count, paths.filter(p => p.some(e => e[0] === category.id && e[1] === sub.id)).length, sub.id);
    }
  }
});

test('las páginas muestran los títulos en su destino y ofrecen filtros para las subcategorías', async () => {
  const originalCaches = globalThis.caches;
  globalThis.caches = { default: {
    async match(request) {
      if (request.url.endsWith('/data/active-categories.json')) return Response.json(data);
      if (request.url === CATALOG_URL) return Response.json({ items });
      throw new Error(`Lectura no prevista: ${request.url}`);
    }, async put() {},
  } };
  try {
    for (const category of ['esoterismo-tarot', 'infantil-juvenil', 'religion-espiritualidad']) {
      const response = await categoryRequest({
        request: new Request(`https://preview.example/libros/${category}`),
        params: { path: [category] }, env: { APP_ENV: 'test' }, data: {}, waitUntil() {},
      });
      assert.equal(response.status, 200);
      const html = await response.text();
      for (const id of ids) {
        const expected = normalizeCategoryPaths(data.items[id]).some(p => p[0] === category) && (category !== 'esoterismo-tarot' || buildTagLookup(TAROT_MERCH_TAGS)(id)?.format === 'mazo');
        assert.equal(html.includes(`/libro/${id}/`), expected, `${category}: ${id}`);
      }
      if (category === 'esoterismo-tarot') {
        assert.ok(html.includes('/libros/esoterismo-tarot/cabala-kabbalah'));
        assert.ok(!html.includes('aria-label="Subcategorías de Esoterismo'));
      }
      if (category === 'infantil-juvenil') assert.ok(html.includes('subcategoria=educacion-menstrual'));
    }
  } finally { globalThis.caches = originalCaches; }
});

test('Cielo tiene su luna conserva el mazo y deja de aparecer como libro de estudio, también al regenerar', () => {
  const lookup = buildTagLookup(TAROT_MERCH_TAGS);
  for (const id of ['MLU643087668', 'MLU669963610']) {
    const generated = classifyItem({ id, isbn: '9789877782363', title: 'Primera Menstruación Cielo Tiene Su Luna Libro + Oráculo', status: 'active', available_quantity: 1 });
    assert.equal(generated.primary_type, 'oraculo');
    assert.equal(generated.format, 'mazo');
    assert.equal(generated.bundle, 'mazo_mas_guia');
    assert.equal(lookup(id).format, generated.format);
    const modules = buildTarotHubModules({ items: [{ id }], tagLookup: lookup });
    assert.ok(modules.find(m => m.id === 'oraculos')?.entries.some(e => e.item.id === id));
    assert.ok(!modules.some(m => m.id === 'para-profundizar'));
  }
  const unrelated = classifyItem({ id: 'MLU999', title: 'Libro sobre oráculos' });
  assert.equal(unrelated.format, 'libro');
});

test('la tanda completa conserva sus destinos al regenerar y los formatos revisados no vuelven a confundirse', () => {
  const lookup = buildTagLookup(TAROT_MERCH_TAGS);
  for (const row of audit) {
    const result = classify({ id: row.id, title: 'Alma Magia Tarot Yoga', status: 'active' }, corrections.find(c => c.mlu === row.id));
    assert.equal(result.method, 'manual', row.id);
    const paths = normalizeCategoryPaths([[result.primaryCategoryId, result.subcategoryId], ...result.secondaryCategoryPaths.map(p => [p.categoryId, p.subcategoryId])]);
    assert.deepEqual(paths, row.after, row.id);
    assert.deepEqual(normalizeCategoryPaths(data.items[row.id]), row.after, row.id);
    if (row.merch) {
      const generated = classifyItem({ id: row.id, isbn: row.isbn, title: row.title });
      assert.equal(generated.format, row.merch.format, row.id);
      assert.equal(lookup(row.id)?.format, row.merch.format, row.id);
      assert.equal(lookup(row.id)?.primary_type, row.merch.primary_type, row.id);
    }
  }
});

test('las cartas se muestran juntas y los libros conservan sus destinos', async () => {
  const sampleIds = ['MLU608201824', 'MLU643087668', 'MLU804612402', 'MLU643758459'];
  const expected = new Map([
    ['mazos', ['MLU608201824', 'MLU643087668']],
    ['libros-tarot-oraculos', ['MLU804612402']], ['libros-esoterismo', ['MLU643758459', 'MLU804612402']],
  ]);
  const originalCaches = globalThis.caches;
  globalThis.caches = { default: { async match(request) {
    if (request.url.endsWith('/data/active-categories.json')) return Response.json(data);
    if (request.url === CATALOG_URL) return Response.json({ items: sampleIds.map(id => ({ id, title: id, status: 'active', available_quantity: 1, price: 1000, pictures: [] })) });
    return null;
  }, async put() {} } };
  try {
    for (const [path, expectedId] of expected) {
      const response = await categoryRequest({ request: new Request(`https://preview.example/libros/esoterismo-tarot/${path}`), params: { path: ['esoterismo-tarot', path] }, env: { APP_ENV: 'test' }, data: {}, waitUntil() {} });
      const html = await response.text();
      assert.equal(response.status, 200, path);
      for (const id of sampleIds) assert.equal(html.includes(`/libro/${id}/`), expectedId.includes(id), `${path}: ${id}`);
      assert.match(html, /Te llega hoy/);
    }
  } finally { globalThis.caches = originalCaches; }
});
