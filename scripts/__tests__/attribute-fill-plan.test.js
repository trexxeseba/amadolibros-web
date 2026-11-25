import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFillPlan, isbnsToLookup, renderDiscrepanciesCsv, renderPlanCsv } from '../mercadolibre/attribute-fill-plan.mjs';

const ISBN = '9780306406157';
const registry = [{ isbn: ISBN, facts: { publisher: 'Planeta', pages: 200, bibliographic: { publication_year: '2019', language: 'Español' } } }];
const base = { id: 'MLU1', status: 'active', category_id: 'MLU1196', title: 'A', isbn: ISBN, available_quantity: 1, catalog_listing: false, user_product_id: null, variations: [], author: 'X', bibliographic: { language: 'Español' } };

test('modo espejo: carga firme sólo de lo medible y deja editorial y páginas a confirmar', () => {
    const plan = buildFillPlan({ items: [base], registry });
    assert.deepEqual(plan.rows[0].firm, [{ mluId: 'PUBLICATION_YEAR', value: '2019', sources: ['registro'] }]);
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
    assert.deepEqual(plan.rows[0].firm, [{ mluId: 'PAGES_NUMBER', value: '200', sources: ['registro'] }]);
});

const rawItem = (extra = {}) => ({ ...base, isbn: undefined, attributes: [{ id: 'GTIN', value_name: ISBN }, { id: 'LANGUAGE', value_name: 'Español' }, { id: 'BOOK_PUBLISHER', value_name: 'Planeta' }], ...extra });
const facts = extra => ({ year: null, pages: null, cover: null, language: null, publisher: null, edition: null, genre: null, ...extra });

test('las vinculadas a User Products van a un grupo aparte con su propuesta, no a la carga directa', () => {
    const items = [
        rawItem({ id: 'MLU20', user_product_id: 'MLUU20' }),
        rawItem({ id: 'MLU21', user_product_id: 'MLUU21' }),
        { ...rawItem({ id: 'MLU22', user_product_id: 'MLUU21' }), catalog_listing: true },
    ];
    const plan = buildFillPlan({ items, mode: 'raw', registry });
    assert.equal(plan.rows.length, 0);
    assert.equal(plan.pilot.length, 0);
    assert.equal(plan.with_firm_proposal, 0);
    assert.equal(plan.excluded.user_product, 2);
    assert.equal(plan.user_product.with_firm_proposal, 2);
    assert.equal(plan.user_product.firm_by_attribute.PUBLICATION_YEAR, 2);
    assert.equal(plan.user_product.alone_in_user_product, 1);
    const [first, second] = plan.user_product.rows;
    assert.equal(first.group, 'requiere_carga_por_user_product');
    assert.equal(first.user_product_id, 'MLUU20');
    assert.equal(first.user_product_listings, 1);
    assert.equal(second.user_product_listings, 2);
    assert.match(renderPlanCsv(plan.user_product.rows), /requiere_carga_por_user_product,MLU20,.*MLUU20,1,PUBLICATION_YEAR=2019/);
});

test('el registro encuentra el ISBN aunque llegue como ISBN-10 o como GTIN de 14 dígitos', () => {
    for (const gtin of ['0-306-40615-2', '09780306406157', '978-0-306-40615-7']) {
        const item = { ...rawItem(), attributes: [{ id: 'GTIN', value_name: null, values: [{ name: gtin }] }] };
        const plan = buildFillPlan({ items: [item], mode: 'raw', registry });
        assert.equal(plan.rows[0].isbn, ISBN, gtin);
    }
});

test('suma las fuentes públicas: propone lo que el registro no trae y anota quién lo dice', () => {
    const external = new Map([[ISBN, { openlibrary: facts({ year: '2019', cover: 'Blanda', edition: '2a ed.' }), googlebooks: facts({ year: '2019', pages: '200' }) }]]);
    const plan = buildFillPlan({ items: [rawItem()], mode: 'raw', registry, external });
    assert.deepEqual(plan.rows[0].firm, [
        { mluId: 'PUBLICATION_YEAR', value: '2019', sources: ['registro', 'openlibrary', 'googlebooks'] },
        { mluId: 'PAGES_NUMBER', value: '200', sources: ['registro', 'googlebooks'] },
        { mluId: 'BOOK_EDITION', value: '2a ed.', sources: ['openlibrary'] },
        { mluId: 'BOOK_COVER', value: 'Blanda', sources: ['openlibrary'] },
    ]);
    assert.equal(plan.discrepancies, 0);
});

test('una publicación sin registro igual recibe propuesta de las fuentes públicas', () => {
    const other = '9780140449136';
    const external = new Map([[other, { openlibrary: facts({ pages: '320' }), googlebooks: null }]]);
    const item = { ...rawItem(), attributes: [{ id: 'GTIN', value_name: other }] };
    const plan = buildFillPlan({ items: [item], mode: 'raw', registry, external });
    assert.deepEqual(plan.rows[0].firm, [{ mluId: 'PAGES_NUMBER', value: '320', sources: ['openlibrary'] }]);
});

