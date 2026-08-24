import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeBookLanguage } from '../_shared/book-bibliographic-normalization.js';

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
