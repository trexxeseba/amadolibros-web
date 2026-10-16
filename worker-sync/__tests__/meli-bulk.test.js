import test from 'node:test';
import assert from 'node:assert/strict';
import { bulkAttributes, bulkItemsPath, unprefixedBulkAttributes, bulkEntryItem } from '../meli-bulk.js';
import { ML_ATTRIBUTES, ML_ITEM_FIELDS } from '../meli-catalog.js';
import { ITEM_FIELDS } from '../publication-stock-sync.js';

test('bulkAttributes antepone status_code, prefija body. a cada campo y no lo duplica', () => {
  assert.equal(bulkAttributes('id,title'), 'status_code,body.id,body.title');
  assert.equal(bulkAttributes(['id', ' title ', '']), 'status_code,body.id,body.title');
  assert.equal(bulkAttributes('body.id,title'), 'status_code,body.id,body.title');
  assert.equal(bulkAttributes('status_code,id'), 'status_code,body.id');
  assert.equal(bulkAttributes(''), '');
});

test('bulkItemsPath arma /items/bulk con status_code y attributes prefijados, y sin attributes cuando no hay campos', () => {
  assert.equal(bulkItemsPath(['MLU1', 'MLU2'], 'id,status'), '/items/bulk?ids=MLU1,MLU2&attributes=status_code,body.id,body.status');
  assert.equal(bulkItemsPath(['MLU1']), '/items/bulk?ids=MLU1');
});

test('unprefixedBulkAttributes detecta campos del item sin body. e ignora status_code', () => {
  assert.deepEqual(unprefixedBulkAttributes('status_code,body.id,title,body.status,price'), ['title', 'price']);
  assert.deepEqual(unprefixedBulkAttributes('status_code,body.id'), []);
});

test('bulkEntryItem acepta la entrada proyectada sin status y descarta las fallidas', () => {
  // Respuesta real de /items/bulk con attributes=body.*: la entrada llega sin status_code.
  assert.equal(bulkEntryItem({ body: { id: 'MLU1', status: 'active' } }).id, 'MLU1');
  assert.equal(bulkEntryItem({ status_code: 200, body: { id: 'a' } }).id, 'a');
  assert.equal(bulkEntryItem({ code: 200, body: { id: 'b' } }).id, 'b');
  assert.equal(bulkEntryItem({ status_code: 404, body: { message: 'not found' } }), null);
  assert.equal(bulkEntryItem({ status_code: 500, body: { id: 'c' } }), null);
  assert.equal(bulkEntryItem({ body: null }), null);
  assert.equal(bulkEntryItem({ id: 'legacy' }).id, 'legacy');
  assert.equal(bulkEntryItem(null), null);
});

test('los attributes del catálogo y del stock sync llevan body. en todos los campos', () => {
  assert.deepEqual(unprefixedBulkAttributes(ML_ATTRIBUTES), [], 'meli-catalog.js envía attributes sin body.');
  assert.equal(ML_ATTRIBUTES, bulkAttributes(ML_ITEM_FIELDS));
  assert.ok(ML_ATTRIBUTES.split(',').includes('status_code'), 'el catálogo debe pedir status_code en /items/bulk');
  assert.ok(bulkAttributes(ITEM_FIELDS).split(',').includes('status_code'), 'el stock sync debe pedir status_code en /items/bulk');
  assert.deepEqual(unprefixedBulkAttributes(bulkAttributes(ITEM_FIELDS)), []);
  // Los campos base siguen siendo los que necesita slim_item y el stock sync.
  assert.ok(ML_ITEM_FIELDS.split(',').includes('seller_custom_field'));
  assert.ok(ITEM_FIELDS.split(',').includes('available_quantity'));
});