test('si dos fuentes discrepan el campo queda sin propuesta y la discrepancia se anota', () => {
    const external = new Map([[ISBN, { openlibrary: facts({ year: '2018', pages: '200' }), googlebooks: null }]]);
    const plan = buildFillPlan({ items: [rawItem()], mode: 'raw', registry, external });
    assert.deepEqual(plan.rows[0].firm, [{ mluId: 'PAGES_NUMBER', value: '200', sources: ['registro', 'openlibrary'] }]);
    assert.deepEqual(plan.rows[0].discrepancies, [{ mluId: 'PUBLICATION_YEAR', values: [{ source: 'registro', value: '2019' }, { source: 'openlibrary', value: '2018' }] }]);
    assert.equal(plan.discrepancies, 1);
    assert.equal(plan.firm_by_attribute.PUBLICATION_YEAR, 0);
    assert.match(renderDiscrepanciesCsv(plan.rows), /MLU1,9780306406157,A,PUBLICATION_YEAR,registro=2019 \/ openlibrary=2018/);
});

test('una discrepancia sobre un atributo que la publicación ya tiene no se informa ni se propone', () => {
    const external = new Map([[ISBN, { openlibrary: facts({ publisher: 'Otra Casa' }), googlebooks: null }]]);
    const plan = buildFillPlan({ items: [rawItem()], mode: 'raw', registry, external });
    assert.equal(plan.discrepancies, 0);
    assert.ok(!plan.rows[0].firm.some(x => x.mluId === 'BOOK_PUBLISHER'));
});

test('elige los ISBN a consultar por prioridad, sin repetir, con tope y sin Catálogo', () => {
    const other = '9780140449136';
    const items = [
        rawItem({ id: 'MLU30', sold_quantity: 0 }),
        rawItem({ id: 'MLU31', sold_quantity: 0 }),
        { ...rawItem({ id: 'MLU32', sold_quantity: 9, user_product_id: 'MLUU32' }), attributes: [{ id: 'GTIN', value_name: other }] },
        { ...rawItem({ id: 'MLU33', sold_quantity: 50 }), catalog_listing: true, attributes: [{ id: 'GTIN', value_name: '9781861972712' }] },
    ];
    assert.deepEqual(isbnsToLookup({ items, mode: 'raw' }), [other, ISBN]);
    assert.deepEqual(isbnsToLookup({ items, mode: 'raw', limit: 1 }), [other]);
});

test('el piloto respeta el tamaño pedido y el CSV lista id y valores', () => {
    const items = ['MLU10', 'MLU11', 'MLU12'].map(id => ({ ...base, id }));
    const plan = buildFillPlan({ items, registry, pilot: 2 });
    assert.equal(plan.pilot.length, 2);
    assert.match(renderPlanCsv(plan.rows), /PUBLICATION_YEAR=2019/);
});

test('no reemplaza N/A aunque exista un dato bibliográfico disponible', () => {
    const raw = { ...base, attributes: [
        { id: 'PUBLICATION_YEAR', value_id: '-1', value_name: null },
        { id: 'LANGUAGE', values: [{ id: '-1', name: null }] },
        { id: 'BOOK_PUBLISHER', value_name: 'Planeta' },
        { id: 'PAGES_NUMBER', value_name: '200' },
    ] };
    const plan = buildFillPlan({ items: [raw], mode: 'raw', registry });
    assert.equal(plan.rows.length, 0);
    assert.equal(plan.pilot.length, 0);
});

test('excluye User Products directos y de variaciones, aun fuera de Catálogo', () => {
    for (const mode of ['raw', 'mirror']) {
        const items = [
            { ...base, id: 'MLU2', attributes: [], user_product_id: 'MLUU2' },
            { ...base, id: 'MLU3', attributes: [], variations: [{ id: 1, user_product_id: 'MLUU3' }] },
        ];
        const plan = buildFillPlan({ items, mode, registry });
        assert.equal(plan.rows.length, 0);
        assert.equal(plan.pilot.length, 0);
        assert.equal(plan.excluded.user_product, 2);
    }
});

test('un espejo antiguo o vinculación incompleta quedan excluidos, no asumidos como seguros', () => {
    const { user_product_id, ...oldMirror } = base;
    const items = [oldMirror, { ...base, variations: undefined }, { ...base, variations: [{ id: 1 }] }, { ...base, variations: null }, { ...base, user_product_id: undefined }];
    const plan = buildFillPlan({ items, registry });
    assert.equal(plan.rows.length, 0);
    assert.equal(plan.excluded.user_product_unknown, 5);
});
