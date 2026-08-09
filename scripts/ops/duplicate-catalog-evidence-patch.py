from pathlib import Path

p = Path('scripts/seo/duplicate-review.mjs')
s = p.read_text()
marker = 'export function classifyStrictDuplicateItems(items) {'
helper = '''function catalogIdentityEvidence(items) {
  const productIds = items.map((item) => item.catalog_product_id ? String(item.catalog_product_id) : null);
  const listingFlags = items.map((item) => item.catalog_listing === true ? true : item.catalog_listing === false ? false : null);
  const distinctProductIds = [...new Set(productIds.filter(Boolean))].sort();
  const completeProductIds = productIds.every(Boolean);
  const completeListingFlags = listingFlags.every((value) => value !== null);
  const hasCatalog = listingFlags.includes(true);
  const hasTraditional = listingFlags.includes(false);
  return {
    productIds,
    listingFlags,
    distinctProductIds,
    completeProductIds,
    completeListingFlags,
    sameCatalogProduct: completeProductIds && distinctProductIds.length === 1,
    mixedTraditionalCatalog: completeListingFlags && hasCatalog && hasTraditional,
  };
}

'''
if 'function catalogIdentityEvidence' not in s:
    if s.count(marker) != 1:
        raise SystemExit('classify marker mismatch')
    s = s.replace(marker, helper + marker)
old = "  const dimensions = dimensionEvidence(items);\n"
new = "  const dimensions = dimensionEvidence(items);\n  const catalogIdentity = catalogIdentityEvidence(items);\n"
if 'const catalogIdentity = catalogIdentityEvidence(items);' not in s:
    if s.count(old) != 1:
        raise SystemExit('dimension marker mismatch')
    s = s.replace(old, new)
old2 = "      dimensions,\n    },\n"
new2 = "      dimensions,\n      catalogIdentity,\n    },\n"
if '      catalogIdentity,' not in s:
    if s.count(old2) != 1:
        raise SystemExit('evidence marker mismatch')
    s = s.replace(old2, new2)
old3 = "      dimensions: source.dimensions && typeof source.dimensions === 'object'\n        ? source.dimensions\n        : null,\n"
new3 = "      dimensions: source.dimensions && typeof source.dimensions === 'object'\n        ? source.dimensions\n        : null,\n      catalog_listing: typeof source.catalog_listing === 'boolean' ? source.catalog_listing : null,\n      catalog_product_id: source.catalog_product_id || null,\n"
if '      catalog_listing:' not in s:
    if s.count(old3) != 1:
        raise SystemExit('enrich marker mismatch')
    s = s.replace(old3, new3)
p.write_text(s)

p = Path('scripts/seo/__tests__/duplicate-review.test.mjs')
s = p.read_text()
marker = "test('catalog_product_id aporta evidencia sin cambiar la decisión por sí solo'"
if marker not in s:
    s += r'''

test('catalog_product_id aporta evidencia sin cambiar la decisión por sí solo', () => {
  const result = classifyStrictDuplicateItems([
    item({ id: 'MLU1', catalog_listing: false, catalog_product_id: 'MLU-P1' }),
    item({ id: 'MLU2', catalog_listing: true, catalog_product_id: 'MLU-P1' }),
  ]);
  assert.equal(result.decision, 'green_candidate');
  assert.equal(result.evidence.catalogIdentity.sameCatalogProduct, true);
  assert.equal(result.evidence.catalogIdentity.mixedTraditionalCatalog, true);
});

test('señal de catálogo ausente queda como evidencia incompleta, no como inferencia', () => {
  const result = classifyStrictDuplicateItems([
    item({ id: 'MLU1' }),
    item({ id: 'MLU2' }),
  ]);
  assert.equal(result.evidence.catalogIdentity.completeProductIds, false);
  assert.equal(result.evidence.catalogIdentity.mixedTraditionalCatalog, false);
});
'''
p.write_text(s)
