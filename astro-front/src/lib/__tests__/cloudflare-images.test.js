import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bookCoverUrl,
  cloudflareImageUrl,
  responsiveBookCover,
} from '../cloudflare-images.js';

test('la home conserva exactamente las transformaciones previas mientras queda fuera del canario', () => {
  const source = bookCoverUrl('MLU987654');
  const cover = responsiveBookCover('MLU987654');
  assert.equal(source, 'https://www.amadolibros.com/book-cover/MLU987654/cover.jpg');
  assert.equal(bookCoverUrl('MLU987654', 2), 'https://www.amadolibros.com/book-cover/MLU987654/cover-3.jpg');
  assert.equal(bookCoverUrl('MLU987654', 15), 'https://www.amadolibros.com/book-cover/MLU987654/cover-16.jpg');
  assert.equal(cover.src, 'https://www.amadolibros.com/cdn-cgi/image/format=auto,fit=scale-down,width=360,quality=85,onerror=redirect/book-cover/MLU987654/cover.jpg');
  assert.deepEqual(
    [...cover.srcset.matchAll(/width=(\d+),/g)].map(match => Number(match[1])),
    [240, 360, 480],
  );
  assert.doesNotMatch(cover.srcset, /variant=/);
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
