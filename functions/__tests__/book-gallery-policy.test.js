import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanBookGallery, isBookGalleryImage } from '../_shared/book-gallery-policy.js';

test('old pickup poster and logo copies are excluded regardless of the book or delivery URL', () => {
  const poster = '8709b55080ee054b9e766ca6cb1ed232b39df7060386fbd97fdfce9fea13ffea';
  assert.equal(isBookGalleryImage(`/preview-cover/MLU628260274/8/${poster}.jpg`), false);
  assert.equal(isBookGalleryImage(`https://www.amadolibros.com/cdn-cgi/image/width=96/preview-cover/MLU999/3/${poster}.jpg`), false);
  assert.equal(isBookGalleryImage('https://http2.mlstatic.com/D_967764-MLU71031852473_082023-O.jpg'), false);
  assert.equal(isBookGalleryImage('https://http2.mlstatic.com/D_NQ_NP_967764-MLU71031852473_082023-F.jpg'), false);
});

test('different files of a verified cover collapse while the back cover stays', () => {
  const front = '/preview-cover/MLU479281259/0/d1c2426c0e9fc4ab26b67c04508f74af8d632a5e7f66906b602634bd64db9e67.jpg';
  const copy = '/preview-cover/MLU479281259/1/9459cac793861743ba1deb8b1ca1b5744dc422fc7f7ec5cef1fcf44c27fae613.jpg';
  const back = '/preview-cover/MLU479281259/2/4cf37766bb134134a4629e022e9ad9037907749680f52988b468ee3897fe1e6d.jpg';
  assert.deepEqual(cleanBookGallery([front, copy, back]), [front, back]);
  assert.deepEqual(cleanBookGallery([copy, front, back]), [copy, back]);
});

test('identical content is deduplicated across positions but unknown interiors are kept', () => {
  const hash = 'a'.repeat(64);
  const front = `/preview-cover/MLU123/0/${hash}.jpg`;
  const same = `/preview-cover/MLU123/2/${hash}.jpg`;
  const interior = '/book-cover/MLU123/cover-2.jpg';
  assert.deepEqual(cleanBookGallery([front, same, interior]), [front, interior]);
});

test('verified source aliases also collapse before a cached copy is resolved', () => {
  const front = 'https://http2.mlstatic.com/D_639753-MLM44230018318_122020-O.jpg';
  const duplicate = 'https://http2.mlstatic.com/D_NQ_NP_861723-MLU77522731597_072024-F.jpg';
  const interior = 'https://http2.mlstatic.com/D_999999-MLU99999999999_012023-O.jpg';
  assert.deepEqual(cleanBookGallery([front, duplicate, interior]), [front, interior]);
});
