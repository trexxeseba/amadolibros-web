import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GOOGLE_REVIEWS,
  GOOGLE_RATING,
  pickReviews,
  googleReviewsHtml,
} from '../../shared/google-reviews.js';

test('reseñas: hay suficientes y cada una trae nombre abreviado y texto', () => {
  assert.ok(GOOGLE_REVIEWS.length >= 12);
  for (const r of GOOGLE_REVIEWS) {
    assert.ok(r.text.length > 40, r.name);
    assert.ok(/^[^\s]+( [^\s]+)? [A-Z]\.$/.test(r.name), `nombre abreviado: ${r.name}`);
    assert.ok(!/\d{7,}/.test(r.text), 'sin teléfonos en el texto');
  }
});

test('reseñas: puntaje y cantidad declarados', () => {
  assert.equal(GOOGLE_RATING.rating, '4,9');
  assert.equal(GOOGLE_RATING.count, 82);
});

test('reseñas: pickReviews es estable por semilla y respeta el límite', () => {
  const a = pickReviews(3, 'MLU1');
  const b = pickReviews(3, 'MLU1');
  assert.deepEqual(a, b);
  assert.equal(a.length, 3);
  assert.equal(pickReviews(500).length, GOOGLE_REVIEWS.length);
});

test('reseñas: el HTML escapa texto, enlaza a Google y no usa datos estructurados', () => {
  const html = googleReviewsHtml({ limit: 4, seed: 'x', columns: 1 });
  assert.ok(html.includes('maps.google.com'));
  assert.ok(html.includes('data-gr'));
  assert.ok(!/application\/ld\+json/.test(html));
  assert.ok(!/aggregateRating|"@type":\s*"Review"/i.test(html));
  assert.equal((html.match(/<li class="gr-card">/g) || []).length, 4);
});

test('reseñas: copy de cara al cliente sin palabras vetadas', () => {
  const html = googleReviewsHtml({ limit: 12 });
  assert.ok(!/únicamente|\bsólo\b/i.test(html));
});
