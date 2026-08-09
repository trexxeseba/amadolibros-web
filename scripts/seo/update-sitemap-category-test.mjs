import fs from 'node:fs';

const file = 'functions/__tests__/seo-category-pages.test.js';
let source = fs.readFileSync(file, 'utf8');

source = source.replace(
  "import { onRequest as sitemapRequest } from '../sitemap.xml.js';",
  "import { onRequest as categorySitemapRequest } from '../sitemap-categories.xml.js';",
);

const oldBlock = [
  "test('el sitemap publica las ocho landings SEO', async () => {",
  '    const response = await sitemapRequest({',
  "        request: new Request('https://www.amadolibros.com/sitemap.xml'),",
  "        env: { APP_ENV: 'production' },",
  '        data: {},',
  '        waitUntil() {},',
  '    });',
  '    const xml = await response.text();',
  '',
  '    for (const category of SEO_CATEGORIES) {',
  '        assert.ok(xml.includes(`<loc>https://www.amadolibros.com/libros/${category.id}</loc>`), category.id);',
  '    }',
  '});',
].join('\n');

const newBlock = [
  "test('el sitemap de categorías publica las ocho landings SEO', async () => {",
  '    const response = await categorySitemapRequest({',
  "        request: new Request('https://www.amadolibros.com/sitemap-categories.xml'),",
  "        env: { APP_ENV: 'production' },",
  '        data: {},',
  '        waitUntil() {},',
  '    });',
  '    const xml = await response.text();',
  '',
  '    for (const category of SEO_CATEGORIES) {',
  '        assert.ok(xml.includes(`<loc>https://www.amadolibros.com/libros/${category.id}</loc>`), category.id);',
  '    }',
  '});',
].join('\n');

if (!source.includes(oldBlock)) {
  throw new Error('No se encontró el test antiguo de categorías en sitemap.xml.');
}
source = source.replace(oldBlock, newBlock);
fs.writeFileSync(file, source);
console.log('Test de categorías actualizado al sitemap segmentado.');
