from pathlib import Path

p = Path('worker-sync/meli-catalog.js')
s = p.read_text()
old = "'id,title,price,status,available_quantity,thumbnail,pictures,permalink,start_time,attributes,condition';"
new = "'id,title,price,status,available_quantity,thumbnail,pictures,permalink,start_time,attributes,condition,catalog_listing,catalog_product_id';"
if s.count(old) != 1:
    raise SystemExit('ML_ATTRIBUTES marker mismatch')
s = s.replace(old, new)
old = "    condition:          raw.condition    || null,\n    thumbnail:          raw.thumbnail    || null,"
new = "    condition:          raw.condition    || null,\n    catalog_listing:    raw.catalog_listing === true,\n    catalog_product_id: raw.catalog_product_id || null,\n    thumbnail:          raw.thumbnail    || null,"
if s.count(old) != 1:
    raise SystemExit('slimItem marker mismatch')
p.write_text(s.replace(old, new))

p = Path('worker-sync/index.js')
s = p.read_text()
marker = 'export function summarizeCatalog(catalog) {'
helper = '''export function summarizeCatalogIdentity(items = []) {
  const active = items.filter(item => item?.status === 'active' && Number(item.available_quantity) > 0);
  const catalogListings = active.filter(item => item.catalog_listing === true);
  const traditionalLinked = active.filter(item => item.catalog_listing !== true && item.catalog_product_id);
  const groups = new Map();
  for (const item of active) {
    if (!item.catalog_product_id) continue;
    const id = String(item.catalog_product_id);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(item);
  }
  const repeatedGroups = [...groups.values()].filter(group => group.length > 1);
  const mixedGroups = repeatedGroups.filter(group =>
    group.some(item => item.catalog_listing === true) &&
    group.some(item => item.catalog_listing !== true)
  );
  const mixedAlignedGroups = mixedGroups.filter(group => {
    const conditions = new Set(group.map(item => String(item.condition || '')));
    const isbns = new Set(group.map(item => String(item.isbn || '').replace(/\\D/g, '')).filter(Boolean));
    return conditions.size <= 1 && isbns.size <= 1;
  });
  return {
    active_items: active.length,
    catalog_listings: catalogListings.length,
    traditional_with_catalog_product_id: traditionalLinked.length,
    catalog_product_groups: groups.size,
    repeated_catalog_product_groups: repeatedGroups.length,
    mixed_traditional_catalog_groups: mixedGroups.length,
    mixed_aligned_condition_isbn_groups: mixedAlignedGroups.length,
    items_in_mixed_groups: mixedGroups.reduce((sum, group) => sum + group.length, 0),
  };
}

'''
if s.count(marker) != 1:
    raise SystemExit('summarize marker mismatch')
s = s.replace(marker, helper + marker)
old = "    mebibytes: Math.round((bytes / 1024 / 1024) * 100) / 100,\n  };"
new = "    mebibytes: Math.round((bytes / 1024 / 1024) * 100) / 100,\n    catalog_identity: summarizeCatalogIdentity(items),\n  };"
if s.count(old) != 1:
    raise SystemExit('summary return marker mismatch')
p.write_text(s.replace(old, new))

p = Path('worker-sync/__tests__/meli-catalog.test.js')
s = p.read_text()
if 'summarizeCatalogIdentity,' not in s:
    s = s.replace('  summarizeCatalog,\n', '  summarizeCatalog,\n  summarizeCatalogIdentity,\n')
append = r'''

// ── ML-CATALOG-IDENTITY-1 ───────────────────────────────────────────────────
test('slimItem conserva catalog_listing y catalog_product_id de Mercado Libre', () => {
  const catalogItem = slimItem({
    id: 'MLU100', title: 'Catálogo', status: 'active', available_quantity: 1,
    catalog_listing: true, catalog_product_id: 'MLU12345', attributes: [], pictures: [],
  });
  const traditional = slimItem({
    id: 'MLU101', title: 'Tradicional', status: 'active', available_quantity: 1,
    catalog_listing: false, catalog_product_id: 'MLU12345', attributes: [], pictures: [],
  });
  assert.equal(catalogItem.catalog_listing, true);
  assert.equal(catalogItem.catalog_product_id, 'MLU12345');
  assert.equal(traditional.catalog_listing, false);
  assert.equal(traditional.catalog_product_id, 'MLU12345');
});

test('resume grupos mixtos tradicional/catalogo sin consolidar automáticamente', () => {
  const summary = summarizeCatalogIdentity([
    { id:'MLU1', status:'active', available_quantity:1, catalog_listing:false, catalog_product_id:'P1', condition:'new', isbn:'9789500000001' },
    { id:'MLU2', status:'active', available_quantity:1, catalog_listing:true,  catalog_product_id:'P1', condition:'new', isbn:'9789500000001' },
    { id:'MLU3', status:'active', available_quantity:1, catalog_listing:true,  catalog_product_id:'P2', condition:'new', isbn:'9789500000002' },
    { id:'MLU4', status:'active', available_quantity:1, catalog_listing:false, catalog_product_id:'P2', condition:'used', isbn:'9789500000002' },
  ]);
  assert.equal(summary.catalog_listings, 2);
  assert.equal(summary.traditional_with_catalog_product_id, 2);
  assert.equal(summary.repeated_catalog_product_groups, 2);
  assert.equal(summary.mixed_traditional_catalog_groups, 2);
  assert.equal(summary.mixed_aligned_condition_isbn_groups, 1);
  assert.equal(summary.items_in_mixed_groups, 4);
});
'''
if 'ML-CATALOG-IDENTITY-1' not in s:
    s += append
p.write_text(s)
