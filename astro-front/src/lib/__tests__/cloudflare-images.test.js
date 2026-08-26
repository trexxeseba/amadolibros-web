import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bookCoverUrl,
  cloudflareImageUrl,
  responsiveBookCover,
} from '../cloudflare-images.js';

test('la home usa el proxy propio y tres variantes Cloudflare', () => {
  const source = bookCoverUrl('MLU987654');
  const cover = responsiveBookCover('MLU987654');
  assert.equal(source, 'https://www.amadolibros.com/book-cover/MLU987654/cover.jpg');
  assert.equal(bookCoverUrl('MLU987654', 2), 'https://www.amadolibros.com/book-cover/MLU987654/cover-3.jpg');
  assert.equal(bookCoverUrl('MLU987654', 15), 'https://www.amadolibros.com/book-cover/MLU987654/cover-16.jpg');
  assert.match(cover.src, /\/cdn-cgi\/image\/.*width=360/);
  assert.deepEqual(
    [...cover.srcset.matchAll(/width=(\d+)/g)].map(match => Number(match[1])),
    [240, 360, 480],
  );
  assert.match(cover.srcset, /onerror=redirect/);
});

test('no anida transformaciones ni admite un ID que no sea MLU', () => {
  const transformed = cloudflareImageUrl(bookCoverUrl('MLU1'), 240);
  assert.equal(cloudflareImageUrl(transformed, 480), transformed);
  assert.equal(bookCoverUrl('MLA1'), '');
});

test('Preview usa la portada del mismo origen sin depender de /cdn-cgi/image', () => {
  const cover = responsiveBookCover('MLU987654', { optimize: false });
  assert.equal(cover.source, '/book-cover/MLU987654/cover.jpg');
  assert.equal(cover.src, '/book-cover/MLU987654/cover.jpg');
  assert.equal(cover.srcset, '');
  assert.equal(cover.sizes, '');
});
