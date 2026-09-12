import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bookLanguageLabel,
  normalizeBookLanguage,
} from '../_shared/book-bibliographic-normalization.js';

test('normaliza códigos ISO de Google, Open Library y MARC a etiquetas visibles', () => {
  assert.equal(normalizeBookLanguage('es'), 'Español');
  assert.equal(normalizeBookLanguage('/languages/spa'), 'Español');
  assert.equal(normalizeBookLanguage('spa, eng'), 'Español, Inglés');
  assert.equal(normalizeBookLanguage('fra'), 'Francés');
});

test('conserva una etiqueta explícita que no es un código conocido', () => {
  assert.equal(normalizeBookLanguage('Español rioplatense'), 'Español rioplatense');
  assert.equal(normalizeBookLanguage(''), null);
});

test('bookLanguageLabel traduce un código conocido y devuelve null para el resto', () => {
  assert.equal(bookLanguageLabel('spa'), 'Español');
  assert.equal(bookLanguageLabel('ENG'), 'Inglés');
  assert.equal(bookLanguageLabel('dut'), 'Neerlandés');
  assert.equal(bookLanguageLabel('nld'), 'Neerlandés');
  // Devolver null permite que un adaptador descarte el código en vez de
  // dejar que llegue crudo a una ficha.
  assert.equal(bookLanguageLabel('zzz'), null);
  assert.equal(bookLanguageLabel(''), null);
  assert.equal(bookLanguageLabel(null), null);
});
