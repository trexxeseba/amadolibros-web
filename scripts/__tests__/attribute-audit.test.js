import test from 'node:test';
import assert from 'node:assert/strict';
import { attributeHasValue, auditItem, buildAudit, parseArgs, renderCsv, renderMarkdown } from '../mercadolibre/attribute-audit.mjs';

const attr = (id, value_name, extra = {}) => ({ id, value_name, ...extra });

test('distingue valores presentes de ausencia y de N/A', () => {
    assert.equal(attributeHasValue(attr('AUTHOR', 'Borges')), true);
    assert.equal(attributeHasValue(attr('AUTHOR', null)), false);
    assert.equal(attributeHasValue(attr('AUTHOR', null, { value_id: '-1' })), false);
    assert.equal(attributeHasValue(attr('PAGES_NUMBER', null, { value_struct: { number: 120 } })), true);
});

test('N/A queda separado de faltantes, porcentajes y propuestas de prioridad', () => {
    const items = [
        { id: 'MLU1', status: 'active', category_id: 'MLU1196', attributes: [attr('PUBLICATION_YEAR', null, { value_id: '-1' })] },
        { id: 'MLU2', status: 'active', category_id: 'MLU1196', attributes: [attr('PUBLICATION_YEAR', '2019')] },
        { id: 'MLU3', status: 'active', category_id: 'MLU1196', attributes: [] },
    ];
    const audit = buildAudit({ items, mode: 'raw' });
    assert.equal(auditItem(items[0], 'raw').year, 'no_aplica');
    assert.ok(!audit.rows.find(row => row.id === 'MLU1').missing.includes('year'));
    const year = audit.coverage.find(c => c.key === 'year');
    assert.deepEqual({ ok: year.ok, falta: year.falta, na: year.no_aplica, pct: year.pct_ok }, { ok: 1, falta: 1, na: 1, pct: 50 });
    assert.match(renderMarkdown(audit, 'test'), /No aplica/);
});

test('N/A en values o en aliases no se convierte en faltante', () => {
    const item = { id: 'MLU1', category_id: 'MLU1196', attributes: [
        attr('PUBLICATION_YEAR', null, { values: [{ id: '-1', name: null }] }),
        attr('BOOK_PUBLISHER', null, { value_id: '-1' }), attr('PUBLISHER', 'Otra'),
        attr('LANGUAGE', null, { values: [{ id: '1', name: 'Español' }] }),
    ] };
    assert.equal(auditItem(item, 'raw').year, 'no_aplica');
    assert.equal(auditItem(item, 'raw').publisher, 'no_aplica');
    assert.equal(auditItem(item, 'raw').language, 'ok');
    assert.equal(auditItem({ ...item, attributes: null }, 'raw').year, 'no_medible');
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
