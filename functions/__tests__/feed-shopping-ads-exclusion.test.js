import test from 'node:test';
import assert from 'node:assert/strict';
import { renderFeedItem, shoppingAdsExcluded, SHOPPING_ADS_MIN_PRICE, SHOPPING_ADS_MIN_PRICE_LOW_TICKET } from '../feed.xml.js';

const cats = { items: { MLU1: ['infantil-juvenil'], MLU2: ['literatura-ficcion'], MLU3: [['juegos-actividades', 'x']] }, categories: [] };
const book = (id, price) => ({ id, title: `Libro ${id}`, price, currency_id: 'UYU', available_quantity: 1, status: 'active', condition: 'new' });

test('Shopping pago: fuera lo de menos de $1.500 en cualquier tema', () => {
  assert.equal(SHOPPING_ADS_MIN_PRICE, 1500);
  assert.equal(shoppingAdsExcluded(book('MLU2', 1499), cats), true);
  assert.equal(shoppingAdsExcluded(book('MLU2', 1500), cats), false);
});

test('Shopping pago: infantil, juegos y otros productos necesitan $2.500 o más', () => {
  assert.equal(SHOPPING_ADS_MIN_PRICE_LOW_TICKET, 2500);
  assert.equal(shoppingAdsExcluded(book('MLU1', 2000), cats), true);
  assert.equal(shoppingAdsExcluded(book('MLU3', 2490), cats), true);
  assert.equal(shoppingAdsExcluded(book('MLU1', 12000), cats), false, 'packs caros siguen');
  assert.equal(shoppingAdsExcluded(book('MLU2', 2000), cats), false);
});

test('Shopping pago: el feed marca excluded_destination y no saca el producto', () => {
  const out = renderFeedItem(book('MLU1', 900), null, cats);
  assert.match(out, /<g:excluded_destination>Shopping_ads<\/g:excluded_destination>/);
  assert.match(out, /<g:id>MLU1<\/g:id>/);
  assert.doesNotMatch(renderFeedItem(book('MLU2', 3000), null, cats), /excluded_destination/);
});
