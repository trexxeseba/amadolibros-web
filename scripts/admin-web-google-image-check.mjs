import { inspectProductImages } from '../shared/product-image-audit.js';

export const GOOGLE_IMAGE_PATH = '/libro/MLU651526046/big-english-1-british-pupil-s-book-pearson';
export function googleImageCheckScript() {
  return `const { test, expect } = require('@playwright/test');
const inspectProductImages = ${inspectProductImages.toString()};
test('Imagen declarada para Google en la ficha reportada', async ({ request }) => {
  test.setTimeout(40000);
  const url = 'https://www.amadolibros.com${GOOGLE_IMAGE_PATH}';
  const response = await request.get(url, { timeout: 25000, maxRedirects: 0 });
  expect(response.status(), 'PRODUCT_PAGE_UNAVAILABLE').toBe(200);
  const inspection = inspectProductImages(await response.text());
  expect(inspection.issues, inspection.issues.join(',')).toEqual([]);
  expect(inspection.products.some(p => p.sku === 'MLU651526046' && p.images.length > 0), 'PRODUCT_ID_MISMATCH').toBe(true);
});`;
}
