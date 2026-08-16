import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bookCoverUrl,
  cloudflareImageUrl,
  responsiveImage,
} from '../_shared/cloudflare-images.js';

const SOURCE = 'https://www.amadolibros.com/book-cover/MLU123456/cover.jpg';

test('construye una portada primaria controlada y rechaza IDs ajenos', () => {
  assert.equal(bookCoverUrl('mlu123456'), SOURCE);
  assert.equal(
    bookCoverUrl('MLU123456', 1),
    'https://www.amadolibros.com/book-cover/MLU123456/cover-2.jpg',
  );
  assert.equal(
    bookCoverUrl('MLU123456', 5),
    'https://www.amadolibros.com/book-cover/MLU123456/cover-6.jpg',
  );
  assert.equal(bookCoverUrl('USD123'), '');
  assert.equal(bookCoverUrl('../MLU123'), '');
});

test('genera una transformación segura en la zona productiva', () => {
  assert.equal(
    cloudflareImageUrl(SOURCE, { width: 480, quality: 85 }),
    'https://www.amadolibros.com/cdn-cgi/image/format=auto,fit=scale-down,width=480,quality=85,onerror=redirect/book-cover/MLU123456/cover.jpg',
  );
});

test('no transforma hosts externos, previews ni una URL ya transformada', () => {
  const external = 'https://http2.mlstatic.com/D_TEST-O.jpg';
  const preview = 'https://preview.example/preview-cover/MLU1/0/hash.jpg';
  const transformed = cloudflareImageUrl(SOURCE, { width: 480 });
  assert.equal(cloudflareImageUrl(external, { width: 480 }), external);
  assert.equal(cloudflareImageUrl(preview, { width: 480 }), preview);
  assert.equal(cloudflareImageUrl(transformed, { width: 240 }), transformed);
});

test('srcset ofrece anchos únicos y deja que el navegador elija uno', () => {
  const image = responsiveImage(SOURCE, {
    widths: [480, 240, 480, 360],
    defaultWidth: 360,
    sizes: '(max-width: 600px) 50vw, 280px',
  });
  assert.match(image.src, /width=360/);
  assert.deepEqual(
    [...image.srcset.matchAll(/width=(\d+)/g)].map(match => Number(match[1])),
    [240, 360, 480],
  );
  assert.equal(image.sizes, '(max-width: 600px) 50vw, 280px');
});
