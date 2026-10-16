import test from 'node:test';
import assert from 'node:assert/strict';
import { bulkAttributes, bulkItemsPath, unprefixedBulkAttributes } from '../meli-bulk.js';
import { ML_ATTRIBUTES, ML_ITEM_FIELDS } from '../meli-catalog.js';
import { ITEM_FIELDS } from '../publication-stock-sync.js';

test('bulkAttributes prefija body. a cada campo y no lo duplica', () => {
  assert.equal(bulkAttributes('id,title'), 'body.id,body.title');
  assert.equal(bulkAttributes(['id', ' title ', '']), 'body.id,body.title');
  assert.equal(bulkAttributes('body.id,title'), 'body.id,body.title');
  assert.equal(bulkAttributes(''), '');
});

test('bulkItemsPath arma /items/bulk con attributes prefijados y sin attributes cuando no hay campos', () => {
  assert.equal(bulkItemsPath(['MLU1', 'MLU2'], 'id,status'), '/items/bulk?ids=MLU1,MLU2&attributes=body.id,body.status');
  assert.equal(bulkItemsPath(['MLU1']), '/items/bulk?ids=MLU1');
});

test('unprefixedBulkAttributes detecta campos sin body.', () => {
  assert.deepEqual(unprefixedBulkAttributes('body.id,title,body.status,price'), ['title', 'price']);
  assert.deepEqual(unprefixedBulkAttributes('body.id'), []);
});

test('los attributes del catálogo y del stock sync llevan body. en todos los campos', () => {
  assert.deepEqual(unprefixedBulkAttributes(ML_ATTRIBUTES), [], 'meli-catalog.js envía attributes sin body.');
  assert.equal(ML_ATTRIBUTES, bulkAttributes(ML_ITEM_FIELDS));
  assert.deepEqual(unprefixedBulkAttributes(bulkAttributes(ITEM_FIELDS)), []);
  // Los campos base siguen siendo los que necesita slim_item y el stock sync.
  assert.ok(ML_ITEM_FIELDS.split(',').includes('seller_custom_field'));
  assert.ok(ITEM_FIELDS.split(',').includes('available_quantity'));
});
