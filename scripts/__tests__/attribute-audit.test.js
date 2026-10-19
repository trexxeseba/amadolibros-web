import test from 'node:test';
import assert from 'node:assert/strict';
import { attributeHasValue, auditItem, buildAudit, parseArgs, renderCsv } from '../mercadolibre/attribute-audit.mjs';

const attr = (id, value_name, extra = {}) => ({ id, value_name, ...extra });

test('un atributo sin valor, con value_name null o value_id -1 cuenta como faltante', () => {
    assert.equal(attributeHasValue(attr('AUTHOR', 'Borges')), true);
    assert.equal(attributeHasValue(attr('AUTHOR', null)), false);
    assert.equal(attributeHasValue(attr('AUTHOR', null, { value_id: '-1' })), false);
    assert.equal(attributeHasValue(attr('PAGES_NUMBER', null, { value_struct: { number: 120 } })), true);
});

test('modo crudo mide editorial y páginas con los ids reales de la categoría', () => {
    const item = { id: 'MLU1', status: 'active', category_id: 'MLU1196', attributes: [attr('BOOK_PUBLISHER', 'Planeta'), attr('PAGES_NUMBER', null), attr('AUTHOR', 'X')] };
    const status = auditItem(item, 'raw');
    assert.equal(status.publisher, 'ok');
    assert.equal(status.pages, 'falta');
    assert.equal(status.author, 'ok');
});

test('modo espejo no cuenta como faltante lo que no puede medir', () => {
    const item = { id: 'MLU1', status: 'active', category_id: 'MLU1196', author: 'X', isbn: '9780306406157', bibliographic: { language: 'Español' } };
    const status = auditItem(item, 'mirror');
    assert.equal(status.publisher, 'no_medible');
    assert.equal(status.pages, 'no_medible');
    assert.equal(status.year, 'falta');
});

test('fuera de la categoría de libros nada es medible', () => {
    const status = auditItem({ id: 'MLU2', category_id: 'MLU1174' }, 'mirror');
    assert.ok(Object.values(status).every(value => value === 'no_medible'));
});

test('la prioridad sube con visitas y ventas y el CSV sólo lista los que tienen faltantes', () => {
    const items = [
        { id: 'MLU10', status: 'active', category_id: 'MLU1196', title: 'A', available_quantity: 1, bibliographic: {} },
        { id: 'MLU11', status: 'active', category_id: 'MLU1196', title: 'B', available_quantity: 1, bibliographic: {} },
        { id: 'MLU12', status: 'paused', category_id: 'MLU1196', title: 'C' },
    ];
    const audit = buildAudit({ items, mode: 'mirror', priority: { MLU11: { visits: 100, sold: 3 } } });
    assert.equal(audit.total, 2);
    assert.equal(audit.rows[0].id, 'MLU11');
    assert.equal(renderCsv(audit).trim().split('\n').length, 3);
});

test('parseArgs rechaza flags desconocidos y valores ausentes', () => {
    assert.throws(() => parseArgs(['--borrar']));
    assert.throws(() => parseArgs(['--raw']));
    assert.equal(parseArgs(['--raw', 'a.json']).raw, 'a.json');
});
