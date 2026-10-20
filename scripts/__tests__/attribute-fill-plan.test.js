import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFillPlan, renderPlanCsv } from '../mercadolibre/attribute-fill-plan.mjs';

const ISBN = '9780306406157';
const registry = [{ isbn: ISBN, facts: { publisher: 'Planeta', pages: 200, bibliographic: { publication_year: '2019', language: 'Español' } } }];
const base = { id: 'MLU1', status: 'active', category_id: 'MLU1196', title: 'A', isbn: ISBN, available_quantity: 1, catalog_listing: false, author: 'X', bibliographic: { language: 'Español' } };

test('modo espejo: carga firme sólo de lo medible y deja editorial y páginas a confirmar', () => {
    const plan = buildFillPlan({ items: [base], registry });
    assert.deepEqual(plan.rows[0].firm, [{ mluId: 'PUBLICATION_YEAR', value: '2019' }]);
    assert.deepEqual(plan.rows[0].toConfirm.map(x => x.mluId), ['BOOK_PUBLISHER', 'PAGES_NUMBER']);
});

test('nunca propone carga en Catálogo, fuera de libros ni sin dato verificado', () => {
    const items = [
        { ...base, id: 'MLU2', catalog_listing: true },
        { ...base, id: 'MLU3', category_id: 'MLU1174' },
        { ...base, id: 'MLU4', isbn: '9780140449136' },
    ];
    assert.equal(buildFillPlan({ items, registry }).rows.length, 0);
});

test('modo crudo mide editorial y páginas y respeta lo que ya tiene el atributo', () => {
    const raw = { ...base, attributes: [{ id: 'GTIN', value_name: ISBN }, { id: 'BOOK_PUBLISHER', value_name: 'Otra' }, { id: 'PAGES_NUMBER', value_name: null }, { id: 'PUBLICATION_YEAR', value_name: '2001' }, { id: 'LANGUAGE', value_name: 'Español' }] };
    const plan = buildFillPlan({ items: [raw], mode: 'raw', registry });
    assert.deepEqual(plan.rows[0].firm, [{ mluId: 'PAGES_NUMBER', value: '200' }]);
});

test('el piloto respeta el tamaño pedido y el CSV lista id y valores', () => {
    const items = ['MLU10', 'MLU11', 'MLU12'].map(id => ({ ...base, id }));
    const plan = buildFillPlan({ items, registry, pilot: 2 });
    assert.equal(plan.pilot.length, 2);
    assert.match(renderPlanCsv(plan.rows), /PUBLICATION_YEAR=2019/);
});
