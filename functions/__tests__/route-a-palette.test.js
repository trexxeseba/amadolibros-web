import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const baseLayout = readFileSync(
  path.join(ROOT, 'astro-front', 'src', 'layouts', 'BaseLayout.astro'),
  'utf8',
);

test('HOME-ARTE-6: BaseLayout expone exactamente la paleta aprobada de Ruta A', () => {
  assert.match(baseLayout, /--paper:\s*#FAF6EF/);
  assert.match(baseLayout, /--surface:\s*#FFFFFF/);
  assert.match(baseLayout, /--ink:\s*#1F1B18/);
  assert.match(baseLayout, /--ink-2:\s*#5A524B/);
  assert.match(baseLayout, /--border:\s*#E4DCCF/);
  assert.match(baseLayout, /--action:\s*#B4442A/);
  assert.match(baseLayout, /--error:\s*#A3231A/);
  assert.match(baseLayout, /--header-bg:\s*#1F1B18/);
  assert.match(baseLayout, /--wa:\s*#25D366/);
});

test('HOME-ARTE-6: los aliases existentes no inventan tonos fuera del sistema', () => {
  assert.match(baseLayout, /--bg:\s*var\(--paper\)/);
  assert.match(baseLayout, /--salmon:\s*var\(--action\)/);
  assert.match(baseLayout, /--salmon-hover:\s*var\(--action\)/);
  assert.match(baseLayout, /--wa-hover:\s*var\(--wa\)/);
});

test('HOME-ARTE-6: los colores anteriores salen de la fuente global de tokens', () => {
  for (const legacy of ['#f8f5ef', '#18120e', '#6b6157', '#e2dbd0', '#e49982', '#c86f5e', '#1db954']) {
    assert.equal(baseLayout.toLowerCase().includes(legacy), false, `color legado presente: ${legacy}`);
  }
});
