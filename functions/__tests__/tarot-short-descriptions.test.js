import test from 'node:test';
import assert from 'node:assert/strict';

import { buildFeedDescription } from '../feed.xml.js';
import { getTarotShortDescription } from '../_shared/tarot-short-descriptions.js';

const CODES = ['9788883953538', '8420707089085', '8420707089016', '8420707417208', '8420707305710', '8420707415907', '9782813226426', '9782813227744'];

test('cubre los 8 mazos y respeta el copy de cara al cliente', () => {
  for (const code of CODES) {
    const text = getTarotShortDescription(code);
    assert.ok(text, code);
    assert.ok(text.length > 120, code);
    assert.doesNotMatch(text, /únicamente|sólo|\bsolo\b|[\u{1F300}-\u{1FAFF}]/iu, code);
  }
});

test('el feed usa la descripción breve cuando el catálogo no trae una propia', () => {
  const d = buildFeedDescription({ title: 'Gothic Tarot', isbn: '8420707415907', condition: 'new' });
  assert.match(d, /Anne Stokes/);
  assert.doesNotMatch(d, /Libro "/);
});

test('no pisa una descripción real del catálogo', () => {
  const d = buildFeedDescription({ title: 'X', isbn: '8420707415907', description: 'Texto propio largo del vendedor.' });
  assert.match(d, /Texto propio/);
});
