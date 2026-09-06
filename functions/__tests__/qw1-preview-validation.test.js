import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('la implementación es de solo lectura: sin escritura, sin Merchant, un fetch por lado', () => {
  const source = readFileSync('scripts/seo/qw1-preview-validation.mjs', 'utf8');
  assert.doesNotMatch(source, /method\s*:\s*['"](?:POST|PATCH|PUT|DELETE)['"]/i);
  assert.doesNotMatch(source, /merchantapi\.googleapis\.com/i);
  const fetchCalls = source.match(/\bfetch\(/g) || [];
  assert.equal(fetchCalls.length, 1);
});
