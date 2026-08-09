import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  STATUS_SYNC_STALE_MS,
  STATUS_SYNC_STUCK_MS,
} from '../_shared/status-policy.js';

test('A4: la política de frescura conserva 26 h y el stuck 45 min', () => {
  assert.equal(STATUS_SYNC_STALE_MS, 26 * 60 * 60 * 1000);
  assert.equal(STATUS_SYNC_STUCK_MS, 45 * 60 * 1000);
});

test('A4: /api/status importa la política compartida y no redefine umbrales locales', () => {
  const file = fileURLToPath(new URL('../api/[[route]].js', import.meta.url));
  const source = readFileSync(file, 'utf8');
  assert.match(source, /STATUS_SYNC_STALE_MS/);
  assert.match(source, /STATUS_SYNC_STUCK_MS/);
  assert.doesNotMatch(source, /const\s+STALE_MS\s*=/);
  assert.doesNotMatch(source, /const\s+STUCK_MS\s*=/);
});

test('A4: el smoke no fija un segundo umbral temporal', () => {
  const file = fileURLToPath(new URL('../../scripts/smoke-production.js', import.meta.url));
  const source = readFileSync(file, 'utf8');
  assert.match(source, /sync_fresh/);
  assert.match(source, /possibly_stuck/);
  assert.doesNotMatch(source, /26\s*\*\s*60\s*\*\s*60/);
  assert.doesNotMatch(source, /45\s*\*\s*60\s*\*\s*1000/);
});
